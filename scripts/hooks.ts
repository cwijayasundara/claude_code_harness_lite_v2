// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
// Five events, none on Bash: session start, turn start (the baseline), post-edit (a slim per-file check), the Stop gate,
// and the skill-load fallback. Evidence is protected by settings deny rules and by CI, not by parsing shell commands.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, git, STATE, USAGE, PLUGIN_ROOT, IS_VENDORED, skillRef, agentRef, now, exists, read, out, fail, frontmatter, toPosix,
  managedSettings, scanSecrets, planProblems, relPosix, sha, withLock, writeAtomic, type Args, type HookInput,
} from './core.ts'
import { activeSlug, loadChange, nextCommand, createAdhoc, step } from './graph.ts'
import { snapshot, writeBaseline, readBaseline, turnDiff, showAt, diffHash } from './diffs.ts'
import { isProtected, tierFromDiff } from './sensors.ts'
import { loadConfig, runChecks, editFindings } from './check.ts'
import { formatFindings, isSource, isTest, matchesAny, warnRow, type Finding, type SensorConfig } from './model.ts'
import { sessionNote } from './githooks.ts'
import { appendEvent, readEvents } from './ratchet.ts'
import { treeStamp } from './stamp.ts'

function readStdin(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') as HookInput
  } catch {
    return {}
  }
}

type Guide = { name: string; globs: string[]; sourceOnly: boolean; body: string }

export function listGuides(config: SensorConfig): Guide[] {
  const dir = path.join(SDLC, 'guides')
  if (!exists(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => {
    const { data, body } = frontmatter(read(path.join(dir, f)))
    const tokens = (data.paths ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const globs = tokens.flatMap(t => (t === '@source' ? ['**'] : t === '@tests' ? config.tests : t === '@contracts' ? config.contracts : [t]))
    return { name: data.name || f.replace(/\.md$/, ''), globs, sourceOnly: tokens.includes('@source'), body: body.trim() }
  })
}

// Progressive disclosure: a guide enters the context the first time this session edits a matching file.
function guidesFor(rel: string, session: string): string | undefined {
  const { config } = loadConfig()
  const seen = readGate().guides[session] ?? []
  const fresh = listGuides(config).filter(g => !seen.includes(g.name) && matchesAny(rel, g.globs) && (!g.sourceOnly || (isSource(rel, config) && !isTest(rel, config))))
  if (!fresh.length) return undefined
  updateGate(g => { g.guides[session] = [...(g.guides[session] ?? seen), ...fresh.map(f => f.name)] })
  return fresh.map(g => g.body).join('\n\n')
}

export const ROUTING_LINE = `sdlc routes all work in this repo: start with ${skillRef('start')}; use superpowers skills only when an sdlc skill names one.`

// The sdlc script as the model should call it: the plugin's copy, or the project's own in a standalone repo.
const SCRIPT = () => (IS_VENDORED ? '.rig/bin/sdlc.ts' : `${toPosix(PLUGIN_ROOT)}/scripts/sdlc.ts`)

function hookSessionStart(input: HookInput): void {
  if (!exists(SDLC)) return
  if (input.source === 'compact' || input.source === 'clear') {
    updateGate(g => { delete g.guides[input.session_id ?? 'default'] })
  }
  const cfg = loadConfig().config
  const guides = listGuides(cfg).map(g => g.name)
  const active = activeSlug()
  const c = active ? loadChange(active) : null
  const state = frontmatter(read(STATE)).body.trim().split('\n').slice(0, 15).join('\n')
  const context = [
    'sdlc harness is active in this repo (artifacts in .rig/).',
    ROUTING_LINE,
    c ? `Active change: ${c.slug} (${c.type}, tier ${c.tier}). Next: ${nextCommand(c)}` : `No active change. Start one with ${skillRef('start')} "<request>".`,
    `Rules: plans hold interfaces + acceptance tests, never code; delegate searches to ${agentRef('scout')} and slices to ${agentRef('implementer')}; read .rig/approvals.jsonl with the Read tool (only the person writes it); run subagents in the foreground and never end a turn while one is running; never sleep-poll; at ~150k context run /compact (the active change lives in .rig/STATE.md). If an sdlc skill fails to load, run \`node "${SCRIPT()}" skill <stage> <slug>\` and follow it exactly.`,
    sessionNote(),
    guides.length ? `Guides (injected when you first touch matching files): ${guides.join(', ')}` : '',
    state && state !== '# State' ? `STATE.md:\n${state}` : '',
  ].filter(Boolean)
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } }))
}

// After a Write or Edit: secret and plan checks, the edit's own sensor findings (judged against the turn baseline, so debt
// that was already there is not blamed) and, the first time this session touches a matching file, its guides.
// Unplanned work gets exactly the same checks: nothing here needs an active change.
function hookPostEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? '')
  if (!file || !exists(file)) return
  const problems = scanSecrets(file)
  if (exists(SDLC) && /\.rig\/changes\/[^/]+\/(?:plan|design)\.md$/.test(toPosix(file))) problems.push(...planProblems(file).map(p => `${file}: ${p}`))
  let edits = ''
  let guide: string | undefined
  if (exists(SDLC)) {
    const rel = relPosix(file)
    updateGate(g => { g.tool = pushUnique(g.tool, rel) })
    edits = formatFindings(editFindings(rel).filter(f => f.severity === 'block' && f.sensor !== 'secrets'))
    if (!problems.length && !edits) guide = guidesFor(rel, input.session_id ?? 'default')
  }
  if (problems.length || edits) {
    process.stderr.write(`sdlc check failed, fix before continuing:\n${[...problems, edits].filter(Boolean).join('\n')}\n`)
    process.exitCode = 2
    return
  }
  if (guide) out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: guide } }))
}

// A stage skill that fails to load leaves the model to improvise. Hand it the exact instructions instead.
// Skills sdlc delegates to but does not own: what to do when one fails to load.
const EXTERNAL_FALLBACKS: Record<string, string> = {
  'superpowers:subagent-driven-development': 'superpowers SDD is unavailable. Continue with the "Large builds: orchestrate" section of '
    + '/rig:build (rig:implementer subagents). Say "skill fallback: native build" in your reply.',
  'code-review': 'The built-in code-review skill is unavailable. Launch rig:reviewer (Opus) with the change folder and the diff base '
    + 'instead, as /rig:pr-review step 2 says. Say "skill fallback: rig reviewer" in your reply.',
}

function hookSkillFailed(input: HookInput): void {
  if (!exists(SDLC)) return
  const skill = String(input.tool_input?.skill ?? '')
  const external = EXTERNAL_FALLBACKS[skill]
  if (external) {
    fs.appendFileSync(USAGE, JSON.stringify({ at: now(), kind: 'event', event: 'skill-load-failed', skill }) + '\n')
    return out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: external } }))
  }
  const m = /^rig[:-]([a-z-]+)$/.exec(skill)
  if (!m) return
  fs.appendFileSync(USAGE, JSON.stringify({ at: now(), kind: 'event', event: 'skill-load-failed', skill }) + '\n')
  const cmd = `node --disable-warning=ExperimentalWarning "${SCRIPT()}" skill ${m[1]} ${input.tool_input?.args ?? ''}`.trim()
  const context = `The ${skill} skill failed to load. Run \`${cmd}\` and follow the printed steps exactly, as if the skill had loaded. Say "skill fallback: ${skill}" in your reply.`
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: context } }))
}

export type GateSummary = { at: string; blocks: number; warns: number; bySensor: Record<string, number>; warnRows?: string[]; shown?: boolean }
// trees: stamps of working trees on which the fast commands passed, kept across turns (the per-turn fields reset at each prompt).
export type Gate = { turn: string; blocks: Record<string, number>; passed: Record<string, string>; tool: string[]; guides: Record<string, string[]>; trees: string[]; cont?: string; turnStep?: string; last?: GateSummary }

const GATE = path.join(SDLC, '.gate')
const UNRESOLVED = path.join(SDLC, 'unresolved.json')
const MAX_BLOCKS = 2
const STOP_BUDGET_MS = 60_000
const PASSED_TREES = 20
const emptyGate = (): Gate => ({ turn: '', blocks: {}, passed: {}, tool: [], guides: {}, trees: [] })

export function readGate(): Gate {
  try {
    const g = JSON.parse(read(GATE)) as Record<string, unknown>
    const d = emptyGate()
    const obj = <T>(v: unknown, dflt: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : dflt)
    return {
      turn: typeof g.turn === 'string' ? g.turn : d.turn, blocks: obj(g.blocks, d.blocks), passed: obj(g.passed, d.passed),
      tool: Array.isArray(g.tool) ? g.tool.map(String) : d.tool, guides: obj(g.guides, d.guides), trees: Array.isArray(g.trees) ? g.trees.map(String) : d.trees,
      ...(typeof g.cont === 'string' ? { cont: g.cont } : {}), ...(typeof g.turnStep === 'string' ? { turnStep: g.turnStep } : {}),
      ...(g.last && typeof g.last === 'object' ? { last: g.last as GateSummary } : {}),
    }
  } catch {
    return emptyGate()
  }
}
const writeGate = (g: Gate): void => writeAtomic(GATE, JSON.stringify(g))
const updateGate = (fn: (g: Gate) => void): void => withLock(GATE, () => { const g = readGate(); fn(g); writeGate(g) })
const pushUnique = (list: string[], item: string): string[] => (list.includes(item) ? list : [...list, item])

const more = (s: GateSummary | undefined): string[] => (s && s.warns > (s.warnRows?.length ?? 0) ? [`+${s.warns - (s.warnRows?.length ?? 0)} more`] : [])

function summarize(findings: Finding[]): GateSummary {
  const bySensor: Record<string, number> = {}
  for (const f of findings) bySensor[f.sensor] = (bySensor[f.sensor] ?? 0) + 1
  const warns = findings.filter(f => f.severity === 'warn')
  return { at: now(), blocks: findings.filter(f => f.severity === 'block').length, warns: warns.length, bySensor, warnRows: warns.slice(0, 5).map(warnRow) }
}

// The person typed /rig:approve (or /rig-approve): a hook sees only what the person typed, never a model's tool call, so this is as
// human-only as the skill, and it works in a session that started before the skill was installed. A bare command approves the gate the
// active change waits at. The model is told to carry on with /rig:next, so the build starts without a second command.
function runSdlc(args: string[], human = false): { code: number; text: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1] ?? '', ...args], { encoding: 'utf8', env: { ...process.env, ...(human ? { SDLC_HUMAN: '1' } : {}) } })
  return { code: r.status ?? 1, text: `${r.stdout}${r.stderr}`.trim() }
}
function approveTyped(typedArgs: string): void {
  let args = typedArgs
  if (!args) {
    const next = runSdlc(['next', '--json'])
    try { args = (/\/rig[:-]approve (.+)$/.exec((JSON.parse(next.text) as { command?: string }).command ?? '')?.[1] ?? '').trim() } catch { /* unreadable: say so below */ }
    if (!args) return out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'rig: the person typed /rig:approve but no gate is waiting for approval. Tell them so in one line (run /rig:next for the next step) and stop.' } }))
  }
  const r = runSdlc(['approve', ...args.split(/\s+/)], true)
  const done = r.code === 0
  const follow = done && /^\S+ (?:intent|spec|plan|design)\b/.test(args) ? ' Then run /rig:next in this turn: the build, tests, sensors and PR run on their own from here.' : ''
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `rig: the person typed /rig:approve ${args}. The hook ${done ? 'recorded it' : 'refused it'}: ${r.text}\nDo not run /rig:approve or sdlc.ts approve yourself.${done ? follow : ' Tell the person the reason in one line and stop.'}` } }))
}

// Each prompt starts a turn: record the tree and reset the per-turn gate, so Stop diffs exactly this turn's changes.
// Warnings the last turn left are handed to the agent once, here, because a passing Stop cannot show them to it.
function hookPromptSubmit(input: HookInput = {}): void {
  if (!exists(SDLC)) return
  const typed = /^\s*\/rig[:-]approve(?:[ \t]+([^\n]*?))?\s*$/.exec(String(input.prompt ?? ''))
  const last = readGate().last
  const carry = !typed && last && !last.shown && last.warns > 0 && last.warnRows?.length ? last.warnRows : null
  const snap = snapshot()
  if (snap) writeBaseline(snap)
  updateGate(g => {
    Object.assign(g, { turn: snap?.at ?? now(), blocks: {}, passed: {}, tool: [], turnStep: stepKeyNow()?.key })
    if (carry && g.last) g.last.shown = true
  })
  if (typed) approveTyped(typed[1] ?? '')
  if (carry) {
    out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `rig: the last turn left ${last?.warns} warning(s) that did not block. Fix them if they are yours:\n${[...carry, ...more(last)].map(r => `- ${r}`).join('\n')}` } }))
  }
}

// The end-of-turn gate: every built-in sensor on this turn's diff, then the fast commands. Work with no active change is
// adopted as an ad-hoc change and judged the same way.
function hookStop(): boolean {
  if (!exists(SDLC)) return false
  const snap = readBaseline()
  if (!snap) return false
  const { config, rules, errors } = loadConfig()
  const gate = readGate()
  const diffs = turnDiff(snap).filter(d => isSource(d.file, config) || isProtected(d.file))
  if (!diffs.length) return false
  const hash = diffHash(diffs) + sha(read(path.join(SDLC, 'sensors.json')) + read(path.join(SDLC, 'rules.json')))
  if (gate.passed.main === hash) return false
  let slug = activeSlug()
  // A turn that shipped (its commits add a change's ship.json) is recorded already; any other commit is still ad hoc.
  const shipped = (git(['diff', '--name-only', snap.sha, 'HEAD']) ?? '').split('\n').some(f => /^\.rig\/changes\/[^/]+\/ship\.json$/.test(f))
  // Harness files alone (onboarding writes CI workflows and settings) are not ad-hoc work.
  if (!slug && !shipped && diffs.some(d => isSource(d.file, config) && !isProtected(d.file))) slug = createAdhoc(tierFromDiff(diffs, config))
  // The fast commands are keyed by the whole tree, not this turn's diff: a tree that already passed them (an edit undone, a
  // file touched and restored, the same state reached from another turn) skips them, and only the sensors judge the diff.
  const stamp = treeStamp()
  const treePassed = stamp !== null && gate.trees.includes(stamp)
  const result = runChecks({
    point: 'stop', diffs, config, rules, slugs: slug ? [slug] : [], commands: treePassed ? 'none' : 'fast', budgetMs: STOP_BUDGET_MS,
    before: f => showAt(snap.sha, f) ?? '', toolEdited: new Set(gate.tool), base: null, ratchet: true,
  })
  const configBlocks: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: '.rig/sensors.json', message: e, fix: 'fix the file' }))
  const findings = [...configBlocks, ...result.findings]
  const blocks = findings.filter(f => f.severity === 'block')
  gate.last = summarize(findings)
  // Write back only what this hook owns: edits recorded while the checks ran must survive.
  const save = (): void => updateGate(g => { g.last = gate.last; if (gate.passed.main) g.passed.main = gate.passed.main; if (gate.blocks.main) g.blocks.main = gate.blocks.main; if (gate.trees !== g.trees) g.trees = gate.trees })
  if (!blocks.length) {
    gate.passed.main = hash
    if (stamp && !treePassed) gate.trees = [...gate.trees, stamp].slice(-PASSED_TREES)
    save()
    if (exists(UNRESOLVED)) fs.rmSync(UNRESOLVED)
    const warns = gate.last?.warnRows ?? []
    if (warns.length) out(JSON.stringify({ systemMessage: `rig: ${gate.last?.warns} warning(s), not blocking: ${[...warns, ...more(gate.last)].join(' | ')}` }))
    return false
  }
  fs.writeFileSync(UNRESOLVED, JSON.stringify({ at: now(), slug, findings: blocks }, null, 2) + '\n')
  const attempt = (gate.blocks.main ?? 0) + 1
  if (attempt > MAX_BLOCKS) {
    save()
    out(JSON.stringify({ systemMessage: `sdlc quality gate: ${blocks.length} problem(s) unresolved after ${MAX_BLOCKS} attempts (.rig/unresolved.json). Ship and CI will refuse until they are fixed or the person waives them.` }))
    return true
  }
  gate.blocks.main = attempt
  save()
  out(JSON.stringify({ decision: 'block', reason: `sdlc quality gate (attempt ${attempt}/${MAX_BLOCKS}): fix these before you finish.\n${formatFindings(findings)}` }))
  return true
}

// After approval the rest of the lifecycle is automatic: a turn that ends with a node still to run (build, test, sensors, pr)
// and no person-gate waiting is sent on to the next node, so nobody types /rig:test. Each node is offered once: a turn that
// ends on the same node, round and slice count as the last offer moved nothing, so it stops instead of looping.
const AUTO_NODES = new Set(['build', 'test', 'sensors', 'pr', 'pr-review'])
function stepKeyNow(): { key: string; s: ReturnType<typeof step> } | null {
  try {
    const slug = exists(SDLC) ? activeSlug() : null
    if (!slug) return null
    const s = step(slug)
    return { key: `${slug}:${s.node}:${s.round}:${s.progress ?? 0}`, s }
  } catch { return null }
}

// Only a turn that moved the change (its step differs from the one the turn started on) is continued: a question asked
// mid-change, or an approval turn that has not begun a node, is left alone.
function continueChange(): void {
  const now_ = stepKeyNow()
  if (!now_) return
  const { key, s } = now_
  const slug = s.slug
  if (s.verdict !== 'continue' || !s.node || !AUTO_NODES.has(s.node)) return
  const gate = readGate()
  if (gate.turnStep === undefined || gate.turnStep === key || gate.cont === key) return
  updateGate(g => { g.cont = key })
  out(JSON.stringify({ decision: 'block', reason: `rig: the design is approved, so ${s.node} runs next without waiting for the person. Run \`node --disable-warning=ExperimentalWarning ${process.argv[1]} skill ${s.node} ${slug}\` and follow the printed steps for this node, then stop (the next node is offered when you do).` }))
}

// Subagent lanes, for the work/span/idle numbers. Observational only: they never block and write nothing without an active change.
function laneEvent(input: HookInput, phase: 'start' | 'stop'): void {
  try {
    if (!exists(SDLC)) return
    const slug = activeSlug()
    if (!slug || !exists(path.join(CHANGES, slug))) return
    const id = String(input.agent_id ?? '').slice(0, 80)
    const agent = String(input.agent_type ?? 'unknown').slice(0, 60)
    if (phase === 'start') return appendEvent(slug, { node: 'lane', verdict: 'start', kind: 'lane', agent, id })
    const started = readEvents(slug).findLast(e => e.kind === 'lane' && e.verdict === 'start' && e.id === id)
    appendEvent(slug, { node: 'lane', verdict: 'stop', kind: 'lane', agent, id, ms: started ? Math.max(0, Date.now() - Date.parse(started.at)) || 0 : 0 })
  } catch { /* observational: a failure must never wedge a session */ }
}

const HOOKS: Record<string, (input: HookInput) => void> = {
  'session-start': hookSessionStart,
  'post-edit': hookPostEdit,
  'skill-failed': hookSkillFailed,
  'prompt-submit': i => hookPromptSubmit(i),
  stop: () => { if (!hookStop()) continueChange() },
  'subagent-start': i => laneEvent(i, 'start'),
  'subagent-stop': i => laneEvent(i, 'stop'),
}

// A standalone repo registers its own copy's hooks in .claude/settings.json. The plugin's copy of a hook steps aside only
// when the project registers that same hook, so none runs twice and none is lost; unreadable settings keep the plugin's, and so does
// managed allowManagedHooksOnly, which blocks project hooks (only a force-enabled plugin's hooks run).
type SettingsHooks = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> }
export function runsOwnHook(name: string): boolean {
  if (IS_VENDORED) return false
  // RIG_MANAGED_HOOKS_ONLY is the template's marker for server-managed settings, which are not visible on disk.
  if (process.env.RIG_MANAGED_HOOKS_ONLY === '1' || managedSettings().allowManagedHooksOnly === true) return false
  try {
    const { hooks = {} } = JSON.parse(read(path.join(ROOT, '.claude', 'settings.json')) || '{}') as SettingsHooks
    const own = new RegExp(`\\.rig/bin/sdlc\\.ts"? hook ${name}$`)
    return Object.values(hooks).flat().some(g => g.hooks?.some(h => typeof h.command === 'string' && own.test(h.command.trim())))
  } catch {
    return false
  }
}

export function cmdHook(args: Args): void {
  const handler = HOOKS[args.pos[0] ?? '']
  if (!handler) fail(`unknown hook ${args.pos[0]}`)
  if (runsOwnHook(args.pos[0] ?? '')) return
  handler(readStdin())
}
