// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, git, CHANGES, STATE, USAGE, PLUGIN_ROOT, IS_VENDORED, skillRef, agentRef, now, exists, read, out, fail, frontmatter, toPosix,
  planFiles, planName, planApproved, isPlanned, approvalOf, planVerification, EVIDENCE_RE, EVIDENCE_NAME_RE, relPosix, scanSecrets, planProblems, sha, createChange, withLock, writeAtomic, type Tier, type Args, type HookInput,
} from './core.ts'
import { activeSlug, loadChange, nextCommand, createAdhoc } from './graph.ts'
import { snapshot, writeBaseline, readBaseline, turnDiff, showAt, diffHash } from './diffs.ts'
import { isProtected, weakensConfig, weakensRules, tierFromDiff } from './sensors.ts'
import { loadConfig, runChecks, editFindings, consumerFor } from './check.ts'
import { formatFindings, isSource, isTest, matchesAny, parseConfig, type FileDiff, type Finding, type SensorConfig } from './model.ts'
import { readOnlyDenial, normCmd } from './shell.ts'
import { autoApprove } from './autoapprove.ts'

function readStdin(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') as HookInput
  } catch {
    return {}
  }
}

function respond(o: { decision?: 'allow' | 'ask' | 'deny'; reason?: string; context?: string }): void {
  if (!o.decision && !o.context) return
  const h: Record<string, unknown> = { hookEventName: 'PreToolUse' }
  if (o.decision) {
    h.permissionDecision = o.decision
    h.permissionDecisionReason = o.reason
  }
  if (o.context) h.additionalContext = o.context
  out(JSON.stringify({ hookSpecificOutput: h }))
}
const decide = (decision: 'allow' | 'ask' | 'deny', reason: string, context?: string): void => respond({ decision, reason, context })

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

// Progressive disclosure: a guide enters the context the first time this session touches a matching file.
function guidesFor(rel: string, session: string): string | undefined {
  const { config } = loadConfig()
  const seen = readGate().guides[session] ?? []
  const fresh = listGuides(config).filter(g => !seen.includes(g.name) && matchesAny(rel, g.globs) && (!g.sourceOnly || (isSource(rel, config) && !isTest(rel, config))))
  if (!fresh.length) return undefined
  updateGate(g => { g.guides[session] = [...(g.guides[session] ?? seen), ...fresh.map(f => f.name)] })
  return fresh.map(g => g.body).join('\n\n')
}

export const ROUTING_LINE = `sdlc routes all work in this repo: start with ${skillRef('start')}; use superpowers skills only when an sdlc skill names one.`

function hookSessionStart(input: HookInput): void {
  if (!exists(SDLC)) return
  if (input.source === 'compact' || input.source === 'clear') {
    updateGate(g => { delete g.guides[input.session_id ?? 'default'] })
  }
  const cfg = loadConfig().config
  const guides = listGuides(cfg).map(g => g.name)
  const wikiMissing = !exists(path.join(ROOT, 'docs/wiki')) && (git(['ls-files']) ?? '').split('\n').some(f => isSource(f, cfg))
  const active = activeSlug()
  const c = active ? loadChange(active) : null
  const state = frontmatter(read(STATE)).body.trim().split('\n').slice(0, 15).join('\n')
  const context = [
    'sdlc harness is active in this repo (artifacts in .sdlc/).',
    ROUTING_LINE,
    c ? `Active change: ${c.slug} (${c.type}, tier ${c.tier}). Next: ${nextCommand(c)}` : `No active change. Start one with ${skillRef('start')} "<request>".`,
    `Rules: plans hold interfaces + acceptance tests, never code; delegate searches to ${agentRef('scout')} and slices to ${agentRef('implementer')}; read .sdlc/approvals.jsonl with the Read tool (only the person writes it); run subagents in the foreground and never end a turn while one is running; never sleep-poll; at ~150k context run /compact (the active change lives in .sdlc/STATE.md). If an sdlc skill fails to load, run \`node "${SCRIPT()}" skill <stage> <slug>\` and follow it exactly.`,
    wikiMissing ? `No code wiki yet: ${skillRef('wiki')} builds it.` : '',
    guides.length ? `Guides (injected when you first touch matching files): ${guides.join(', ')}` : '',
    state && state !== '# State' ? `STATE.md:\n${state}` : '',
  ].filter(Boolean)
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } }))
}

// macOS and Windows file systems are case-insensitive: .sdlc/Sensors.json is sensors.json there.
const CASE_INSENSITIVE = process.platform !== 'linux'
// git (staging, committing, inspecting) and read-only viewers may name evidence; nothing that can write to it may.
// $'x' and $"x" are quote forms too: drop the $, then the quotes and escapes.
const stripQuotes = (cmd: string): string => cmd.replace(/\$(?=["'])/g, '').replace(/["'\\]/g, '')
const SAFE_EVIDENCE_COMMAND = /^\s*(?:git\s+(?:add|commit|status|diff|log|show)|cat|head|tail|wc|grep|rg|jq)\b/
const HUMAN_ONLY = /sdlc\.(?:m?js|ts)["']?\s+(?:approve|waive)\b/
// Refuse an expansion in the env-var name or subcommand slot (SDLC_${e}HUMAN=1, `sdlc.ts $a`, eval); CI is the real boundary.
const OBFUSCATED_HUMAN = /SDLC_[^\s=]*[$`{*?[]|sdlc\.(?:m?js|ts)["']?\s+(?:--\S+\s+)*[$`]|\beval\b[^]*sdlc\.(?:m?js|ts)/i
const WRITES = /(?:>|\btee\b|\bsed\s+-i|\b(?:python3?|node|perl|ruby|bash|sh|zsh|pwsh|powershell)\b|\b(?:cp|mv|rm|truncate|dd)\b|\b(?:checkout|restore|reset|apply|stash)\b)/

// git can write a file (--output and its abbreviations, -o) or run a program (--ext-diff, --textconv) without a shell redirect.
const abbreviates = (tok: string, full: string, min: number): boolean => tok.length >= min && full.startsWith(tok)
function gitWrites(part: string): boolean {
  if (!/^\s*git\b/.test(part)) return false
  return part.trim().split(/\s+/).some(tok => {
    const name = tok.split('=')[0] ?? ''
    if (/^-[^-]*o/.test(tok)) return true
    return name.startsWith('--') && (abbreviates(name, '--output', 3) || abbreviates(name, '--ext-diff', 4) || abbreviates(name, '--textconv', 4))
  })
}

// Once a command mentions .sdlc anywhere (a cd into it), a bare pr.md, verification.md or impact.json names evidence too.
const BARE_EVIDENCE = /(?<![\w.-])(?:pr\.md|verification\.md|impact\.json)(?![\w.-])/
function rawSafe(cmd: string, ci: boolean): boolean {
  const inSdlc = flagged(/\.sdlc/, ci).test(cmd)
  const parts = cmd.replace(/>\|/g, '>').split(/&&|\|\||;|\||\n/)
  // A glob, brace, variable or substitution can name evidence without spelling it (rm rat*, > ratchet.jso{n,}): once .sdlc is mentioned, a writing part may not use one.
  if (inSdlc && parts.some(part => /[*?[\]{}$`]/.test(part) && WRITES.test(part))) return false
  return parts
    .filter(part => evidencePath(part, ci, true) || (inSdlc && flagged(BARE_EVIDENCE, ci).test(part)))
    .every(part => {
      const bare = part.replace(/^\s*git\s+commit\b[^]*?-m\s+(["']).*?\1/, '')
      return SAFE_EVIDENCE_COMMAND.test(part) && !WRITES.test(bare) && !gitWrites(bare)
    })
}

// Best-effort (spec v0.3 §5): CI is the trust boundary. A command naming evidence may only stage, inspect or view it.
export function isSafeEvidenceCommand(cmd: string, ci = CASE_INSENSITIVE): boolean {
  return rawSafe(cmd, ci) && rawSafe(stripQuotes(cmd), ci)
}

// Edit/Write: the target's real path (symlinked parents resolved) must not be evidence inside the real .sdlc.
// A project's own data/approvals.jsonl is fine.
const EVIDENCE_IN_SDLC = /^(?:approvals\.jsonl|waivers\.jsonl|usage\.jsonl|\.baseline|\.gate|unresolved\.json|learn\/(?:proposals|auto)\.json|changes\/[^/]+\/(?:runs\.jsonl|verification\.md|impact\.json|ratchet\.json|events\.jsonl|pr\.md|ship\.json))$/
function realPath(p: string): string {
  let dir = p
  const rest: string[] = []
  while (!exists(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir))
    dir = path.dirname(dir)
  }
  try {
    return path.join(fs.realpathSync.native(dir), ...rest) // native: on-disk casing, so .SDLC resolves to .sdlc
  } catch {
    return p
  }
}
export function isEvidenceFile(file: string, ci = CASE_INSENSITIVE): boolean {
  const fold = (p: string): string => (ci ? p.toLowerCase() : p)
  const target = realPath(path.resolve(ROOT, file))
  const inSdlc = toPosix(path.relative(fold(realPath(SDLC)), fold(target)))
  if (!inSdlc.startsWith('../') && !path.isAbsolute(inSdlc) && flagged(EVIDENCE_IN_SDLC, ci).test(inSdlc)) return true
  return false
}

const flagged = (re: RegExp, ci: boolean): RegExp => (ci ? new RegExp(re.source, 'i') : re)
export const evidencePath = (p: string, ci = CASE_INSENSITIVE, loose = false): boolean => flagged(EVIDENCE_RE, ci).test(p) || (loose && flagged(EVIDENCE_NAME_RE, ci).test(p))

const replaceOnce = (text: string, o: string, n: string, all?: boolean): string => (all ? text.split(o).join(n) : text.replace(o, () => n))

// The text a Write/Edit/MultiEdit would leave behind, so a weakening is shown before it happens.
function proposed(file: string, t: HookInput['tool_input']): string | null {
  if (typeof t?.content === 'string') return t.content
  if (Array.isArray(t?.edits)) {
    return t.edits.reduce((text, e) => (typeof e.old_string === 'string' && typeof e.new_string === 'string' ? replaceOnce(text, e.old_string, e.new_string, e.replace_all) : text), read(file))
  }
  if (typeof t?.old_string !== 'string' || typeof t?.new_string !== 'string') return null
  return replaceOnce(read(file), t.old_string, t.new_string, t.replace_all)
}

// Onboarding creates CLAUDE.md, sensors.json and rules.json. A new one that is no weaker than the defaults needs no
// prompt; any change to an existing harness file, and any other new harness file (e.g. .claude/settings.json), asks.
function safeCreation(file: string, rel: string, t: HookInput['tool_input']): boolean {
  // First-time only: absent on disk AND in HEAD, so deleting a committed harness file cannot reopen it.
  const inHead = (git(['ls-tree', '-r', '--name-only', 'HEAD']) ?? '').toLowerCase().split('\n').includes(toPosix(rel).toLowerCase())
  if (exists(file) || inHead) return false
  const key = rel.toLowerCase()
  if (key === 'claude.md') return true
  const after = proposed(file, t)
  if (after === null) return false
  if (key === '.sdlc/sensors.json') return !parseConfig(after).errors.length && !weakensConfig('{}', after).length
  if (key === '.sdlc/rules.json') return weakensRules('[]', after).length === 0
  return false
}

function protectedEditReason(file: string, rel: string, t: HookInput['tool_input']): string {
  const after = proposed(file, t)
  const key = rel.toLowerCase()
  const invalid = after !== null && key === '.sdlc/sensors.json' ? parseConfig(after).errors : []
  const shape = '{ "fast": { "test": "<cmd>" }, "full": { "test": "<cmd>" } }'
  if (invalid.length) return `The new .sdlc/sensors.json is invalid: ${invalid.join('; ')}. Use the shape ${shape}.`
  const reasons = after === null ? [] : key === '.sdlc/sensors.json' ? weakensConfig(read(file), after) : key === '.sdlc/rules.json' ? weakensRules(read(file), after) : []
  return reasons.length
    ? `This edit weakens the harness: ${reasons.join('; ')}. Allow it only if you, the person, want this.`
    : `${rel} is part of the harness (peer-reviewed config). Allow this edit?`
}

// Outside-repo scope (spec 8.4), deliberately narrowed: a declared consumer follows the impact and plan rules;
// otherwise only ../<dir>/... and ../<file> (the immediate parent) are denied. Paths that escape further
// (../../...) and are no consumer are left to normal permissions, so scratch and temp directories keep working.
function siblingEditReason(rel: string, consumer: { name: string } | undefined): string | null {
  if (!consumer) return `${rel} is outside this repo and not a declared consumer. Edit only this repo.`
  const slug = activeSlug()
  if (!slug || approvalOf(slug, 'impact') !== 'approved') return `${consumer.name} is a consumer repo: edit it only in a change whose cross-repo impact the person approved (/rig-approve <slug> impact).`
  if (!isPlanned(rel, planFiles(slug))) return `${rel} is not in ${slug}/${planName(slug)} ## Files. Add it to the plan first.`
  return null
}

// Read-only agents (scout, reviewer, verifier) get an allowlist, not a blacklist (scripts/shell.ts): a Bash command
// passes only if it tokenizes cleanly and every segment is a known read-only command.
// The sdlc script as the model should call it: the plugin's copy, or the project's own in a standalone repo.
const SCRIPT = () => (IS_VENDORED ? '.sdlc/bin/sdlc.ts' : `${toPosix(PLUGIN_ROOT)}/scripts/sdlc.ts`)
const READ_ONLY_AGENT = /(?:^|[:-])(?:scout|reviewer|verifier)$/

// `sdlc.ts run -- "<cmd>"` may only execute a command the plan or sensors.json declares.
function declaredCommands(slug: string | undefined): Set<string> {
  const { config } = loadConfig()
  const s = slug ?? activeSlug()
  const cmds = [...(s ? planVerification(s) : []), ...Object.values(config.fast), ...Object.values(config.full), ...Object.values(config.levels), ...Object.values(config.quality).map(q => q.cmd)]
  return new Set(cmds.map(normCmd))
}

function hookPreBash(input: HookInput): void {
  if (!exists(SDLC)) return
  const cmd = String(input.tool_input?.command ?? '')
  // Only the person's mod commands set SDLC_HUMAN; the model never names it, however the command is spelled.
  const plain = stripQuotes(cmd)
  if (/SDLC_HUMAN/i.test(plain) || HUMAN_ONLY.test(plain) || OBFUSCATED_HUMAN.test(plain) || !isSafeEvidenceCommand(cmd)) {
    return decide('deny', 'Evidence is human- or rig-only: approvals and waivers come from the person (/rig-approve, /rig-waive); '
      + 'runs.jsonl only from `sdlc.ts run`. Read these files with the Read tool.')
  }
  const agent = input.agent_type ?? ''
  const why = READ_ONLY_AGENT.test(agent) ? readOnlyDenial(cmd, agent, declaredCommands, input.cwd) : null
  if (why) return decide('deny', `${agent} is read-only: ${why}. It reports and never edits; record test runs with sdlc.ts run -- "<declared command>" and leave fixes to the implementer.`)
  const allowed = autoApprove(input, 'bash')
  if (allowed) decide('allow', allowed)
}

function allowOrContext(input: HookInput, context: string | undefined): void {
  const allowed = autoApprove(input, 'edit')
  if (allowed) decide('allow', allowed, context)
  else respond({ context })
}

function hookPreEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '')
  if (!file || !exists(SDLC)) return
  if (isEvidenceFile(file)) {
    return decide('deny', `${relPosix(file)} is evidence written only by sdlc or the person's commands. Record runs with \`sdlc.ts run -- "<command>"\` and generate verification.md with \`sdlc.ts verify-report <slug>\`.`)
  }
  const rel = relPosix(file)
  if (rel.startsWith('../')) {
    const consumer = consumerFor(rel)
    if (consumer || !rel.startsWith('../../')) {
      const reason = siblingEditReason(rel, consumer)
      if (reason) return decide('deny', reason)
    }
    return
  }
  const context = guidesFor(rel, input.session_id ?? 'default')
  if (isProtected(rel, CASE_INSENSITIVE) && !safeCreation(file, rel, input.tool_input)) {
    return decide('ask', protectedEditReason(file, rel, input.tool_input), context)
  }
  if (rel.startsWith('.superpowers/sdd/')) return respond({ context }) // SDD's gitignored ledger, briefs and reports
  const slug = activeSlug()
  if (!slug) return respond({ context })
  const change = loadChange(slug)
  const stage = change.next?.stage
  const { config } = loadConfig()
  if ((change.type === 'bugfix' || change.type === 'incident') && change.tier === 'L' && (stage === 'plan' || !planApproved(slug))
    && isSource(rel, config) && !isTest(rel, config)) {
    const why = `${rel}: tier L bug fixes wait for the person to approve plan.md (root cause and fix). `
    return decide('ask', `${why}Write the failing test now; fix after /rig-approve ${slug} plan.`, context)
  }
  if (stage !== 'build' && stage !== 'diagnose') return allowOrContext(input, context)
  const patterns = planFiles(slug)
  if (patterns.length && !isPlanned(file, patterns)) {
    return decide('ask', `${relPosix(file)} is not in ${slug}/${planName(slug)} ## Files. Add it to the plan if it belongs to this change, otherwise leave it alone.`, context)
  }
  allowOrContext(input, context)
}

function hookPostEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? '')
  if (!file || !exists(file)) return
  const problems = scanSecrets(file)
  if (exists(SDLC) && /\.sdlc\/changes\/[^/]+\/(?:plan|design)\.md$/.test(toPosix(file))) problems.push(...planProblems(file).map(p => `${file}: ${p}`))
  let edits = ''
  if (exists(SDLC)) {
    const rel = relPosix(file)
    updateGate(g => {
      g.tool = pushUnique(g.tool, rel)
      if (input.agent_id) g.agents[input.agent_id] = pushUnique(g.agents[input.agent_id] ?? [], rel)
    })
    edits = formatFindings(editFindings(rel).filter(f => f.severity === 'block' && f.sensor !== 'secrets'))
  }
  if (problems.length || edits) {
    process.stderr.write(`sdlc check failed, fix before continuing:\n${[...problems, edits].filter(Boolean).join('\n')}\n`)
    process.exitCode = 2
  }
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

export type GateSummary = { at: string; blocks: number; warns: number; bySensor: Record<string, number> }
export type Gate = { turn: string; blocks: Record<string, number>; passed: Record<string, string>; tool: string[]; agents: Record<string, string[]>; guides: Record<string, string[]>; last?: GateSummary }

const GATE = path.join(SDLC, '.gate')
const UNRESOLVED = path.join(SDLC, 'unresolved.json')
const MAX_BLOCKS = 2
const STOP_BUDGET_MS = 60_000
const emptyGate = (): Gate => ({ turn: '', blocks: {}, passed: {}, tool: [], agents: {}, guides: {} })

export function readGate(): Gate {
  try {
    const g = JSON.parse(read(GATE)) as Record<string, unknown>
    const d = emptyGate()
    const obj = <T>(v: unknown, dflt: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : dflt)
    return {
      turn: typeof g.turn === 'string' ? g.turn : d.turn, blocks: obj(g.blocks, d.blocks), passed: obj(g.passed, d.passed),
      tool: Array.isArray(g.tool) ? g.tool.map(String) : d.tool, agents: obj(g.agents, d.agents), guides: obj(g.guides, d.guides),
      ...(g.last && typeof g.last === 'object' ? { last: g.last as GateSummary } : {}),
    }
  } catch {
    return emptyGate()
  }
}
const writeGate = (g: Gate): void => writeAtomic(GATE, JSON.stringify(g))
const updateGate = (fn: (g: Gate) => void): void => withLock(GATE, () => { const g = readGate(); fn(g); writeGate(g) })
const pushUnique = (list: string[], item: string): string[] => (list.includes(item) ? list : [...list, item])

function summarize(findings: Finding[]): GateSummary {
  const bySensor: Record<string, number> = {}
  for (const f of findings) bySensor[f.sensor] = (bySensor[f.sensor] ?? 0) + 1
  return { at: now(), blocks: findings.filter(f => f.severity === 'block').length, warns: findings.filter(f => f.severity === 'warn').length, bySensor }
}

// Each prompt starts a turn: record the tree and reset the per-turn gate, so Stop diffs exactly this turn's changes.
function hookPromptSubmit(): void {
  if (!exists(SDLC)) return
  const snap = snapshot()
  if (snap) writeBaseline(snap)
  updateGate(g => Object.assign(g, { turn: snap?.at ?? now(), blocks: {}, passed: {}, tool: [], agents: {} }))
}

function hookSubagentStart(input: HookInput): void {
  if (!exists(SDLC) || !input.agent_id) return
  const snap = snapshot()
  if (snap) writeBaseline(snap, input.agent_id)
}

// The end-of-turn gate: every built-in sensor on this turn's diff, then the fast commands (main thread only).
function hookStop(input: HookInput, sub: boolean): void {
  if (!exists(SDLC) || (sub && !input.agent_id)) return
  const agentId = sub ? input.agent_id : undefined
  const snap = (agentId ? readBaseline(agentId) : null) ?? readBaseline()
  if (!snap) return
  const { config, rules, errors } = loadConfig()
  const gate = readGate()
  const owned = agentId ? new Set(gate.agents[agentId] ?? []) : null
  const diffs = turnDiff(snap).filter(d => (isSource(d.file, config) || isProtected(d.file)) && (!owned || owned.has(d.file)))
  if (!diffs.length) return
  const key = agentId ?? 'main'
  const hash = diffHash(diffs) + sha(read(path.join(SDLC, 'sensors.json')) + read(path.join(SDLC, 'rules.json')))
  if (gate.passed[key] === hash) return
  let slug = activeSlug()
  // A turn that shipped (its commits add a change's ship.json) is recorded already; any other commit is still ad hoc.
  const shipped = (git(['diff', '--name-only', snap.sha, 'HEAD']) ?? '').split('\n').some(f => /^\.sdlc\/changes\/[^/]+\/ship\.json$/.test(f))
  // Harness files alone (onboarding writes CI workflows and settings) are not ad-hoc work.
  if (!slug && !sub && !shipped && diffs.some(d => isSource(d.file, config) && !isProtected(d.file))) slug = createAdhoc(tierFromDiff(diffs, config))
  const result = runChecks({
    point: 'stop', diffs, config, rules, slugs: slug ? [slug] : [], commands: sub ? 'none' : 'fast', budgetMs: STOP_BUDGET_MS,
    before: f => showAt(snap.sha, f) ?? '', toolEdited: new Set(gate.tool), base: null, ratchet: !sub,
  })
  const configBlocks: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: '.sdlc/sensors.json', message: e, fix: 'fix the file' }))
  const findings = [...configBlocks, ...result.findings]
  const blocks = findings.filter(f => f.severity === 'block')
  gate.last = summarize(findings)
  // Write back only what this hook owns: edits recorded while the checks ran must survive.
  const save = (): void => updateGate(g => { g.last = gate.last; if (gate.passed[key]) g.passed[key] = gate.passed[key]; if (gate.blocks[key]) g.blocks[key] = gate.blocks[key] })
  if (!blocks.length) {
    gate.passed[key] = hash
    save()
    if (!sub && exists(UNRESOLVED)) fs.rmSync(UNRESOLVED)
    return
  }
  if (!sub) fs.writeFileSync(UNRESOLVED, JSON.stringify({ at: now(), slug, findings: blocks }, null, 2) + '\n')
  const attempt = (gate.blocks[key] ?? 0) + 1
  if (attempt > MAX_BLOCKS) {
    save()
    return out(JSON.stringify({ systemMessage: `sdlc quality gate: ${blocks.length} problem(s) unresolved after ${MAX_BLOCKS} attempts (.sdlc/unresolved.json). Ship and CI will refuse until they are fixed or the person waives them.` }))
  }
  gate.blocks[key] = attempt
  save()
  out(JSON.stringify({ decision: 'block', reason: `sdlc quality gate (attempt ${attempt}/${MAX_BLOCKS}): fix these before you finish.\n${formatFindings(findings)}` }))
}

const HOOKS: Record<string, (input: HookInput) => void> = {
  'session-start': hookSessionStart,
  'pre-bash': hookPreBash,
  'pre-edit': hookPreEdit,
  'post-edit': hookPostEdit,
  'skill-failed': hookSkillFailed,
  'prompt-submit': () => hookPromptSubmit(),
  'subagent-start': hookSubagentStart,
  stop: i => hookStop(i, false),
  'subagent-stop': i => hookStop(i, true),
}

// A standalone repo registers its own copy's hooks in .claude/settings.json. The plugin's copy of a hook steps aside only
// when the project registers that same hook, so none runs twice and none is lost; unreadable settings keep the plugin's.
type SettingsHooks = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> }
export function runsOwnHook(name: string): boolean {
  if (IS_VENDORED) return false
  try {
    const { hooks = {} } = JSON.parse(read(path.join(ROOT, '.claude', 'settings.json')) || '{}') as SettingsHooks
    const own = new RegExp(`\\.sdlc/bin/sdlc\\.ts"? hook ${name}$`)
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
