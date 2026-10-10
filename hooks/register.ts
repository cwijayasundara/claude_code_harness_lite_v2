// The sdlc mod: what settings hooks cannot do.
//  - /rig-status and /rig:approve: zero-token commands; approve runs only from the person's own prompt
//  - /rig:waive and /rig-sensors (human-only, zero tokens)
//  - per-turn usage capture (tokens from turn.complete, dollars from the session's /cost ledger)
//  - /rig-map: mission control pane (mission.tsx): SDLC subway map, fix-loop arc, spend by station, fuel gauges
//  - a band above the prompt: active change, stage, context size, session spend, sensor state
//  - the impact dialog (gates.ts); the band and pane (band.tsx)
//  - a context budget: a toast at the soft limit and a nudge to Claude at the hard limit
// Essential gates live in hooks.json settings hooks so they also hold in `claude -p` and CI.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Band, Status, StepInfo, TurnPoint } from '../types'
import { sdlcArgv, parseStatus, SLUG_RE, NODES, mod, money, kilo, turnPoint, KEEP_TURNS, COORDINATOR_DOWNSHIFT } from './shared'
import { PANE_ID, STORY_PANE, SOFT_CONTEXT, HARD_CONTEXT, registerBand } from './band'
import { registerGates } from './gates'
import { registerMission } from './mission'
import { promptFor, gateOf, stepKey } from './driver'

const NUDGE_EVERY_PROMPTS = 5

// Same plugin and key as band.tsx's atoms: the loader reads state refs only where they are declared, so each file declares its own.
const band = atom({ plugin: 'rig', key: 'band' } as const, null as Band | null)

const turns = atom({ plugin: 'rig', key: 'turns' } as const, [] as TurnPoint[])
const driverRunning = atom({ plugin: 'rig', key: 'driverRunning' } as const, false)
const driverLast = atom({ plugin: 'rig', key: 'driverLast' } as const, '')

let lastCostUsd = 0, warnedSoft = false
let firstMainTurn = true // its ctx is the system prompt plus the prompt: the context sensor's "first call"
let promptsSinceNudge = NUDGE_EVERY_PROMPTS
// Change and stage as they stood when the current main turn started, so spend lands on the stage that incurred it.
let turnChange: string | null = null
let turnStage: string | null = null
let turnPressure: 'normal' | 'tight' = 'normal', coordinatorSwitched = false
const agentTypes = new Map<string, string>()

const sdlc = ($: EngineInterface, args: string[]): string[] => sdlcArgv($.plugin.root, ...args)
const isInitialised = ($: EngineInterface): Promise<boolean> => $.fs.exists('.rig')
const statusJson = async ($: EngineInterface): Promise<Status | null> => parseStatus((await $.process.run(sdlc($, ['status', '--json', '--band']))).stdout)

function stageOf(status: Status | null): { change: string | null; stage: string | null } {
  const change = status?.active ?? null
  const stage = status?.changes?.find(c => c.slug === change)?.next?.stage ?? (change ? 'done' : null)
  return { change, stage }
}

async function refreshBand($: EngineInterface): Promise<Status | null> {
  const status = await statusJson($)
  const { change, stage } = stageOf(status)
  const session = await $.session.usage()
  const value: Band = { change, stage, contextTokens: session.context.tokens ?? 0, sessionUsd: session.cost?.usd ?? 0, sensors: status?.sensors ?? null, story: status?.story ?? null, step: status?.step ?? null, flow: status?.flow, budget: status?.budget ?? null }
  await update($, band, () => value)
  $.ui.status(`rig${stage ? ` · ${stage}` : ''} · ${money(value.sessionUsd)} · ${kilo(value.contextTokens)} ctx`)
  return status
}

async function stopDriver($: EngineInterface, why: string): Promise<void> {
  await update($, driverRunning, () => false)
  await update($, driverLast, () => '')
  $.ui.toast(`rig: ${why}`)
}

// Ask the script for the next node and submit it; the rules stay in the script, this only forwards the person's choices.
async function advance($: EngineInterface): Promise<void> {
  if (!(await read($, driverRunning))) return
  if (!(await isInitialised($))) return stopDriver($, 'not initialised; driver stopped')
  let s: StepInfo
  try {
    s = JSON.parse((await $.process.run(sdlc($, ['next', '--json']))).stdout) as StepInfo
  } catch { return stopDriver($, 'could not read the next step; driver stopped') }
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
      answer = await $.ui.ask(gate === 'design' ? `Approve the intent and design for ${s.slug}? After this the build, tests and PR run without asking.` : `Approve ${gate} for ${s.slug}? (${s.command})`, { options: [`Approve ${gate}`, 'Not yet'], header: 'Gate' })
    } catch { /* nobody to ask (dismissed, -p): never approve */ }
    if (answer !== `Approve ${gate}`) return stopDriver($, `waiting at the ${gate} gate`)
    const r = await $.process.run(sdlc($, ['approve', s.slug, gate]), { env: { SDLC_HUMAN: '1' } })
    if (r.exitCode !== 0) return stopDriver($, (r.stderr || r.stdout).trim() || `could not approve ${gate}`)
    await update($, driverLast, () => `gate:${gate}`)
    return advance($)
  }
  // The sensors node needs no model: run it here at zero tokens, and only a regression goes to the model for a fix round.
  if (s.node === 'sensors' && (await $.process.run(sdlc($, ['quality', s.slug]))).exitCode === 0) { await update($, driverLast, () => ''); return advance($) }
  if ((await read($, driverLast)) === stepKey(s)) return stopDriver($, `no progress on ${s.node} (round ${s.round}); driver stopped`)
  await update($, driverLast, () => stepKey(s))
  $.prompt.submit({ text: promptFor(s, $.plugin.root) }).catch(err => { $.ui.log(`driver could not submit: ${String(err)}`); return stopDriver($, 'the prompt was not accepted; driver stopped') })
}

// Starts the driver once the calling hook has returned (prompt.submit would wait on the turn the hook holds); a refused timer never calls back, so
// "running" is set only when it fires, and any failure on the first step resets it.
async function startDriver($: EngineInterface): Promise<void> {
  await update($, driverLast, () => '')
  try { $.clock.after(0, () => { read($, driverRunning).then(on => on ? undefined : update($, driverRunning, () => true).then(() => advance($))).catch(err => stopDriver($, `driver stopped: ${String(err)}`).catch(() => undefined)) }) }
  catch (err) { await stopDriver($, `driver stopped: ${String(err)}`) }
}

// The one human gate of a feature: a turn ending at the design gate starts the driver, which asks once and then drives build to PR.
// `step` comes from this turn's band refresh (the same answer as `next --json`), so no extra process.
async function offerDesignGate($: EngineInterface, step: StepInfo | null | undefined): Promise<void> {
  if (!step || step.verdict !== 'human' || gateOf(step) !== 'design') return
  await Promise.all([update($, driverLast, () => ''), update($, driverRunning, () => true)])
  return advance($)
}

// The vendored copy (.rig/mod) wins over the globally installed plugin's mod: both would register the same commands.
const isVendoredRoot = (root: string): boolean => /\/\.rig\/mod\/?$/.test(root.replace(/\\/g, '/'))

const VENDORED_IDS = ['rig@rig-local', 'rig-mod@rig-local', 'sdlc-mod@sdlc-local']

// Step aside only when the vendored copy is really configured: its files exist AND the protected settings enable it.
// Anything unreadable keeps this copy active (fail closed).
async function vendoredCopyActive($: EngineInterface): Promise<boolean> {
  if (isVendoredRoot($.plugin.root) || !(await $.fs.exists('.rig/mod/hooks/register.ts'))) return false
  try {
    const settings = JSON.parse(await $.fs.read('.claude/settings.json')) as { enabledPlugins?: Record<string, unknown> }
    // sdlc-mod@sdlc-local: repos vendored before the rename to rig.
    if (VENDORED_IDS.some(id => settings.enabledPlugins?.[id] === true)) {
      $.ui.log("rig: using the project's vendored sdlc mod (.rig/mod)")
      return true
    }
  } catch { /* unreadable or unparseable settings: stay active */ }
  $.ui.log('rig: the vendored mod (.rig/mod) is present but not enabled in .claude/settings.json; using the plugin copy')
  return false
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    mod.aside = await vendoredCopyActive($)
    if (mod.aside) return next(e)
    coordinatorSwitched = false
    turnPressure = 'normal'
    await update($, driverRunning, () => false)
    await update($, driverLast, () => '')
    lastCostUsd = (await $.session.usage()).cost?.usd ?? 0
    try {
      await $.command.register({ name: 'rig-status', description: 'rig: where every change stands and the next command (no model call)', immediate: true })
      // A standalone repo ships its own human-only /rig:approve and /rig:waive skills; registering ours too would clash.
      if (!(await $.fs.exists('.claude/skills/rig-approve/SKILL.md'))) {
        await $.command.register({ name: 'rig-approve', description: 'rig: approve a gated artifact (human only)', argumentHint: '<slug> <intent|spec|plan|design|impact|budget|full-route|tier S|M|L [type]>' })
        await $.command.register({ name: 'rig-waive', description: 'rig: waive a sensor finding for the active change (human only)', argumentHint: '<sensor> <file|*> <reason>' })
      }
      await $.command.register({ name: 'rig-sensors', description: 'rig: what the sensors found, known-red and waivers (no model call)', immediate: true })
      await $.command.register({ name: 'rig-story', description: 'rig: the active story - node, rounds, cost by node (no model call)', immediate: true })
      await $.command.register({ name: 'rig-run', description: 'rig: drive the active change node by node to the next gate (no model call to decide); /rig-run stop pauses', argumentHint: '[stop]', immediate: true })
      await $.command.register({ name: 'rig-map', description: 'rig: mission control - the SDLC map, where you are, tokens and dollars (no model call)', immediate: true })
      await $.command.register({ name: 'rig-metrics-pane', description: 'rig: leading and lagging indicators in a pane (no model call)', immediate: true })
    } catch (err) { $.ui.log(`could not register commands: ${String(err)}`) }
    await refreshBand($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'rig-status' }, async $ => {
    const r = await $.process.run(sdlc($, ['status']))
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('command.run', { command: 'rig-approve' }, async ($, e) => {
    // Approval is the person's act: refuse anything that did not come from their own prompt.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return { text: 'rig-approve runs only when the person types it.' }
    }
    const [slug, stage, ...more] = e.args.trim().split(/\s+/)
    const rest = stage === 'tier' ? more.slice(0, 2) : []
    if (!slug || !stage) return { text: 'usage: /rig:approve <slug> <intent|spec|plan|design|impact|budget|full-route|tier S|M|L [type]>' }
    const r = await $.process.run(sdlc($, ['approve', slug, stage, ...rest]), { env: { SDLC_HUMAN: '1' } })
    const status = await refreshBand($)
    // Approving a pre-code gate on the active change hands the rest (build, test, sensors, pr) to the driver; it stops at a human step, a block or the PR.
    if (r.exitCode === 0 && status?.active === slug && /^(?:intent|spec|plan|design)$/.test(stage ?? '') && !(await read($, driverRunning))) await startDriver($)
    return { text: (r.stdout || r.stderr).trim(), context: r.exitCode === 0 ? [`The person approved ${slug} ${[stage, ...rest].join(' ')}.`] : undefined }
  })

  on('command.run', { command: 'rig-waive' }, async ($, e) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return { text: 'rig-waive runs only when the person types it.' }
    const parts = e.args.trim().split(/\s+/)
    if (parts.length < 3) return { text: 'usage: /rig:waive <sensor> <file|*> <reason>' }
    const r = await $.process.run(sdlc($, ['waive', ...parts]), { env: { SDLC_HUMAN: '1' } })
    await refreshBand($)
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('command.run', { command: 'rig-run' }, async ($, e) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return { text: 'rig-run runs only when the person types it.' }
    if (e.args.trim() === 'stop') {
      await stopDriver($, 'driver paused')
      return {}
    }
    if (!(await isInitialised($))) return { text: 'sdlc is not initialised here.' }
    await startDriver($)
    return {}
  })

  on('command.run', { command: 'rig-story' }, async $ => {
    await refreshBand($)
    await $.ui.open({ id: STORY_PANE, title: 'sdlc story' })
    return {}
  })

  on('turn.start', async ($, e, next) => {
    if (mod.aside) return next(e)
    if (await isInitialised($)) { const s = await statusJson($); ({ change: turnChange, stage: turnStage } = stageOf(s)); turnPressure = s?.step?.pressure ?? s?.pressure ?? 'normal' }
    return next(e)
  })

  // Budget downshift (spend spec §7): an Opus main loop moves to pinned Sonnet once under pressure and stays; subagents keep their routes.
  on('turn.step', async function* ($, e, next) {
    if (mod.aside || e.agentId || !/opus/i.test(e.model)) return yield* next(e)
    if (!coordinatorSwitched && turnPressure === 'tight' && e.index === 0) { coordinatorSwitched = true; $.ui.toast('rig: budget tight, coordinator moved to Sonnet for this session') }
    return yield* next(coordinatorSwitched ? { ...e, model: COORDINATOR_DOWNSHIFT } : e)
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
    let status: Status | null = null
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
        if (firstMainTurn) { row.first = true; firstMainTurn = false }
        lastCostUsd = costUsd
        if ((row.ctx as number) > SOFT_CONTEXT && !warnedSoft) {
          warnedSoft = true
          $.ui.toast(`Context at ${Math.round((row.ctx as number) / 1000)}k: finish this step, then /compact`)
        }
      }
      for (const line of (await $.process.run(sdlc($, ['log-usage', JSON.stringify(row)]))).stdout.split('\n').filter(l => l.startsWith('rig:'))) $.ui.toast(line) // the context sensor's warnings
      await update($, turns, h => [...h, turnPoint(usage, !!e.agentId, Number(row.usd ?? 0))].slice(-KEEP_TURNS))
      if (!e.agentId) status = await refreshBand($)
      const hot = (l?: string) => l === 'notice' || l === 'tight' || l === 'over'
      if (!e.agentId && (hot(status?.budget?.level) || hot(status?.budget?.change?.level))) for (const line of (await $.process.run(sdlc($, ['spend', 'notify']))).stdout.split('\n').filter(Boolean)) $.ui.toast(line)
    } catch (err) {
      $.ui.log(`usage capture skipped: ${String(err)}`)
    }
    // Only main turns drive: an aborted one (the person pressed Esc) pauses, a finished one advances.
    if (!e.agentId) {
      try {
        if (e.isAborted) {
          if (await read($, driverRunning)) await stopDriver($, 'driver paused')
        } else {
          await ((await read($, driverRunning)) ? advance($) : offerDesignGate($, status?.step))
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
    const note = `rig: context is ${Math.round(current.contextTokens / 1000)}k tokens, past the 150k budget. Finish the current step, then run /compact: the active change and its next step live in .rig/STATE.md.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  registerBand(on)
  registerMission(on)
  registerGates(on)
}
