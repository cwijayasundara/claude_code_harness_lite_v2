// The sdlc mod: what settings hooks cannot do.
//  - /sdlc-status and /sdlc-approve: zero-token commands; approve runs only from the person's own prompt
//  - /sdlc-waive and /sdlc-sensors (human-only, zero tokens)
//  - per-turn usage capture (tokens from turn.complete, dollars from the session's /cost ledger)
//  - a band above the prompt: active change, stage, context size, session spend, sensor state
//  - the impact dialog and per-edit notices (gates.ts); the band and pane (band.tsx)
//  - a context budget: a toast at the soft limit and a nudge to Claude at the hard limit
// Essential gates live in hooks.json settings hooks so they also hold in `claude -p` and CI.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Status, StepInfo } from '../types'
import { sdlcArgv, parseStatus, SLUG_RE, NODES, mod } from './shared'
import { PANE_ID, STORY_PANE, METRICS_PANE, SOFT_CONTEXT, HARD_CONTEXT, registerBand } from './band'
import { registerGates } from './gates'
import { promptFor, gateOf, stepKey } from './driver'

const NUDGE_EVERY_PROMPTS = 5

// Same plugin and key as band.tsx's atoms: the loader reads state refs only where they are declared, so each file declares its own.
const band = atom({ plugin: 'sdlc', key: 'band' } as const, null as Band | null)
const paneText = atom({ plugin: 'sdlc', key: 'paneText' } as const, '')
const metricsText = atom({ plugin: 'sdlc', key: 'metricsText' } as const, '')

const driverRunning = atom({ plugin: 'sdlc', key: 'driverRunning' } as const, false)
const driverLast = atom({ plugin: 'sdlc', key: 'driverLast' } as const, '')

let lastCostUsd = 0
let warnedSoft = false
let promptsSinceNudge = NUDGE_EVERY_PROMPTS
// Change and stage as they stood when the current main turn started, so spend lands on the stage that incurred it.
let turnChange: string | null = null
let turnStage: string | null = null
const agentTypes = new Map<string, string>()

const sdlc = ($: EngineInterface, args: string[]): string[] => sdlcArgv($.plugin.root, ...args)
const isInitialised = ($: EngineInterface): Promise<boolean> => $.fs.exists('.sdlc')
const statusJson = async ($: EngineInterface): Promise<Status | null> => parseStatus((await $.process.run(sdlc($, ['status', '--json']))).stdout)

function stageOf(status: Status | null): { change: string | null; stage: string | null } {
  const change = status?.active ?? null
  const stage = status?.changes?.find(c => c.slug === change)?.next?.stage ?? (change ? 'done' : null)
  return { change, stage }
}

const activeStage = async ($: EngineInterface): Promise<{ change: string | null; stage: string | null }> => stageOf(await statusJson($))

async function refreshBand($: EngineInterface): Promise<void> {
  const status = await statusJson($)
  const { change, stage } = stageOf(status)
  const session = await $.session.usage()
  const value: Band = { change, stage, contextTokens: session.context.tokens ?? 0, sessionUsd: session.cost?.usd ?? 0, sensors: status?.sensors ?? null, story: status?.story ?? null, step: status?.step ?? null }
  await update($, band, () => value)
}

async function stopDriver($: EngineInterface, why: string): Promise<void> {
  await update($, driverRunning, () => false)
  await update($, driverLast, () => '')
  $.ui.toast(`sdlc: ${why}`)
}

// Ask the script for the next node and submit it; the rules stay in the script, this only forwards the person's choices.
async function advance($: EngineInterface): Promise<void> {
  if (!(await read($, driverRunning))) return
  if (!(await isInitialised($))) return stopDriver($, 'not initialised; driver stopped')
  let s: StepInfo
  try {
    s = JSON.parse((await $.process.run(sdlc($, ['next', '--json']))).stdout) as StepInfo
  } catch {
    return stopDriver($, 'could not read the next step; driver stopped')
  }
  const needsNode = s.verdict === 'continue' || s.verdict === 'human'
  if (typeof s.slug !== 'string' || !SLUG_RE.test(s.slug) || (s.node === null || s.node === undefined ? needsNode : typeof s.node !== 'string' || !NODES.has(s.node))) return stopDriver($, 'the next step names an unknown change or node; driver stopped')
  if (s.verdict === 'blocked') return stopDriver($, `blocked: ${s.reason}`)
  if (s.verdict === 'ready') return stopDriver($, `${s.slug} is ready: a person merges the PR`)
  if (s.verdict === 'human') {
    const gate = gateOf(s)
    if (!gate) return stopDriver($, `waiting at a human gate: ${s.reason}`)
    // An approval that leaves the same gate waiting must not loop.
    if ((await read($, driverLast)) === `gate:${gate}`) return stopDriver($, `the ${gate} approval did not advance; driver stopped`)
    let answer = ''
    try {
      answer = await $.ui.ask(`Approve ${gate} for ${s.slug}? (${s.command})`, { options: [`Approve ${gate}`, 'Not yet'], header: 'Gate' })
    } catch {
      // nobody to ask (dismissed, -p): never approve
    }
    if (answer !== `Approve ${gate}`) return stopDriver($, `waiting at the ${gate} gate`)
    const r = await $.process.run(sdlc($, ['approve', s.slug, gate]), { env: { SDLC_HUMAN: '1' } })
    if (r.exitCode !== 0) return stopDriver($, (r.stderr || r.stdout).trim() || `could not approve ${gate}`)
    await update($, driverLast, () => `gate:${gate}`)
    return advance($)
  }
  if ((await read($, driverLast)) === stepKey(s)) return stopDriver($, `no progress on ${s.node} (round ${s.round}); driver stopped`)
  await update($, driverLast, () => stepKey(s))
  $.prompt.submit({ text: promptFor(s, $.plugin.root) }).catch(err => { $.ui.log(`driver could not submit: ${String(err)}`); return stopDriver($, 'the prompt was not accepted; driver stopped') })
}

// The vendored copy (.sdlc/mod) wins over the globally installed plugin's mod: both would register the same commands.
const isVendoredRoot = (root: string): boolean => /\/\.sdlc\/mod\/?$/.test(root)

// Step aside only when the vendored copy is really configured: its files exist AND the protected settings enable it.
// Anything unreadable keeps this copy active (fail closed).
async function vendoredCopyActive($: EngineInterface): Promise<boolean> {
  if (isVendoredRoot($.plugin.root) || !(await $.fs.exists('.sdlc/mod/hooks/register.ts'))) return false
  try {
    const settings = JSON.parse(await $.fs.read('.claude/settings.json')) as { enabledPlugins?: Record<string, unknown> }
    if (settings.enabledPlugins?.['sdlc-mod@sdlc-local'] === true) {
      $.ui.log("sdlc: using the project's vendored sdlc mod (.sdlc/mod)")
      return true
    }
  } catch { /* unreadable or unparseable settings: stay active */ }
  $.ui.log('sdlc: the vendored mod (.sdlc/mod) is present but not enabled in .claude/settings.json; using the plugin copy')
  return false
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    mod.aside = await vendoredCopyActive($)
    if (mod.aside) return next(e)
    await update($, driverRunning, () => false)
    await update($, driverLast, () => '')
    lastCostUsd = (await $.session.usage()).cost?.usd ?? 0
    try {
      await $.command.register({ name: 'sdlc-status', description: 'sdlc: where every change stands and the next command (no model call)', immediate: true })
      // A standalone repo ships its own human-only /sdlc-approve and /sdlc-waive skills; registering ours too would clash.
      if (!(await $.fs.exists('.claude/skills/sdlc-approve/SKILL.md'))) {
        await $.command.register({ name: 'sdlc-approve', description: 'sdlc: approve a gated artifact (human only)', argumentHint: '<slug> <intent|spec|plan|impact|budget>' })
        await $.command.register({ name: 'sdlc-waive', description: 'sdlc: waive a sensor finding for the active change (human only)', argumentHint: '<sensor> <file|*> <reason>' })
      }
      await $.command.register({ name: 'sdlc-sensors', description: 'sdlc: what the sensors found, known-red and waivers (no model call)', immediate: true })
      await $.command.register({ name: 'sdlc-story', description: 'sdlc: the active story - node, rounds, cost by node, estimated value (no model call)', immediate: true })
      await $.command.register({ name: 'sdlc-run', description: 'sdlc: drive the active change node by node to the next gate (no model call to decide); /sdlc-run stop pauses', argumentHint: '[stop]', immediate: true })
      await $.command.register({ name: 'sdlc-metrics-pane', description: 'sdlc: leading and lagging indicators in a pane (no model call)', immediate: true })
    } catch (err) {
      $.ui.log(`could not register commands: ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'sdlc-status' }, async $ => {
    const r = await $.process.run(sdlc($, ['status']))
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('command.run', { command: 'sdlc-approve' }, async ($, e) => {
    // Approval is the person's act: refuse anything that did not come from their own prompt.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return { text: 'sdlc-approve runs only when the person types it.' }
    }
    const [slug, stage] = e.args.trim().split(/\s+/)
    if (!slug || !stage) return { text: 'usage: /sdlc-approve <slug> <intent|spec|plan>' }
    const r = await $.process.run(sdlc($, ['approve', slug, stage]), { env: { SDLC_HUMAN: '1' } })
    await refreshBand($)
    return { text: (r.stdout || r.stderr).trim(), context: r.exitCode === 0 ? [`The person approved ${slug} ${stage}.`] : undefined }
  })

  on('command.run', { command: 'sdlc-waive' }, async ($, e) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return { text: 'sdlc-waive runs only when the person types it.' }
    const parts = e.args.trim().split(/\s+/)
    if (parts.length < 3) return { text: 'usage: /sdlc-waive <sensor> <file|*> <reason>' }
    const r = await $.process.run(sdlc($, ['waive', ...parts]), { env: { SDLC_HUMAN: '1' } })
    await refreshBand($)
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('command.run', { command: 'sdlc-run' }, async ($, e) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return { text: 'sdlc-run runs only when the person types it.' }
    if (e.args.trim() === 'stop') {
      await stopDriver($, 'driver paused')
      return {}
    }
    if (!(await isInitialised($))) return { text: 'sdlc is not initialised here.' }
    await update($, driverLast, () => '')
    // prompt.submit cannot run inside a command.run hook (it would wait on the turn the hook holds): start once the command has returned.
    // The driver is marked running only when the timer really fires (a refused timer never calls back and does not throw),
    // and any failure on the first step resets it, so a later turn never starts driving unannounced.
    try {
      $.clock.after(0, () => {
        update($, driverRunning, () => true).then(() => advance($)).catch(err => stopDriver($, `driver stopped: ${String(err)}`).catch(() => undefined))
      })
    } catch (err) {
      await stopDriver($, `driver stopped: ${String(err)}`)
    }
    return {}
  })

  on('command.run', { command: 'sdlc-sensors' }, async $ => {
    const r = await $.process.run(sdlc($, ['sensors']))
    await update($, paneText, () => (r.stdout || r.stderr).trim())
    await $.ui.open({ id: PANE_ID, title: 'sdlc sensors' })
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('command.run', { command: 'sdlc-story' }, async $ => {
    await refreshBand($)
    await $.ui.open({ id: STORY_PANE, title: 'sdlc story' })
    return {}
  })

  on('command.run', { command: 'sdlc-metrics-pane' }, async $ => {
    const r = await $.process.run(sdlc($, ['metrics']))
    await update($, metricsText, () => (r.stdout || r.stderr).trim())
    await $.ui.open({ id: METRICS_PANE, title: 'sdlc metrics' })
    return {}
  })

  on('turn.start', async ($, e, next) => {
    if (mod.aside) return next(e)
    if (await isInitialised($)) ({ change: turnChange, stage: turnStage } = await activeStage($))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (mod.aside) return next(e)
    const result = await next(e)
    if (result.agentId) agentTypes.set(result.agentId, e.subagentType)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (mod.aside) return next(e)
    const result = await next(e)
    try {
      if (!(await isInitialised($))) return result
      const usage = e.usage
      const row: Record<string, unknown> = {
        kind: e.agentId ? 'agent' : 'main',
        model: usage?.model ?? null,
        in: usage?.input_tokens ?? 0,
        out: usage?.output_tokens ?? 0,
        cr: usage?.cache_read_input_tokens ?? 0,
        cw: usage?.cache_creation_input_tokens ?? 0,
        ms: e.durationMs,
        aborted: e.isAborted,
      }
      row.change = turnChange
      row.stage = turnStage
      if (e.agentId) {
        row.agentType = agentTypes.get(e.agentId) ?? (await $.agent.list()).find(a => a.id === e.agentId)?.type ?? 'unknown'
      } else {
        // The session ledger includes subagents, advisor calls and classifiers, so the delta is the turn's real cost.
        const session = await $.session.usage()
        const costUsd = session.cost?.usd ?? lastCostUsd
        // A ledger below the last reading was reset (/clear starts a new one): everything on it is this turn's.
        row.usd = Number((costUsd >= lastCostUsd ? costUsd - lastCostUsd : costUsd).toFixed(4))
        row.ctx = session.context.tokens ?? 0
        lastCostUsd = costUsd
        if ((row.ctx as number) > SOFT_CONTEXT && !warnedSoft) {
          warnedSoft = true
          $.ui.toast(`Context at ${Math.round((row.ctx as number) / 1000)}k: finish this step, then /compact`)
        }
      }
      await $.process.run(sdlc($, ['log-usage', JSON.stringify(row)]))
      if (!e.agentId) await refreshBand($)
    } catch (err) {
      $.ui.log(`usage capture skipped: ${String(err)}`)
    }
    // Only main turns drive: an aborted one (the person pressed Esc) pauses, a finished one advances.
    if (!e.agentId) {
      try {
        if (e.isAborted) {
          if (await read($, driverRunning)) await stopDriver($, 'driver paused')
        } else {
          await advance($)
        }
      } catch (err) {
        $.ui.log(`driver stopped: ${String(err)}`)
      }
    }
    return result
  })

  // Past the hard limit, remind Claude (appended context keeps the prompt cache intact).
  on('prompt.submit', async ($, e, next) => {
    if (mod.aside) return next(e)
    const current = await read($, band)
    if (!current || current.contextTokens < HARD_CONTEXT) return next(e)
    promptsSinceNudge += 1
    if (promptsSinceNudge < NUDGE_EVERY_PROMPTS) return next(e)
    promptsSinceNudge = 0
    const note = `sdlc: context is ${Math.round(current.contextTokens / 1000)}k tokens, past the 150k budget. Finish the current step, then run /compact: the active change and its next step live in .sdlc/STATE.md.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  registerBand(on)
  registerGates(on)
}
