// sdlc core: paths, helpers and change state shared by every script. Zero dependencies.
// Only erasable TypeScript syntax is used (no enums, namespaces or parameter properties).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// ---------- types ----------

export type ChangeType = 'greenfield' | 'feature' | 'bugfix' | 'incident' | 'refactor' | 'migration' | 'chore' | 'spike'
export type Tier = 'S' | 'M' | 'L'
export type Stage = 'intent' | 'spec' | 'plan' | 'build' | 'diagnose' | 'verify' | 'review' | 'ship' | 'notes'
export type GatedStage = 'intent' | 'spec' | 'plan'
export type ApprovalState = 'approved' | 'stale' | 'missing'
export type Fields = Record<string, string>

export type Next = { stage: Stage; kind: 'work' } | { stage: Stage; kind: 'approve'; state: ApprovalState }

export type Change = {
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

export type Approval = { slug: string; stage: string; by: string; at: string; digest: string }

export type UsageRow = {
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

export type Args = { pos: string[]; opt: Record<string, string | true> }
export type HookInput = { tool_input?: { command?: string; file_path?: string; notebook_path?: string } }

// ---------- constants ----------

export const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()
export const SDLC = path.join(ROOT, '.sdlc')
export const CHANGES = path.join(SDLC, 'changes')
export const APPROVALS = path.join(SDLC, 'approvals.jsonl')
export const STATE = path.join(SDLC, 'STATE.md')
export const USAGE = path.join(SDLC, 'usage.jsonl')

export const LIMITS = { intentLines: 40, specLines: 150, planLines: 120, planCodeBlockLines: 10, stateLines: 40 }
export const MIN_SAMPLE = 5
export const SOFT_HOOK_FAILURE = 'sdlc hook error (ignored)'

// Stage paths per change type. A stage is done when its artifact exists (see isDone).
export const PATHS: Record<ChangeType, Stage[]> = {
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
export const GATES: Record<Tier, GatedStage[]> = { S: [], M: ['plan'], L: ['spec', 'plan'] }
// Tier S is the fast path: no spec, and review folds into ship (one /code-review pass).
export const SKIPPED_FOR_S = new Set<Stage>(['spec', 'review'])
export const SKIPPED_FOR_M = new Set<Stage>(['spec'])
export const ARTIFACTS: Partial<Record<Stage, string>> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', notes: 'notes.md' }

export const isChangeType = (v: string | undefined): v is ChangeType => v !== undefined && v in PATHS
export const isTier = (v: string | undefined): v is Tier => v !== undefined && v in GATES
// ---------- small helpers ----------

export const exists = (p: string): boolean => fs.existsSync(p)
// Line endings are normalised so CRLF checkouts on Windows parse and digest the same as on macOS.
export const read = (p: string): string => (exists(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '')
export const lines = (text: string): number => (text ? text.split('\n').length : 0)
export const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
export const now = (): string => new Date().toISOString()
export const toPosix = (p: string): string => p.replace(/\\/g, '/')
export const out = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

export function fail(message: string, code = 1): never {
  process.stderr.write(message + '\n')
  process.exit(code)
}

export function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export function frontmatter(text: string): { data: Fields; body: string } {
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
export function reportFields(text: string, keys: string[]): Fields {
  const { data, body } = frontmatter(text)
  for (const key of keys) {
    if (data[key]) continue
    const m = new RegExp(`^\\s*\\**${key}\\**\\s*:\\s*\\**\\s*([\\w-]+)`, 'mi').exec(body)
    if (m?.[1]) data[key] = m[1].toLowerCase()
  }
  return data
}

export function readJsonl<T>(p: string): T[] {
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

export function parseArgs(argv: string[]): Args {
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

export const optString = (args: Args, key: string): string | undefined => {
  const v = args.opt[key]
  return typeof v === 'string' ? v : undefined
}
// ---------- changes ----------

export function listChanges(): string[] {
  if (!exists(CHANGES)) return []
  return fs
    .readdirSync(CHANGES, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
}

export function activeSlug(): string | null {
  const { data } = frontmatter(read(STATE))
  if (data.change && exists(path.join(CHANGES, data.change))) return data.change
  const byMtime = listChanges()
    .map(slug => ({ slug, t: fs.statSync(path.join(CHANGES, slug)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return byMtime[0]?.slug ?? null
}

export function loadChange(slug: string): Change {
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

export function nextCommand(change: Change): string {
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

export function planFiles(slug: string): string[] {
  const { body } = frontmatter(read(path.join(CHANGES, slug, 'plan.md')))
  const m = /^##\s+Files\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)
  if (!m) return []
  return (m[1] ?? '')
    .split('\n')
    .map(row => /^\s*[-*]\s+`?([^`\s]+)`?/.exec(row)?.[1])
    .filter((p): p is string => Boolean(p))
    .map(toPosix)
}

export function globToRegex(glob: string): RegExp {
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
export function relPosix(file: string): string {
  return toPosix(path.isAbsolute(file) ? path.relative(ROOT, file) : file)
}

export function isPlanned(file: string, patterns: string[]): boolean {
  const rel = relPosix(file)
  if (rel.startsWith('.sdlc/')) return true
  return patterns.some(p => globToRegex(p).test(rel))
}

export function changedFiles(base: string | null): string[] {
  const sets = [git(['diff', '--name-only']), git(['diff', '--name-only', '--cached']), git(['ls-files', '--others', '--exclude-standard'])]
  if (base) sets.push(git(['diff', '--name-only', `${base}...HEAD`]))
  return [...new Set(sets.flatMap(s => (s ? s.split('\n') : [])).filter(Boolean))]
}

export function defaultBase(): string | null {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref]) && head !== ref.replace('origin/', '')) return git(['merge-base', 'HEAD', ref])
  }
  return null
}

export function scopeDrift(slug: string, base: string | null) {
  const patterns = planFiles(slug)
  const changed = changedFiles(base)
  const drift = changed.filter(f => !isPlanned(f, patterns))
  return { slug, base, patterns, changed, drift, matchRatio: changed.length ? (changed.length - drift.length) / changed.length : 1 }
}
// ---------- secrets & plan quality ----------

export const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['generic secret assignment', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
]

export function scanSecrets(file: string): string[] {
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

export function planProblems(file: string): string[] {
  const text = read(file)
  const problems: string[] = []
  if (lines(text) > LIMITS.planLines) problems.push(`plan is ${lines(text)} lines (limit ${LIMITS.planLines})`)
  const big = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].filter(f => lines(f[1] ?? '') > LIMITS.planCodeBlockLines)
  if (big.length) problems.push(`${big.length} code block(s) over ${LIMITS.planCodeBlockLines} lines: plans carry interfaces and acceptance tests, not implementation code`)
  if (!/^##\s+Files/m.test(text)) problems.push('missing "## Files" section (the ownership contract)')
  return problems
}

export function ensureGitignore(): void {
  const ignore = path.join(SDLC, '.gitignore')
  if (exists(SDLC) && !exists(ignore)) fs.writeFileSync(ignore, 'usage.jsonl\n')
}

export const intentTemplate = (slug: string, type: ChangeType, tier: Tier, title: string): string => `---
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

export function setActive(slug: string): void {
  const { body } = frontmatter(read(STATE))
  fs.mkdirSync(SDLC, { recursive: true })
  fs.writeFileSync(STATE, `---\nchange: ${slug}\nupdated: ${now()}\n---\n${body || '# State\n'}`)
}
