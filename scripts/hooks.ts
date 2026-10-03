// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, STATE, USAGE, PLUGIN_ROOT, now, exists, read, out, fail, frontmatter, toPosix, activeSlug, loadChange, nextCommand,
  planFiles, isPlanned, approvalOf, EVIDENCE_RE, relPosix, scanSecrets, planProblems, type Args, type HookInput,
} from './core.ts'
import { snapshot, writeBaseline } from './diffs.ts'
import { isProtected, weakensConfig, weakensRules } from './sensors.ts'
import { loadConfig } from './check.ts'

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

// git (staging, committing, inspecting) and read-only viewers may name evidence; nothing that can write to it may.
const SAFE_EVIDENCE_COMMAND = /^\s*(?:git\s+(?:add|commit|status|diff|log|show)|cat|head|tail|wc|grep|rg|jq)\b/
const HUMAN_ONLY = /sdlc\.(?:m?js|ts)["']?\s+(?:approve|waive)\b/
const WRITES = /(?:>|\btee\b|\bsed\s+-i|\b(?:python3?|node|perl|ruby|bash|sh|zsh|pwsh|powershell)\b|\b(?:cp|mv|rm|truncate|dd)\b|\b(?:checkout|restore|reset|apply|stash)\b)/

function isSafeEvidenceCommand(cmd: string): boolean {
  return cmd
    .split(/&&|\|\||;|\|/)
    .filter(part => EVIDENCE_RE.test(part))
    .every(part => SAFE_EVIDENCE_COMMAND.test(part) && !WRITES.test(part.replace(/^\s*git\s+commit\b[^]*?-m\s+(["']).*?\1/, '')))
}

// macOS and Windows file systems are case-insensitive: .sdlc/Sensors.json is sensors.json there.
const CASE_INSENSITIVE = process.platform !== 'linux'
const evidencePath = (p: string): boolean => (CASE_INSENSITIVE ? new RegExp(EVIDENCE_RE.source, 'i') : EVIDENCE_RE).test(p)

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

const READ_ONLY_AGENT = /(?:^|:)(?:scout|reviewer|verifier)$/
const RECORDER = /sdlc\.ts["']?\s+(run|verify-report|check-file|check|status|diff|skill|scope-drift)\b/
const GIT_WRITES = '(?:add|commit|checkout|restore|reset|apply|stash|push|rebase|merge|cherry-pick|rm|mv|tag|clean|pull)'
const WRITERS = new RegExp(
  [
    '\\btee\\b', '\\b(?:sed|perl)\\s+-i', '\\b(?:cp|mv|rm|rmdir|truncate|dd|touch|mkdir|chmod|ln)\\s', `\\bgit\\s+(?:-C\\s+\\S+\\s+)?${GIT_WRITES}\\b`,
    '\\b(?:npm|pnpm|yarn)\\s+(?:install|i|add|remove|uninstall)\\b', '\\bpip3?\\s+install\\b', '--write\\b', '--fix\\b', '^\\s*(?:sudo\\s+)?patch\\b',
    '\\binstall\\s+-', '\\bcurl\\b[^|;&]*\\s(?:-o|-O|--output)\\b', '\\btar\\s+-?x', '\\bunzip\\b',
  ].join('|'),
)
const INTERPRETER_WRITES = /\b(?:python3?\s+-c|node\s+(?:-e|--eval)|ruby\s+-e|perl\s+-e)\b[^]*(?:write|open\([^)]*['"][wa]|writeFile|appendFile|unlink)/
const unquote = (s: string): string => s.replace(/'[^']*'|"[^"]*"/g, "''")
// Only fd duplication (2>&1) and discarding to /dev/null are not writes; 1>f, 2>f and &>f are.
const hasRedirect = (s: string): boolean => /&?\d*>/.test(unquote(s).replace(/\d*>&\d+|&?\d*>>?\s*\/dev\/null/g, ''))
const writes = (seg: string): boolean => INTERPRETER_WRITES.test(seg) || hasRedirect(seg) || WRITERS.test(unquote(seg))

// Quote-aware split on && || ; | so a separator inside a string does not cut a command in two.
function splitCommand(cmd: string): string[] {
  const parts: string[] = []
  let cur = ''
  let q = ''
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? ''
    if (q) { if (ch === q) q = ''; cur += ch; continue }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue }
    if (ch === ';' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) {
      if (ch !== ';' && cmd[i + 1] === ch) i++
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  return [...parts, cur].filter(p => p.trim())
}

// recorders: status/check/check-file/diff/skill/scope-drift only read; run and verify-report record, for the verifier only,
// and the command that run executes must itself not write.
function segmentWrites(seg: string, agent: string): boolean {
  const m = RECORDER.exec(seg)
  if (!m) return writes(seg)
  if (hasRedirect(seg)) return true
  if (m[1] !== 'run' && m[1] !== 'verify-report') return false
  if (!/(?:^|:)verifier$/.test(agent)) return true
  if (m[1] === 'verify-report') return false
  const inner = /\s--\s+([^]*)$/.exec(seg)?.[1]?.trim().replace(/^(["'])([^]*)\1$/, '$2') ?? ''
  return splitCommand(inner).some(writes)
}

function hookPreBash(input: HookInput): void {
  const cmd = String(input.tool_input?.command ?? '')
  if (HUMAN_ONLY.test(cmd) || (EVIDENCE_RE.test(cmd) && !isSafeEvidenceCommand(cmd))) {
    return decide('deny', 'Evidence is human- or sdlc-only: approvals and waivers come from the person (/sdlc-approve, /sdlc-waive); runs.jsonl only from `sdlc.ts run`; gate state only from the hooks. Read these files with the Read tool.')
  }
  if (!exists(SDLC)) return
  const agent = input.agent_type ?? ''
  if (READ_ONLY_AGENT.test(agent) && splitCommand(cmd).some(seg => segmentWrites(seg, agent))) {
    return decide('deny', `${agent} is read-only: it reports and never edits. Record test runs with sdlc.ts run; leave fixes to the implementer.`)
  }
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
  if (problems.length) {
    process.stderr.write(`sdlc check failed, fix before continuing:\n${problems.join('\n')}\n`)
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

// Each prompt starts a turn: record what the tree looked like, so Stop can diff exactly this turn's changes.
function hookPromptSubmit(): void {
  if (!exists(SDLC)) return
  const snap = snapshot()
  if (snap) writeBaseline(snap)
}

const HOOKS: Record<string, (input: HookInput) => void> = {
  'session-start': hookSessionStart,
  'pre-bash': hookPreBash,
  'pre-edit': hookPreEdit,
  'post-edit': hookPostEdit,
  'skill-failed': hookSkillFailed,
  'prompt-submit': () => hookPromptSubmit(),
}

export function cmdHook(args: Args): void {
  const handler = HOOKS[args.pos[0] ?? '']
  if (!handler) fail(`unknown hook ${args.pos[0]}`)
  handler(readStdin())
}
