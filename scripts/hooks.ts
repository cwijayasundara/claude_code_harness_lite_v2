// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, STATE, USAGE, PLUGIN_ROOT, now, exists, read, out, fail, frontmatter, toPosix, activeSlug, loadChange, nextCommand,
  planFiles, isPlanned, approvalOf, planVerification, EVIDENCE_RE, relPosix, scanSecrets, planProblems, type Args, type HookInput,
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

// macOS and Windows file systems are case-insensitive: .sdlc/Sensors.json is sensors.json there.
const CASE_INSENSITIVE = process.platform !== 'linux'
// git (staging, committing, inspecting) and read-only viewers may name evidence; nothing that can write to it may.
const SAFE_EVIDENCE_COMMAND = /^\s*(?:git\s+(?:add|commit|status|diff|log|show)|cat|head|tail|wc|grep|rg|jq)\b/
const HUMAN_ONLY = /sdlc\.(?:m?js|ts)["']?\s+(?:approve|waive)\b/
const WRITES = /(?:>|\btee\b|\bsed\s+-i|\b(?:python3?|node|perl|ruby|bash|sh|zsh|pwsh|powershell)\b|\b(?:cp|mv|rm|truncate|dd)\b|\b(?:checkout|restore|reset|apply|stash)\b)/

export function isSafeEvidenceCommand(cmd: string, ci = CASE_INSENSITIVE): boolean {
  return cmd
    .split(/&&|\|\||;|\|/)
    .filter(part => evidencePath(part, ci))
    .every(part => SAFE_EVIDENCE_COMMAND.test(part) && !WRITES.test(part.replace(/^\s*git\s+commit\b[^]*?-m\s+(["']).*?\1/, '')))
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

// Read-only agents (scout, reviewer, verifier) get an allowlist, not a blacklist: a Bash command passes only if
// every segment starts with a known read-only command. Anything else is denied, naming the first offender.
const READ_ONLY_AGENT = /(?:^|:)(?:scout|reviewer|verifier)$/
const OK_REDIRECT = /\d*>&\d+(?![^\s;&|])|\d*>>?\s*\/dev\/null(?![^\s;&|])/g

// Follows bash quoting: outside quotes \X is a literal X; in "..." only \" \\ \` \$ escape; '...' has no escapes.
// segs splits on newline, && || ; | and a single & (not the & of 2>&1); bare is the command with quoted text removed.
// ok is false for an unterminated quote or a trailing lone backslash.
function scan(cmd: string): { segs: string[]; bare: string; ok: boolean } {
  const segs: string[] = []
  let cur = ''
  let bare = ''
  let q = ''
  let ok = true
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? ''
    const next = cmd[i + 1] ?? ''
    if (q === "'") { cur += ch; if (ch === "'") q = ''; continue }
    if (q === '"') {
      if (ch === '\\' && /["\\`$]/.test(next)) { cur += ch + next; i++; continue }
      cur += ch
      if (ch === '"') q = ''
      continue
    }
    if (ch === '\\') {
      if (!next) ok = false
      cur += ch + next
      i++
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; bare += "''"; continue }
    if (ch === '&' && cmd[i - 1] === '>') { cur += ch; bare += ch; continue }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      if ((ch === '|' || ch === '&') && next === ch) i++
      segs.push(cur)
      cur = ''
      bare += ' '
      continue
    }
    cur += ch
    bare += ch
  }
  return { segs: [...segs, cur].filter(p => p.trim()), bare, ok: ok && !q }
}

const SIMPLE_READERS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'ls', 'pwd', 'echo', 'printf', 'cut', 'tr', 'diff', 'cmp', 'stat', 'which', 'jq'])
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files', 'rev-parse', 'merge-base', 'describe', 'cat-file'])
const FIND_WRITES = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/
const RECORDER_READS = new Set(['status', 'check', 'check-file', 'diff', 'skill', 'scope-drift'])
const RECORDER_FLAGS = new Set(['--slug', '--json', '--at', '--base', '--expect-fail', '--turn'])
const SED_PRINT = /^['"]?(?:\d+|\$|\/[^/]*\/)?(?:,(?:\d+|\$|\/[^/]*\/))?p['"]?$/
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ')

function gitAllowed(args: string[]): boolean {
  const w = args[0] === '--no-pager' ? args.slice(1) : args
  const [sub = '', arg = ''] = w
  if (w.some(x => /^--(?:output|open-files-in-pager|ext-diff)\b|^-O/.test(x))) return false
  if (sub === 'branch') return w.slice(1).every(f => /^(?:--show-current|-a|-r|--list|-v|-vv)$/.test(f))
  if (sub === 'stash') return arg === 'list'
  if (sub === 'tag') return /^(?:-l|--list)$/.test(arg)
  return GIT_READ.has(sub)
}

// `sdlc.ts run -- "<cmd>"` may only execute a command the plan or sensors.json declares.
function declaredCommands(slug: string | null): Set<string> {
  const { config } = loadConfig()
  return new Set([...(slug ? planVerification(slug) : []), ...Object.values(config.fast), ...Object.values(config.full)].map(norm))
}

function recorderAllowed(w: string[], seg: string, agent: string): string | null {
  const i = w.findIndex(x => /sdlc\.ts["']?$/.test(x))
  const pre = w.slice(0, i)
  if (i < 0 || pre.some(x => !/^--disable-warning=\S+$/.test(x))) return 'sdlc.ts must be the first thing node runs'
  const sub = w[i + 1] ?? ''
  const dd = /\s--\s+([^]*)$/.exec(seg)
  const flags = (dd ? seg.slice(0, dd.index) : seg).split(/\s+/).filter(x => x.startsWith('--') && !x.startsWith('--disable-warning'))
  if (new Set(flags).size !== flags.length) return 'sdlc.ts options may not be repeated'
  if (flags.some(f => !RECORDER_FLAGS.has(f))) return `sdlc.ts option ${flags.find(f => !RECORDER_FLAGS.has(f))} is not allowed`
  if (RECORDER_READS.has(sub)) return null
  if ((sub !== 'run' && sub !== 'verify-report') || /(?:^|:)scout$/.test(agent)) return `sdlc.ts ${sub} is not available to ${agent}`
  if (sub === 'verify-report') return null
  const slug = /--slug\s+(\S+)/.exec(seg)?.[1] ?? activeSlug()
  const cmd = norm((dd?.[1] ?? '').replace(/^(["'])([^]*)\1$/, '$2'))
  return declaredCommands(slug).has(cmd) ? null : `${agent} may only run the project's declared verification commands`
}

// Returns why a single segment is not allowed, or null when it is a known read-only command.
function segmentDenied(seg: string, agent: string): string | null {
  const text = seg.replace(OK_REDIRECT, '').trim()
  const w = text.split(/\s+/)
  const c = w[0] ?? ''
  if (c === 'git') return gitAllowed(w.slice(1)) ? null : 'git is limited to read-only subcommands (diff, log, show, status, ...)'
  if (c === 'node') return recorderAllowed(w.slice(1), text, agent)
  if (c === 'find') return w.some(x => FIND_WRITES.test(x)) ? 'find may not delete or execute' : null
  if (c === 'rg') return w.some(x => x === '--pre' || x.startsWith('--pre=')) ? 'rg --pre runs commands' : null
  if (c === 'sort') return w.some(x => /^-[^-]*o|^--o/.test(x)) ? 'sort -o writes a file' : null
  if (c === 'uniq') return w.slice(1).filter(x => !x.startsWith('-')).length > 1 ? 'uniq with an output file writes' : null
  if (c === 'sed' && w.some(x => /^-[a-zA-Z]*[iefs]|^--(?:in-place|expression|file|separate)/.test(x))) return 'sed may not edit in place or run scripts from options'
  if (c === 'awk' && w.some(x => /^-[a-zA-Z]*[iof]|^--(?:include|dump-variables|profile|file|source)/.test(x))) return 'awk may not write files or load programs'
  if (c === 'sed') return w[1] === '-n' && w.length > 2 && SED_PRINT.test(w[2] ?? '') ? null : 'only sed -n with a print address is read-only'
  if (c === 'awk') return /[>|]|system\s*\(|getline/.test(text) ? 'awk programs may not write or run commands' : null
  return SIMPLE_READERS.has(c) ? null : `${c || 'this command'} is not on the read-only allowlist`
}

function readOnlyDenial(cmd: string, agent: string): string | null {
  if (/\$\(|`|<<|[<>]\(/.test(cmd)) return 'command substitution, here-docs and process substitution are not allowed'
  const { segs, bare, ok } = scan(cmd)
  if (!ok) return 'unterminated quote or trailing backslash'
  if (/>/.test(bare.replace(OK_REDIRECT, ''))) return 'output redirects are not allowed (only 2>&1 and > /dev/null)'
  for (const seg of segs) {
    const why = segmentDenied(seg, agent)
    if (why) return `"${seg.trim().slice(0, 60)}": ${why}`
  }
  return null
}

function hookPreBash(input: HookInput): void {
  const cmd = String(input.tool_input?.command ?? '')
  if (HUMAN_ONLY.test(cmd) || (evidencePath(cmd) && !isSafeEvidenceCommand(cmd))) {
    return decide('deny', 'Evidence is human- or sdlc-only: approvals and waivers come from the person (/sdlc-approve, /sdlc-waive); runs.jsonl only from `sdlc.ts run`; gate state only from the hooks. Read these files with the Read tool.')
  }
  if (!exists(SDLC)) return
  const agent = input.agent_type ?? ''
  const why = READ_ONLY_AGENT.test(agent) ? readOnlyDenial(cmd, agent) : null
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
