// The sdlc mod: what settings hooks cannot do.
//  - /sdlc-status and /sdlc-approve: zero-token commands; approve runs only from the person's own prompt
//  - /sdlc-waive and /sdlc-sensors (human-only, zero tokens)
//  - per-turn usage capture (tokens from turn.complete, dollars from the session's /cost ledger)
//  - a band above the prompt: active change, stage, context size, session spend, sensor state
//  - the impact dialog and per-edit notices (gates.tsx); the band and pane (band.tsx)
//  - a context budget: a toast at the soft limit and a nudge to Claude at the hard limit
//  - cheap-by-default subagents: a general-purpose spawn with no model named runs on Sonnet
// Essential gates live in hooks.json settings hooks so they also hold in `claude -p` and CI.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Status } from '../types'
import { sdlcArgv, parseStatus } from './shared'
import { PANE_ID, SOFT_CONTEXT, HARD_CONTEXT, registerBand } from './band'
import { registerGates } from './gates'

const NUDGE_EVERY_PROMPTS = 5
const DEFAULT_SUBAGENT_MODEL = 'claude-sonnet-5-5'

// Same plugin and key as band.tsx's atoms: the loader reads state refs only where they are declared, so each file declares its own.
const band = atom({ plugin: 'sdlc', key: 'band' } as const, null as Band | null)
const paneText = atom({ plugin: 'sdlc', key: 'paneText' } as const, '')

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

async function activeStage($: EngineInterface): Promise<{ change: string | null; stage: string | null }> {
  const status = await statusJson($)
  const change = status?.active ?? null
  const stage = status?.changes?.find(c => c.slug === change)?.next?.stage ?? (change ? 'done' : null)
  return { change, stage }
}

async function refreshBand($: EngineInterface): Promise<void> {
  const { change, stage } = await activeStage($)
  const session = await $.session.usage()
  const value: Band = { change, stage, contextTokens: session.context.tokens ?? 0, sessionUsd: session.cost?.usd ?? 0, sensors: (await statusJson($))?.sensors ?? null }
  await update($, band, () => value)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    lastCostUsd = (await $.session.usage()).cost?.usd ?? 0
    try {
      await $.command.register({ name: 'sdlc-status', description: 'sdlc: where every change stands and the next command (no model call)', immediate: true })
      await $.command.register({ name: 'sdlc-approve', description: 'sdlc: approve a gated artifact (human only)', argumentHint: '<slug> <intent|spec|plan|impact>' })
      await $.command.register({ name: 'sdlc-waive', description: 'sdlc: waive a sensor finding for the active change (human only)', argumentHint: '<sensor> <file|*> <reason>' })
      await $.command.register({ name: 'sdlc-sensors', description: 'sdlc: what the sensors found, known-red and waivers (no model call)', immediate: true })
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

  on('command.run', { command: 'sdlc-sensors' }, async $ => {
    const r = await $.process.run(sdlc($, ['sensors']))
    await update($, paneText, () => (r.stdout || r.stderr).trim())
    await $.ui.open({ id: PANE_ID, title: 'sdlc sensors' })
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('turn.start', async ($, e, next) => {
    if (await isInitialised($)) ({ change: turnChange, stage: turnStage } = await activeStage($))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const routed = !e.model && e.subagentType === 'general-purpose' && (await isInitialised($)) ? { ...e, model: DEFAULT_SUBAGENT_MODEL } : e
    const result = await next(routed)
    if (result.agentId) agentTypes.set(result.agentId, e.subagentType)
    return result
  })

  on('turn.complete', async ($, e, next) => {
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
        row.usd = Number((costUsd - lastCostUsd).toFixed(4))
        row.ctx = session.context.tokens ?? 0
        lastCostUsd = costUsd
        if ((row.ctx as number) > SOFT_CONTEXT && !warnedSoft) {
          warnedSoft = true
          $.ui.toast(`Context at ${Math.round((row.ctx as number) / 1000)}k: finish this step, then /sdlc:handoff and /clear`)
        }
      }
      await $.process.run(sdlc($, ['log-usage', JSON.stringify(row)]))
      if (!e.agentId) await refreshBand($)
    } catch (err) {
      $.ui.log(`usage capture skipped: ${String(err)}`)
    }
    return result
  })

  // Past the hard limit, remind Claude (appended context keeps the prompt cache intact).
  on('prompt.submit', async ($, e, next) => {
    const current = await read($, band)
    if (!current || current.contextTokens < HARD_CONTEXT) return next(e)
    promptsSinceNudge += 1
    if (promptsSinceNudge < NUDGE_EVERY_PROMPTS) return next(e)
    promptsSinceNudge = 0
    const note = `sdlc: context is ${Math.round(current.contextTokens / 1000)}k tokens, past the 150k budget. Finish the current step, then run /sdlc:handoff so the person can /clear and resume cheaply.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  registerBand(on)
  registerGates(on)
}
