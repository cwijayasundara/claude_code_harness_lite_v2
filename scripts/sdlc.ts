#!/usr/bin/env node
// sdlc — the deterministic core of the sdlc plugin. Zero dependencies.
// Runs directly with Node >= 22.18 (built-in TypeScript type stripping) on macOS, Linux and Windows:
//   node --disable-warning=ExperimentalWarning scripts/sdlc.ts <command>
// Everything the model must not judge for itself lives here: change state,
// approvals, scope drift, secret scanning, hook decisions and metrics.
// Only erasable TypeScript syntax is used (no enums, namespaces or parameter properties).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// ---------- types ----------

type ChangeType = 'greenfield' | 'feature' | 'bugfix' | 'incident' | 'refactor' | 'migration' | 'chore' | 'spike'
type Tier = 'S' | 'M' | 'L'
type Stage = 'intent' | 'spec' | 'plan' | 'build' | 'diagnose' | 'verify' | 'review' | 'ship' | 'notes'
type GatedStage = 'intent' | 'spec' | 'plan'
type ApprovalState = 'approved' | 'stale' | 'missing'
type Fields = Record<string, string>

type Next = { stage: Stage; kind: 'work' } | { stage: Stage; kind: 'approve'; state: ApprovalState }

type Change = {
  slug: string
  dir: string
  type: ChangeType
  tier: Tier
  stages: Stage[]
  gates: GatedStage[]
  next: Next | null
  intent: Fields
  verification: Fields
  review: Fields
}

type Approval = { slug: string; stage: string; by: string; at: string; digest: string }

type UsageRow = {
  at: string
  kind: 'main' | 'agent'
  change: string | null
  stage: string | null
  model?: string | null
  agentType?: string
  in?: number
  out?: number
  cr?: number
  cw?: number
  usd?: number
  ctx?: number
}

type Args = { pos: string[]; opt: Record<string, string | true> }
type Metric = { value: number | null; n: number; note?: string; [extra: string]: unknown }
type HookInput = { tool_input?: { command?: string; file_path?: string; notebook_path?: string } }
type PullRequest = {
  number: number
  createdAt: string
  mergedAt: string | null
  body?: string
  reviews?: { submittedAt?: string }[]
  statusCheckRollup?: { conclusion?: string | null; state?: string | null }[]
}

// ---------- constants ----------

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const SDLC = path.join(ROOT, '.sdlc')
const CHANGES = path.join(SDLC, 'changes')
const APPROVALS = path.join(SDLC, 'approvals.jsonl')
const STATE = path.join(SDLC, 'STATE.md')
const USAGE = path.join(SDLC, 'usage.jsonl')

const LIMITS = { intentLines: 40, specLines: 150, planLines: 120, planCodeBlockLines: 10, stateLines: 40 }
const MIN_SAMPLE = 5
const SOFT_HOOK_FAILURE = 'sdlc hook error (ignored)'

// Stage paths per change type. A stage is done when its artifact exists (see isDone).
const PATHS: Record<ChangeType, Stage[]> = {
  greenfield: ['intent', 'spec', 'plan', 'build', 'verify', 'review', 'ship'],
  feature: ['intent', 'spec', 'plan', 'build', 'verify', 'review', 'ship'],
  bugfix: ['intent', 'diagnose', 'verify', 'review', 'ship'],
  incident: ['intent', 'diagnose', 'verify', 'review', 'ship'],
  refactor: ['intent', 'plan', 'build', 'verify', 'review', 'ship'],
  migration: ['intent', 'plan', 'build', 'verify', 'review', 'ship'],
  chore: ['intent', 'build', 'verify', 'ship'],
  spike: ['intent', 'notes'],
}
// Human gates per tier; greenfield is always gated like L.
const GATES: Record<Tier, GatedStage[]> = { S: [], M: ['plan'], L: ['spec', 'plan'] }
// Tier S is the fast path: no spec, and review folds into ship (one /code-review pass).
const SKIPPED_FOR_S = new Set<Stage>(['spec', 'review'])
const SKIPPED_FOR_M = new Set<Stage>(['spec'])
const ARTIFACTS: Partial<Record<Stage, string>> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', notes: 'notes.md' }

const isChangeType = (v: string | undefined): v is ChangeType => v !== undefined && v in PATHS
const isTier = (v: string | undefined): v is Tier => v !== undefined && v in GATES

// ---------- small helpers ----------

const exists = (p: string): boolean => fs.existsSync(p)
// Line endings are normalised so CRLF checkouts on Windows parse and digest the same as on macOS.
const read = (p: string): string => (exists(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '')
const lines = (text: string): number => (text ? text.split('\n').length : 0)
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
const now = (): string => new Date().toISOString()
const toPosix = (p: string): string => p.replace(/\\/g, '/')
const out = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

function fail(message: string, code = 1): never {
  process.stderr.write(message + '\n')
  process.exit(code)
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function frontmatter(text: string): { data: Fields; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { data: {}, body: text }
  const data: Fields = {}
  for (const row of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(row)
    if (kv?.[1]) data[kv[1]] = (kv[2] ?? '').replace(/^["']|["']$/g, '').trim()
  }
  return { data, body: text.slice(m[0].length) }
}

// Reads frontmatter fields, falling back to `key: value` lines in the body for fields the model wrote there instead.
function reportFields(text: string, keys: string[]): Fields {
  const { data, body } = frontmatter(text)
  for (const key of keys) {
    if (data[key]) continue
    const m = new RegExp(`^\\s*\\**${key}\\**\\s*:\\s*\\**\\s*([\\w-]+)`, 'mi').exec(body)
    if (m?.[1]) data[key] = m[1].toLowerCase()
  }
  return data
}

function readJsonl<T>(p: string): T[] {
  return read(p)
    .split('\n')
    .filter(Boolean)
    .flatMap(row => {
      try {
        return [JSON.parse(row) as T]
      } catch {
        return []
      }
    })
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = []
  const opt: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) opt[a.slice(2)] = true
      else {
        opt[a.slice(2)] = next
        i++
      }
    } else pos.push(a)
  }
  return { pos, opt }
}

const optString = (args: Args, key: string): string | undefined => {
  const v = args.opt[key]
  return typeof v === 'string' ? v : undefined
}

// ---------- changes ----------

function listChanges(): string[] {
  if (!exists(CHANGES)) return []
  return fs
    .readdirSync(CHANGES, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
}

function activeSlug(): string | null {
  const { data } = frontmatter(read(STATE))
  if (data.change && exists(path.join(CHANGES, data.change))) return data.change
  const byMtime = listChanges()
    .map(slug => ({ slug, t: fs.statSync(path.join(CHANGES, slug)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return byMtime[0]?.slug ?? null
}

function loadChange(slug: string): Change {
  const dir = path.join(CHANGES, slug)
  const intent = frontmatter(read(path.join(dir, 'intent.md'))).data
  const type: ChangeType = isChangeType(intent.type) ? intent.type : 'feature'
  const tier: Tier = isTier(intent.tier) ? intent.tier : 'M'
  const verification = reportFields(read(path.join(dir, 'verification.md')), ['result'])
  const review = reportFields(read(path.join(dir, 'review.md')), ['result', 'rounds', 'caught'])
  let stages = PATHS[type]
  if (tier === 'S' && type !== 'greenfield') stages = stages.filter(s => !SKIPPED_FOR_S.has(s))
  if (type === 'feature' && tier === 'M') stages = stages.filter(s => !SKIPPED_FOR_M.has(s))
  const gates = type === 'greenfield' ? GATES.L : GATES[tier]
  const approvals = readJsonl<Approval>(APPROVALS).filter(a => a.slug === slug)

  const approvalState = (stage: Stage): ApprovalState => {
    const latest = approvals.filter(a => a.stage === stage).at(-1)
    if (!latest) return 'missing'
    return latest.digest === sha(read(path.join(dir, ARTIFACTS[stage] ?? ''))) ? 'approved' : 'stale'
  }
  const isDone = (stage: Stage): boolean => {
    switch (stage) {
      case 'build':
      case 'diagnose':
        return exists(path.join(dir, 'verification.md'))
      case 'verify':
        return verification.result === 'pass'
      case 'review':
        return review.result === 'pass' || review.result === 'accepted'
      case 'ship':
        // Shipped means the scope record was committed with the change, which git can prove.
        return Boolean(git(['log', '-1', '--format=%H', '--', toPosix(path.relative(ROOT, path.join(dir, 'ship.json')))]))
      default:
        return exists(path.join(dir, ARTIFACTS[stage] ?? ''))
    }
  }

  let next: Next | null = null
  for (const stage of stages) {
    if (!isDone(stage)) {
      next = { stage, kind: 'work' }
      break
    }
    if ((gates as Stage[]).includes(stage) && approvalState(stage) !== 'approved') {
      next = { stage, kind: 'approve', state: approvalState(stage) }
      break
    }
  }
  return { slug, dir, type, tier, stages, gates, next, intent, verification, review }
}

function nextCommand(change: Change): string {
  const next = change.next
  if (!next) return 'done: nothing left for this change'
  if (next.kind === 'approve') {
    const why = next.state === 'stale' ? ' (approval is stale: the artifact changed after it was approved)' : ''
    return `human gate: review ${change.slug}/${ARTIFACTS[next.stage]}, then run /sdlc-approve ${change.slug} ${next.stage}${why}`
  }
  if (next.stage === 'intent') return `/sdlc:start ${change.slug}`
  if (next.stage === 'notes') return `/sdlc:start ${change.slug} (spike: answer in notes.md)`
  return `/sdlc:${next.stage} ${change.slug}`
}

// ---------- plan parsing & scope drift ----------

function planFiles(slug: string): string[] {
  const { body } = frontmatter(read(path.join(CHANGES, slug, 'plan.md')))
  const m = /^##\s+Files\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)
  if (!m) return []
  return (m[1] ?? '')
    .split('\n')
    .map(row => /^\s*[-*]\s+`?([^`\s]+)`?/.exec(row)?.[1])
    .filter((p): p is string => Boolean(p))
    .map(toPosix)
}

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + (glob.endsWith('/') ? '.*' : '') + '$')
}

// Paths are compared in POSIX form so plans written on macOS match edits made on Windows.
function relPosix(file: string): string {
  return toPosix(path.isAbsolute(file) ? path.relative(ROOT, file) : file)
}

function isPlanned(file: string, patterns: string[]): boolean {
  const rel = relPosix(file)
  if (rel.startsWith('.sdlc/')) return true
  return patterns.some(p => globToRegex(p).test(rel))
}

function changedFiles(base: string | null): string[] {
  const sets = [git(['diff', '--name-only']), git(['diff', '--name-only', '--cached']), git(['ls-files', '--others', '--exclude-standard'])]
  if (base) sets.push(git(['diff', '--name-only', `${base}...HEAD`]))
  return [...new Set(sets.flatMap(s => (s ? s.split('\n') : [])).filter(Boolean))]
}

function defaultBase(): string | null {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref]) && head !== ref.replace('origin/', '')) return git(['merge-base', 'HEAD', ref])
  }
  return null
}

function scopeDrift(slug: string, base: string | null) {
  const patterns = planFiles(slug)
  const changed = changedFiles(base)
  const drift = changed.filter(f => !isPlanned(f, patterns))
  return { slug, base, patterns, changed, drift, matchRatio: changed.length ? (changed.length - drift.length) / changed.length : 1 }
}

// ---------- secrets & plan quality ----------

const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['generic secret assignment', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
]

function scanSecrets(file: string): string[] {
  const text = read(file)
  if (!text || text.length > 2_000_000) return []
  const hits: string[] = []
  text.split('\n').forEach((row, i) => {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(row) && !/sdlc:allow-secret/.test(row)) hits.push(`${file}:${i + 1}: possible ${name}`)
    }
  })
  return hits
}

function planProblems(file: string): string[] {
  const text = read(file)
  const problems: string[] = []
  if (lines(text) > LIMITS.planLines) problems.push(`plan is ${lines(text)} lines (limit ${LIMITS.planLines})`)
  const big = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].filter(f => lines(f[1] ?? '') > LIMITS.planCodeBlockLines)
  if (big.length) problems.push(`${big.length} code block(s) over ${LIMITS.planCodeBlockLines} lines: plans carry interfaces and acceptance tests, not implementation code`)
  if (!/^##\s+Files/m.test(text)) problems.push('missing "## Files" section (the ownership contract)')
  return problems
}

// ---------- commands ----------

function ensureGitignore(): void {
  const ignore = path.join(SDLC, '.gitignore')
  if (exists(SDLC) && !exists(ignore)) fs.writeFileSync(ignore, 'usage.jsonl\n')
}

function cmdInit(): void {
  fs.mkdirSync(CHANGES, { recursive: true })
  fs.mkdirSync(path.join(SDLC, 'incidents'), { recursive: true })
  ensureGitignore()
  if (!exists(STATE)) fs.writeFileSync(STATE, '---\nchange:\n---\n# State\n\nNo active change.\n')
  out(`initialised ${toPosix(path.relative(ROOT, SDLC)) || SDLC}`)
}

const intentTemplate = (slug: string, type: ChangeType, tier: Tier, title: string): string => `---
slug: ${slug}
type: ${type}
tier: ${tier}
created: ${now()}
---
# ${title}

## Problem
<!-- who is affected, what hurts, evidence -->

## Outcome
<!-- observable result when done; how we will check it -->

## Non-goals
<!-- explicitly out of scope -->

## Risks
<!-- data, security, public contracts, migrations; say "none" if none -->
`

function setActive(slug: string): void {
  const { body } = frontmatter(read(STATE))
  fs.mkdirSync(SDLC, { recursive: true })
  fs.writeFileSync(STATE, `---\nchange: ${slug}\nupdated: ${now()}\n---\n${body || '# State\n'}`)
}

function cmdNew(args: Args): void {
  const slug = args.pos[0]
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) fail('usage: new <kebab-slug> --type <type> --tier S|M|L [--title "..."]')
  const type = optString(args, 'type') ?? 'feature'
  const tier = optString(args, 'tier') ?? 'M'
  if (!isChangeType(type)) fail(`unknown type "${type}"; one of ${Object.keys(PATHS).join(', ')}`)
  if (!isTier(tier)) fail('tier must be S, M or L')
  const dir = path.join(CHANGES, slug)
  if (exists(dir)) fail(`change ${slug} already exists`)
  if (!exists(SDLC)) cmdInit()
  ensureGitignore()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'intent.md'), intentTemplate(slug, type, tier, optString(args, 'title') ?? slug))
  setActive(slug)
  out(`created ${toPosix(path.relative(ROOT, dir))}/intent.md (type ${type}, tier ${tier})`)
}

function cmdActivate(args: Args): void {
  const slug = args.pos[0]
  if (!slug || !exists(path.join(CHANGES, slug))) fail(`no change named ${slug}`)
  setActive(slug)
  out(`active change: ${slug}`)
}

function cmdStatus(args: Args): void {
  const json = Boolean(args.opt.json)
  if (!exists(SDLC)) return out(json ? JSON.stringify({ initialised: false }) : 'sdlc not initialised here: run /sdlc:start')
  const active = activeSlug()
  const changes = listChanges().map(loadChange)
  const warnings: string[] = []
  for (const c of changes) {
    const plan = path.join(c.dir, 'plan.md')
    if (exists(plan)) for (const p of planProblems(plan)) warnings.push(`${c.slug}: ${p}`)
    if (lines(read(path.join(c.dir, 'intent.md'))) > LIMITS.intentLines + 10) warnings.push(`${c.slug}: intent.md is long; keep it under ${LIMITS.intentLines} lines`)
  }
  if (lines(frontmatter(read(STATE)).body) > LIMITS.stateLines) warnings.push(`STATE.md over ${LIMITS.stateLines} lines; trim it`)
  if (json) {
    const summary = changes.map(c => ({ slug: c.slug, type: c.type, tier: c.tier, next: c.next, command: nextCommand(c) }))
    return out(JSON.stringify({ initialised: true, active, changes: summary, warnings }))
  }
  if (!changes.length) return out('no changes yet: run /sdlc:start "<what you want>"')
  const label = (c: Change): string => (c.next ? c.next.stage + (c.next.kind === 'approve' ? ' (awaiting approval)' : '') : 'done')
  const rows = changes
    .sort((a, b) => (a.slug === active ? -1 : b.slug === active ? 1 : 0))
    .map(c => `${c.slug === active ? '▶' : ' '} ${c.slug.padEnd(28)} ${c.type.padEnd(10)} ${c.tier}  ${label(c)}`)
  const act = active ? loadChange(active) : null
  out([...rows, '', act ? `next: ${nextCommand(act)}` : '', ...warnings.map(w => `warn: ${w}`)].filter(Boolean).join('\n'))
}

function cmdApprove(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail('approvals are human-only: the person runs /sdlc-approve <slug> <stage>', 3)
  const [slug, stage] = args.pos
  if (!slug || !stage) fail('usage: approve <slug> <stage>')
  const artifact = ARTIFACTS[stage as Stage]
  const file = path.join(CHANGES, slug, artifact ?? '')
  if (!artifact || !exists(file)) fail(`nothing to approve: ${slug}/${artifact ?? stage} does not exist`)
  const by = optString(args, 'by') || git(['config', 'user.name']) || process.env.USER || process.env.USERNAME || 'unknown'
  const row: Approval = { slug, stage, by, at: now(), digest: sha(read(file)) }
  fs.appendFileSync(APPROVALS, JSON.stringify(row) + '\n')
  out(`approved ${slug} ${stage} by ${by} (digest ${row.digest}). Next: ${nextCommand(loadChange(slug))}`)
}

function cmdScopeDrift(args: Args): void {
  const slug = args.pos[0] ?? activeSlug()
  if (!slug) fail('no change to check')
  const base = optString(args, 'base') ?? defaultBase()
  const r = scopeDrift(slug, base)
  if (args.opt.record) {
    const shipFile = path.join(CHANGES, slug, 'ship.json')
    const prev: object = exists(shipFile) ? JSON.parse(read(shipFile)) : {}
    const record = { ...prev, at: now(), base, changed: r.changed.length, drift: r.drift, matchRatio: Number(r.matchRatio.toFixed(3)) }
    fs.writeFileSync(shipFile, JSON.stringify(record, null, 2) + '\n')
  }
  if (args.opt.json) return out(JSON.stringify(r))
  if (!r.patterns.length) out(`warn: ${slug}/plan.md has no "## Files" section; every changed file counts as drift`)
  if (!r.drift.length) return out(`scope ok: ${r.changed.length} changed file(s), all in ${slug}'s plan`)
  out(`scope drift: ${r.drift.length} of ${r.changed.length} changed file(s) are not in ${slug}/plan.md ## Files:\n${r.drift.map(f => '  ' + f).join('\n')}\nAdd them to the plan (and re-approve if gated) or revert them.`)
  process.exitCode = 1
}

// Ships a change deterministically: preconditions, scope gate, branch, staging and commit. The model only writes the message.
function cmdShip(args: Args): void {
  const slug = args.pos[0] ?? activeSlug()
  const message = optString(args, 'message')
  if (!slug || !exists(path.join(CHANGES, slug))) fail('usage: ship <slug> --message "<conventional commit message>"')
  if (!message) fail('ship needs --message "<type(scope): summary>"')
  const change = loadChange(slug)
  const pending = change.stages.filter(s => s !== 'ship' && !(change.next && change.stages.indexOf(s) < change.stages.indexOf(change.next.stage)))
  if (change.next && change.next.stage !== 'ship') fail(`not ready to ship: next is ${nextCommand(change)} (pending: ${pending.join(', ')})`)
  if (!change.next) return out(`${slug} is already shipped`)

  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const base = defaultBase() ?? (head && ['main', 'master'].includes(head) ? git(['rev-parse', 'HEAD']) : null)
  const r = scopeDrift(slug, base)
  if (r.drift.length) fail(`scope drift, not shipping. Out-of-plan files:\n${r.drift.map(f => '  ' + f).join('\n')}\nAdd them to plan.md ## Files (and re-approve if gated) or revert them.`)

  if (head === 'main' || head === 'master') {
    if (git(['checkout', '-b', `sdlc/${slug}`]) === null) fail(`could not create branch sdlc/${slug}`)
  }
  const shipFile = path.join(CHANGES, slug, 'ship.json')
  fs.writeFileSync(shipFile, JSON.stringify({ at: now(), base, changed: r.changed.length, drift: [], matchRatio: 1 }, null, 2) + '\n')
  ensureGitignore()
  const changeDir = toPosix(path.relative(ROOT, path.join(CHANGES, slug)))
  const extras = ['.sdlc/approvals.jsonl', '.sdlc/.gitignore'].filter(f => exists(path.join(ROOT, f)))
  const code = r.changed.filter(f => !f.startsWith('.sdlc/'))
  if (git(['add', '--', changeDir, ...extras, ...code]) === null) fail('git add failed')
  if (git(['commit', '-q', '-m', message]) === null) fail('git commit failed (nothing staged, or a commit hook refused it)')
  out(`shipped ${slug} on ${git(['rev-parse', '--abbrev-ref', 'HEAD'])} at ${git(['rev-parse', '--short', 'HEAD'])}: ${code.length} code file(s) + artifacts. Push and open a PR only with the person's go-ahead.`)
}

function cmdSecrets(args: Args): void {
  const hits = args.pos.flatMap(scanSecrets)
  if (!hits.length) return out('no secrets found')
  process.stderr.write(hits.join('\n') + '\n')
  process.exitCode = 2
}

function cmdLogUsage(args: Args): void {
  if (!exists(SDLC)) return
  ensureGitignore()
  // The mod passes the change and stage it saw when the turn started. A turn that started with no
  // change and created one (/sdlc:start) is that change's intent stage.
  const row = JSON.parse(args.pos[0] ?? '{}') as Partial<UsageRow>
  const current = frontmatter(read(STATE)).data.change || null
  const change = row.change ?? current
  const stage = row.change ? row.stage ?? null : current ? 'intent' : null
  fs.appendFileSync(USAGE, JSON.stringify({ at: now(), ...row, change, stage }) + '\n')
}

// ---------- hooks (settings hooks; read the event JSON on stdin) ----------

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
    'Rules: plans hold interfaces + acceptance tests, never code; delegate searches to sdlc:scout and slices to sdlc:implementer; read .sdlc/approvals.jsonl with the Read tool (only the person writes it); run subagents in the foreground and never end a turn while one is running; never sleep-poll; at ~150k context run /sdlc:handoff.',
    state && state !== '# State' ? `STATE.md:\n${state}` : '',
  ].filter(Boolean)
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } }))
}

// git (staging, committing, inspecting) and read-only viewers may name the approvals log; nothing that can write to it may.
const SAFE_APPROVALS_COMMAND = /^\s*(?:git\s+(?:add|commit|status|diff|log|show)|cat|head|tail|wc|grep|rg)\b/
const WRITES = /(?:>|\btee\b|\bsed\s+-i|\b(?:python3?|node|perl|ruby|bash|sh|zsh|pwsh|powershell)\b|\b(?:cp|mv|rm|truncate|dd)\b|\b(?:checkout|restore|reset|apply|stash)\b)/

function isSafeApprovalsCommand(cmd: string): boolean {
  return cmd
    .split(/&&|\|\||;|\|/)
    .filter(part => /approvals\.jsonl/.test(part))
    .every(part => SAFE_APPROVALS_COMMAND.test(part) && !WRITES.test(part.replace(/^\s*git\s+commit\b[^]*?-m\s+(["']).*?\1/, '')))
}

function hookPreBash(input: HookInput): void {
  const cmd = String(input.tool_input?.command ?? '')
  if (/sdlc\.(?:m?js|ts)["']?\s+approve\b/.test(cmd) || (/approvals\.jsonl/.test(cmd) && !isSafeApprovalsCommand(cmd))) {
    return decide('deny', 'Approvals are human-only. Read approvals.jsonl with the Read tool; only the person writes it, with /sdlc-approve <slug> <stage>.')
  }
  if (!exists(SDLC)) return
  const sleep = /(?:^|[;&|]\s*|\s)(?:sleep|Start-Sleep(?:\s+-Seconds)?)\s+(\d+)/i.exec(cmd)
  if (sleep && Number(sleep[1]) >= 30) {
    return decide('deny', 'Do not sleep-poll: background agents and shells notify you when they finish. End the turn or do other useful work.')
  }
}

function hookPreEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '')
  if (!file) return
  if (toPosix(file).endsWith('.sdlc/approvals.jsonl')) {
    return decide('deny', 'approvals.jsonl is written only by the human /sdlc-approve command.')
  }
  if (!exists(SDLC)) return
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

const HOOKS: Record<string, (input: HookInput) => void> = {
  'session-start': hookSessionStart,
  'pre-bash': hookPreBash,
  'pre-edit': hookPreEdit,
  'post-edit': hookPostEdit,
}

function cmdHook(args: Args): void {
  const handler = HOOKS[args.pos[0] ?? '']
  if (!handler) fail(`unknown hook ${args.pos[0]}`)
  handler(readStdin())
}

// ---------- metrics ----------

const hours = (a?: string | null, b?: string | null): number | null => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : null)

function median(xs: (number | null)[]): Metric {
  const v = xs.filter((x): x is number => x !== null && !Number.isNaN(x)).sort((a, b) => a - b)
  if (v.length < MIN_SAMPLE) return { value: null, n: v.length }
  const mid = Math.floor(v.length / 2)
  const value = v.length % 2 ? v[mid] ?? null : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2
  return { value, n: v.length }
}

const share = (hits: number, n: number): Metric => (n < MIN_SAMPLE ? { value: null, n } : { value: hits / n, n })

function firstCommitTime(file: string): string | null {
  const t = git(['log', '--diff-filter=A', '--follow', '--format=%aI', '--', file])
  return t ? t.split('\n').at(-1) ?? null : null
}

function commitTimes(file: string): string[] {
  const t = git(['log', '--format=%aI', '--', file])
  return t ? t.split('\n').filter(Boolean) : []
}

function ghPrs(): PullRequest[] | null {
  try {
    const fields = 'number,createdAt,mergedAt,body,reviews,statusCheckRollup'
    const raw = execFileSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '200', '--json', fields], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(raw) as PullRequest[]
  } catch {
    return null
  }
}

function sumBy(rows: UsageRow[], key: (r: UsageRow) => string, value: (r: UsageRow) => number): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const r of rows) totals[key(r)] = (totals[key(r)] ?? 0) + value(r)
  return totals
}

function cmdMetrics(args: Args): void {
  if (!exists(SDLC)) fail('sdlc not initialised here')
  const days = Number(optString(args, 'days') ?? 30)
  const since = Date.now() - days * 86_400_000
  const changes = listChanges().map(loadChange).filter(c => fs.statSync(c.dir).mtimeMs >= since)
  const rel = (c: Change, f: string): string => toPosix(path.relative(ROOT, path.join(c.dir, f)))
  const approvals = readJsonl<Approval>(APPROVALS)
  const prs = ghPrs()
  const prFor = (c: Change): PullRequest | undefined => prs?.find(p => p.body?.includes(`.sdlc/changes/${c.slug}`))
  const needsGh: Metric = { value: null, n: 0, note: 'needs gh' }
  const m: Record<string, Metric> = {}

  // Plan
  m.plan_lead_hours = median(changes.map(c => hours(c.intent.created, firstCommitTime(rel(c, 'intent.md')))))
  const decided = changes.filter(c => !c.next || c.stages.indexOf(c.next.stage) !== 0)
  m.intent_survival = share(decided.filter(c => exists(path.join(c.dir, 'plan.md')) || exists(path.join(c.dir, 'spec.md')) || c.type === 'bugfix').length, decided.length)
  // Design
  m.intent_to_spec_hours = median(changes.map(c => hours(firstCommitTime(rel(c, 'intent.md')), firstCommitTime(rel(c, 'spec.md')))))
  m.spec_churn_after_plan = median(
    changes
      .filter(c => exists(path.join(c.dir, 'spec.md')) && exists(path.join(c.dir, 'plan.md')))
      .map(c => {
        const firstPlan = firstCommitTime(rel(c, 'plan.md'))
        return firstPlan ? commitTimes(rel(c, 'spec.md')).filter(t => t > firstPlan).length : null
      }),
  )
  // Build
  const reviewed = changes.filter(c => c.review.rounds)
  m.first_pass_share = share(reviewed.filter(c => Number(c.review.rounds) <= 1).length, reviewed.length)
  m.rework_cycles = median(reviewed.map(c => Math.max(0, Number(c.review.rounds) - 1)))
  const shipped = changes.flatMap(c => {
    const file = path.join(c.dir, 'ship.json')
    return exists(file) ? [JSON.parse(read(file)) as { drift?: string[] }] : []
  })
  m.diff_matches_plan = share(shipped.filter(s => !s.drift?.length).length, shipped.length)
  m.plan_approval_to_merge_hours = prs
    ? median(changes.map(c => hours(approvals.filter(a => a.slug === c.slug && a.stage === 'plan').at(-1)?.at, prFor(c)?.mergedAt)))
    : needsGh
  // Test & Deploy (from GitHub)
  if (prs) {
    const ours = changes.map(prFor).filter((p): p is PullRequest => Boolean(p))
    const green = (p: PullRequest): boolean => (p.statusCheckRollup ?? []).every(s => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s.conclusion ?? s.state ?? 'SUCCESS'))
    m.first_pass_ci = share(ours.filter(green).length, ours.length)
    m.review_time_hours = median(ours.map(p => hours(p.createdAt, p.mergedAt)))
    m.time_to_first_review_hours = median(ours.map(p => hours(p.createdAt, p.reviews?.[0]?.submittedAt)))
  } else {
    m.first_pass_ci = needsGh
    m.review_time_hours = needsGh
    m.time_to_first_review_hours = needsGh
  }
  const incidentDir = path.join(SDLC, 'incidents')
  const incidents = exists(incidentDir)
    ? fs.readdirSync(incidentDir).filter(f => f.endsWith('.md')).map(f => frontmatter(read(path.join(incidentDir, f))).data)
    : []
  const caught = changes.reduce((n, c) => n + Number(c.review.caught ?? 0), 0)
  const escaped = incidents.filter(i => i.escaped === 'true').length
  m.defects_caught_vs_escaped = caught + escaped < MIN_SAMPLE ? { value: null, n: caught + escaped } : { value: caught / (caught + escaped), n: caught + escaped, caught, escaped }
  // Maintain
  m.breach_to_intent_hours = median(incidents.map(i => hours(i.detected, i.intent_at)))
  const classes = incidents.map(i => i.class).filter((c): c is string => Boolean(c))
  m.repeat_incident_share = share(classes.length - new Set(classes).size, classes.length)

  // Cost, from the mod's usage log
  const usage = readJsonl<UsageRow>(USAGE).filter(r => Date.parse(r.at) >= since)
  const main = usage.filter(r => r.kind === 'main')
  const agents = usage.filter(r => r.kind === 'agent')
  const tokensOf = (r: UsageRow): number => (r.in ?? 0) + (r.out ?? 0) + (r.cr ?? 0) + (r.cw ?? 0)
  const input = usage.reduce((s, r) => s + (r.in ?? 0) + (r.cr ?? 0) + (r.cw ?? 0), 0)
  const written = usage.reduce((s, r) => s + (r.out ?? 0) + (r.cw ?? 0), 0)
  const opusWritten = usage.filter(r => /opus/.test(r.model ?? '')).reduce((s, r) => s + (r.out ?? 0) + (r.cw ?? 0), 0)
  const cost = {
    usd_total: Number(main.reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(2)),
    usd_by_change: sumBy(main, r => r.change ?? '(none)', r => r.usd ?? 0),
    usd_by_stage: sumBy(main, r => r.stage ?? '(none)', r => r.usd ?? 0),
    tokens_by_agent_type: sumBy(agents, r => r.agentType ?? 'unknown', tokensOf),
    cache_hit_share: input ? Number((usage.reduce((s, r) => s + (r.cr ?? 0), 0) / input).toFixed(3)) : null,
    peak_context: main.reduce((p, r) => Math.max(p, r.ctx ?? 0), 0),
    turns_over_150k: main.filter(r => (r.ctx ?? 0) > 150_000).length,
    opus_token_share: written ? Number((opusWritten / written).toFixed(3)) : null,
  }

  if (args.opt.json) return out(JSON.stringify({ days, changes: changes.length, metrics: { ...m, cost } }, null, 2))
  const fmt = (v: Metric): string => (v.value === null ? `unmeasured (n=${v.n}${v.note ? ', ' + v.note : ''})` : `${Number(v.value.toFixed(2))} (n=${v.n})`)
  const rows = Object.entries(m).map(([k, v]) => `${k.padEnd(30)} ${fmt(v)}`)
  out([`sdlc metrics, last ${days} days, ${changes.length} change(s)`, ...rows, '', 'cost', JSON.stringify(cost, null, 2)].join('\n'))
}

// ---------- main ----------

const COMMANDS: Record<string, (args: Args) => void> = {
  init: cmdInit,
  new: cmdNew,
  activate: cmdActivate,
  status: cmdStatus,
  approve: cmdApprove,
  'scope-drift': cmdScopeDrift,
  ship: cmdShip,
  secrets: cmdSecrets,
  'log-usage': cmdLogUsage,
  hook: cmdHook,
  metrics: cmdMetrics,
}

const [command = '', ...rest] = process.argv.slice(2)
const run = COMMANDS[command]
if (!run) fail(`usage: sdlc.ts <${Object.keys(COMMANDS).join('|')}> ...`)
try {
  run(parseArgs(rest))
} catch (err) {
  // Hooks must never wedge a session: a crashing hook reports and lets the action through.
  const message = err instanceof Error ? err.message : String(err)
  if (command === 'hook') process.stderr.write(`${SOFT_HOOK_FAILURE}: ${message}\n`)
  else fail(err instanceof Error ? err.stack ?? message : message)
}
