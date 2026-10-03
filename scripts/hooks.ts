// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, STATE, USAGE, PLUGIN_ROOT, now, exists, read, out, fail, frontmatter, toPosix, activeSlug, loadChange, nextCommand,
  planFiles, isPlanned, approvalOf, planVerification, EVIDENCE_RE, relPosix, scanSecrets, planProblems, sha, createChange, type Tier, type Args, type HookInput,
} from './core.ts'
import { snapshot, writeBaseline, readBaseline, turnDiff, showAt, diffHash } from './diffs.ts'
import { isProtected, weakensConfig, weakensRules, tierFromDiff } from './sensors.ts'
import { loadConfig, runChecks, editFindings } from './check.ts'
import { formatFindings, isSource, type FileDiff, type Finding, type SensorConfig } from './model.ts'
import { readOnlyDenial, normCmd, tokenize } from './shell.ts'

function readStdin(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') as HookInput
  } catch {
    return {}
  }
}

function decide(decision: 'allow' | 'ask' | 'deny', reason: string): void {
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }))
}

function hookSessionStart(): void {
  if (!exists(SDLC)) return
  const active = activeSlug()
  const c = active ? loadChange(active) : null
  const state = frontmatter(read(STATE)).body.trim().split('\n').slice(0, 15).join('\n')
  const context = [
    'sdlc harness is active in this repo (artifacts in .sdlc/).',
    c ? `Active change: ${c.slug} (${c.type}, tier ${c.tier}). Next: ${nextCommand(c)}` : 'No active change. Start one with /sdlc:start "<request>".',
    `Rules: plans hold interfaces + acceptance tests, never code; delegate searches to sdlc:scout and slices to sdlc:implementer; read .sdlc/approvals.jsonl with the Read tool (only the person writes it); run subagents in the foreground and never end a turn while one is running; never sleep-poll; at ~150k context run /sdlc:handoff. If a /sdlc:* skill fails to load, run \`node "${toPosix(PLUGIN_ROOT)}/scripts/sdlc.ts" skill <stage> <slug>\` and follow it exactly.`,
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
const WRITES = /(?:>|\btee\b|\bsed\s+-i|\b(?:python3?|node|perl|ruby|bash|sh|zsh|pwsh|powershell)\b|\b(?:cp|mv|rm|truncate|dd)\b|\b(?:checkout|restore|reset|apply|stash)\b)/

function rawSafe(cmd: string, ci: boolean): boolean {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .filter(part => evidencePath(part, ci))
    .every(part => SAFE_EVIDENCE_COMMAND.test(part) && !WRITES.test(part.replace(/^\s*git\s+commit\b[^]*?-m\s+(["']).*?\1/, '')))
}

// A segment's dequoted words: git staging/inspection (minus the commit message and --output) or a viewer.
// Redirects other than /dev/null never reach here, because tokenize refuses them.
function wordsSafe(w: string[]): boolean {
  if (w[0] === 'git') {
    const rest = w.slice(2).filter((x, i, a) => !/^(?:-m|--message)$/.test(a[i - 1] ?? '') || w[1] !== 'commit')
    return /^(?:add|commit|status|diff|log|show)$/.test(w[1] ?? '') && !rest.some(x => /^--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(?:=|$)/.test(x))
  }
  return /^(?:cat|head|tail|wc|grep|rg|jq)$/.test(w[0] ?? '')
}

// A write whose target under .sdlc/ holds an unquoted glob (run?.jsonl, run[s].jsonl, approval*.jsonl) can hit evidence.
const WRITE_VERB = /\b(?:tee|cp|mv|dd|install|ln)\b|\bsed\s+-\w*i/
const unquotedGlob = (t: string): boolean => /\.sdlc\//i.test(t) && /[*?[]/.test(t.replace(/"[^"]*"|'[^']*'/g, ''))
export function globWrite(cmd: string): boolean {
  return cmd.split(/&&|\|\||;|\||\n/).some(seg => {
    const targets = [...seg.matchAll(/>>?\s*(\S+)/g)].map(m => m[1] ?? '')
    if (WRITE_VERB.test(seg)) targets.push(...seg.split(/[\s>]+/))
    return targets.some(unquotedGlob)
  })
}

// Quotes and escapes must not hide an evidence path (run"s".jsonl): the raw text and a dequoted form are both checked.
// tokenize gives exact words; where it refuses (substitutions, redirects), quotes and backslashes are simply dropped.
export function isSafeEvidenceCommand(cmd: string, ci = CASE_INSENSITIVE): boolean {
  if (!rawSafe(cmd, ci)) return false
  const { segs, bad } = tokenize(cmd)
  if (bad) return rawSafe(stripQuotes(cmd), ci) && !globWrite(cmd)
  return segs.filter(w => evidencePath(w.join(' '), ci)).every(wordsSafe) && !globWrite(cmd)
}

const dequoted = (cmd: string): string => {
  const { segs, bad } = tokenize(cmd)
  return bad ? stripQuotes(cmd) : segs.map(w => w.join(' ')).join('\n')
}

export const evidencePath = (p: string, ci = CASE_INSENSITIVE): boolean => (ci ? new RegExp(EVIDENCE_RE.source, 'i') : EVIDENCE_RE).test(p)

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

function protectedEditReason(file: string, rel: string, t: HookInput['tool_input']): string {
  const after = proposed(file, t)
  const key = rel.toLowerCase()
  const reasons = after === null ? [] : key === '.sdlc/sensors.json' ? weakensConfig(read(file), after) : key === '.sdlc/rules.json' ? weakensRules(read(file), after) : []
  return reasons.length
    ? `This edit weakens the harness: ${reasons.join('; ')}. Allow it only if you, the person, want this.`
    : `${rel} is part of the harness (peer-reviewed config). Allow this edit?`
}

// A declared consumer is recognised at any depth (../../org/checkout), whether declared relative or absolute.
function consumerFor(rel: string): { name: string } | undefined {
  const norm = (p: string): string => toPosix(path.normalize(path.isAbsolute(p) ? path.relative(ROOT, p) : p)).replace(/\/$/, '')
  return loadConfig().config.consumers.find(c => rel.startsWith(norm(c.path) + '/'))
}

// Outside-repo scope (spec 8.4), deliberately narrowed: a declared consumer follows the impact and plan rules;
// otherwise only ../<dir>/... and ../<file> (the immediate parent) are denied. Paths that escape further
// (../../...) and are no consumer are left to normal permissions, so scratch and temp directories keep working.
function siblingEditReason(rel: string, consumer: { name: string } | undefined): string | null {
  if (!consumer) return `${rel} is outside this repo and not a declared consumer. Edit only this repo.`
  const slug = activeSlug()
  if (!slug || approvalOf(slug, 'impact') !== 'approved') return `${consumer.name} is a consumer repo: edit it only in a change whose cross-repo impact the person approved (/sdlc-approve <slug> impact).`
  if (!isPlanned(rel, planFiles(slug))) return `${rel} is not in ${slug}/plan.md ## Files. Add it to the plan first.`
  return null
}

// Read-only agents (scout, reviewer, verifier) get an allowlist, not a blacklist (scripts/shell.ts): a Bash command
// passes only if it tokenizes cleanly and every segment is a known read-only command.
const READ_ONLY_AGENT = /(?:^|:)(?:scout|reviewer|verifier)$/

// `sdlc.ts run -- "<cmd>"` may only execute a command the plan or sensors.json declares.
function declaredCommands(slug: string | undefined): Set<string> {
  const { config } = loadConfig()
  const s = slug ?? activeSlug()
  return new Set([...(s ? planVerification(s) : []), ...Object.values(config.fast), ...Object.values(config.full)].map(normCmd))
}

function hookPreBash(input: HookInput): void {
  const cmd = String(input.tool_input?.command ?? '')
  if (HUMAN_ONLY.test(cmd) || HUMAN_ONLY.test(dequoted(cmd)) || !isSafeEvidenceCommand(cmd)) {
    return decide('deny', 'Evidence is human- or sdlc-only: approvals and waivers come from the person (/sdlc-approve, /sdlc-waive); runs.jsonl only from `sdlc.ts run`; gate state only from the hooks. Read these files with the Read tool.')
  }
  if (!exists(SDLC)) return
  const agent = input.agent_type ?? ''
  const why = READ_ONLY_AGENT.test(agent) ? readOnlyDenial(cmd, agent, declaredCommands) : null
  if (why) return decide('deny', `${agent} is read-only: ${why}. It reports and never edits; record test runs with sdlc.ts run -- "<declared command>" and leave fixes to the implementer.`)
  const sleep = /(?:^|[;&|]\s*|\s)(?:sleep|Start-Sleep(?:\s+-Seconds)?)\s+(\d+)/i.exec(cmd)
  if (sleep && Number(sleep[1]) >= 30) {
    return decide('deny', 'Do not sleep-poll: background agents and shells notify you when they finish. End the turn or do other useful work.')
  }
}

function hookPreEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '')
  if (!file) return
  if (evidencePath(toPosix(file))) {
    return decide('deny', `${relPosix(file)} is evidence written only by sdlc or the person's commands. Record runs with \`sdlc.ts run -- "<command>"\` and generate verification.md with \`sdlc.ts verify-report <slug>\`.`)
  }
  if (!exists(SDLC)) return
  const rel = relPosix(file)
  if (rel.startsWith('../')) {
    const consumer = consumerFor(rel)
    if (consumer || !rel.startsWith('../../')) {
      const reason = siblingEditReason(rel, consumer)
      if (reason) return decide('deny', reason)
    }
    return
  }
  if (isProtected(rel, CASE_INSENSITIVE)) return decide('ask', protectedEditReason(file, rel, input.tool_input))
  const slug = activeSlug()
  if (!slug) return
  const stage = loadChange(slug).next?.stage
  if (stage !== 'build' && stage !== 'diagnose') return
  const patterns = planFiles(slug)
  if (patterns.length && !isPlanned(file, patterns)) {
    return decide('ask', `${relPosix(file)} is not in ${slug}/plan.md ## Files. Add it to the plan if it belongs to this change, otherwise leave it alone.`)
  }
}

function hookPostEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? '')
  if (!file || !exists(file)) return
  const problems = scanSecrets(file)
  if (exists(SDLC) && /\.sdlc\/changes\/[^/]+\/plan\.md$/.test(toPosix(file))) problems.push(...planProblems(file).map(p => `${file}: ${p}`))
  let edits = ''
  if (exists(SDLC)) {
    const rel = relPosix(file)
    const gate = readGate()
    gate.tool = pushUnique(gate.tool, rel)
    if (input.agent_id) gate.agents[input.agent_id] = pushUnique(gate.agents[input.agent_id] ?? [], rel)
    writeGate(gate)
    edits = formatFindings(editFindings(rel).filter(f => f.severity === 'block' && f.sensor !== 'secrets'))
  }
  if (problems.length || edits) {
    process.stderr.write(`sdlc check failed, fix before continuing:\n${[...problems, edits].filter(Boolean).join('\n')}\n`)
    process.exitCode = 2
  }
}

// A stage skill that fails to load leaves the model to improvise. Hand it the exact instructions instead.
function hookSkillFailed(input: HookInput): void {
  if (!exists(SDLC)) return
  const skill = String(input.tool_input?.skill ?? '')
  const m = /^sdlc:([a-z-]+)$/.exec(skill)
  if (!m) return
  fs.appendFileSync(USAGE, JSON.stringify({ at: now(), kind: 'event', event: 'skill-load-failed', skill }) + '\n')
  const cmd = `node --disable-warning=ExperimentalWarning "${toPosix(PLUGIN_ROOT)}/scripts/sdlc.ts" skill ${m[1]} ${input.tool_input?.args ?? ''}`.trim()
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
    return { ...emptyGate(), ...(JSON.parse(read(GATE)) as Partial<Gate>) }
  } catch {
    return emptyGate()
  }
}
const writeGate = (g: Gate): void => fs.writeFileSync(GATE, JSON.stringify(g))
const pushUnique = (list: string[], item: string): string[] => (list.includes(item) ? list : [...list, item])

function summarize(findings: Finding[]): GateSummary {
  const bySensor: Record<string, number> = {}
  for (const f of findings) bySensor[f.sensor] = (bySensor[f.sensor] ?? 0) + 1
  return { at: now(), blocks: findings.filter(f => f.severity === 'block').length, warns: findings.filter(f => f.severity === 'warn').length, bySensor }
}

function createAdhoc(diffs: FileDiff[], config: SensorConfig): string {
  const tier: Tier = tierFromDiff(diffs, config)
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12)
  let slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}`
  for (let n = 2; exists(path.join(CHANGES, slug)); n++) slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}-${n}`
  createChange(slug, 'chore', tier, 'Ad-hoc change made without /sdlc:start')
  return slug
}

// Each prompt starts a turn: record the tree and reset the per-turn gate, so Stop diffs exactly this turn's changes.
function hookPromptSubmit(): void {
  if (!exists(SDLC)) return
  const snap = snapshot()
  if (!snap) return
  writeBaseline(snap)
  writeGate({ ...readGate(), turn: snap.at, blocks: {}, passed: {}, tool: [], agents: {} })
}

function hookSubagentStart(input: HookInput): void {
  if (!exists(SDLC) || !input.agent_id) return
  const snap = snapshot()
  if (snap) writeBaseline(snap, input.agent_id)
}

// The end-of-turn gate: every built-in sensor on this turn's diff, then the fast commands (main thread only).
function hookStop(input: HookInput, sub: boolean): void {
  if (!exists(SDLC)) return
  const agentId = sub ? input.agent_id : undefined
  const snap = (agentId ? readBaseline(agentId) : null) ?? readBaseline()
  if (!snap) return
  const { config, rules, errors } = loadConfig()
  const gate = readGate()
  const owned = agentId ? new Set(gate.agents[agentId] ?? []) : null
  const diffs = turnDiff(snap).filter(d => (isSource(d.file, config) || isProtected(d.file)) && (!owned || owned.has(d.file)))
  if (!diffs.length) return
  const key = agentId ?? 'main'
  const hash = diffHash(diffs) + sha(read(path.join(SDLC, 'sensors.json')))
  if (gate.passed[key] === hash) return
  let slug = activeSlug()
  if (!slug && !sub) slug = createAdhoc(diffs, config)
  const result = runChecks({
    point: 'stop', diffs, config, rules, slugs: slug ? [slug] : [], commands: sub ? 'none' : 'fast', budgetMs: STOP_BUDGET_MS,
    before: f => showAt(snap.sha, f) ?? '', toolEdited: new Set(gate.tool), base: null,
  })
  const configBlocks: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: '.sdlc/sensors.json', message: e, fix: 'fix the file' }))
  const findings = [...configBlocks, ...result.findings]
  const blocks = findings.filter(f => f.severity === 'block')
  gate.last = summarize(findings)
  if (!blocks.length) {
    gate.passed[key] = hash
    writeGate(gate)
    if (exists(UNRESOLVED)) fs.rmSync(UNRESOLVED)
    return
  }
  fs.writeFileSync(UNRESOLVED, JSON.stringify({ at: now(), slug, findings: blocks }, null, 2) + '\n')
  const attempt = (gate.blocks[key] ?? 0) + 1
  if (attempt > MAX_BLOCKS) {
    writeGate(gate)
    return out(JSON.stringify({ systemMessage: `sdlc quality gate: ${blocks.length} problem(s) unresolved after ${MAX_BLOCKS} attempts (.sdlc/unresolved.json). Ship and CI will refuse until they are fixed or the person waives them.` }))
  }
  gate.blocks[key] = attempt
  writeGate(gate)
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

export function cmdHook(args: Args): void {
  const handler = HOOKS[args.pos[0] ?? '']
  if (!handler) fail(`unknown hook ${args.pos[0]}`)
  handler(readStdin())
}
