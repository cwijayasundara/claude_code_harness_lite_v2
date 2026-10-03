// sdlc core: paths, helpers and change state shared by every script. Zero dependencies.
// Only erasable TypeScript syntax is used (no enums, namespaces or parameter properties).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { globToRegex, SECRET_PATTERNS } from './model.ts'

export { globToRegex }

// ---------- types ----------

export type ChangeType = 'greenfield' | 'feature' | 'bugfix' | 'incident' | 'refactor' | 'migration' | 'chore' | 'spike'
export type Tier = 'S' | 'M' | 'L'
export type Stage = 'intent' | 'spec' | 'plan' | 'build' | 'diagnose' | 'verify' | 'review' | 'ship' | 'notes'
export type GatedStage = 'intent' | 'spec' | 'plan' | 'impact'
export type ApprovalState = 'approved' | 'stale' | 'missing'
export type Fields = Record<string, string>

export type Next = { stage: Stage; kind: 'work' } | { stage: Stage; kind: 'approve'; state: ApprovalState; gate: GatedStage }

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
  kind: 'main' | 'agent' | 'event'
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
  event?: string
  skill?: string
  rule?: string
}

export type Args = { pos: string[]; opt: Record<string, string | true> }
export type HookInput = {
  session_id?: string
  agent_id?: string
  agent_type?: string
  source?: string
  tool_input?: {
    command?: string
    file_path?: string
    notebook_path?: string
    content?: string
    old_string?: string
    new_string?: string
    replace_all?: boolean
    edits?: { old_string?: string; new_string?: string; replace_all?: boolean }[]
    skill?: string
    args?: string
  }
}

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

export const APPROVAL_ARTIFACTS: Record<GatedStage, string> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', impact: 'plan.md' }
export type ImpactHit = { consumer: string; file: string; line: number; id: string }
export type Impact = { at: string; ids: string[]; hits: ImpactHit[]; missing: string[] }

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

// A diff larger than the default 1 MB buffer must not turn into "no changes": allow 256 MB.
export function gitIn(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}
export const git = (args: string[]): string | null => gitIn(ROOT, args)

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

// The impact approval covers plan.md and impact.json, so a re-run of the plan point with new hits makes it stale.
export function approvalDigest(slug: string, gate: GatedStage): string {
  const dir = path.join(CHANGES, slug)
  const artifact = read(path.join(dir, APPROVAL_ARTIFACTS[gate]))
  if (gate !== 'impact') return sha(artifact)
  // The timestamp is left out so a re-run with identical results keeps the approval.
  const raw = read(path.join(dir, 'impact.json'))
  let content = raw
  try {
    const { ids, hits, missing } = JSON.parse(raw) as Impact
    content = JSON.stringify({ ids, hits, missing })
  } catch {
    // unparseable: hash the raw text
  }
  return sha(`${artifact}\n${content}`)
}

export function approvalOf(slug: string, gate: GatedStage): ApprovalState {
  const latest = readJsonl<Approval>(APPROVALS).filter(a => a.slug === slug && a.stage === gate).at(-1)
  if (!latest) return 'missing'
  return latest.digest === approvalDigest(slug, gate) ? 'approved' : 'stale'
}

export const needsImpact = (impact: Impact | null): boolean => Boolean(impact && (impact.hits.length || impact.missing.length))

export function readImpact(slug: string): Impact | null {
  try {
    return JSON.parse(read(path.join(CHANGES, slug, 'impact.json'))) as Impact
  } catch {
    return null
  }
}

export function listChanges(): string[] {
  if (!exists(CHANGES)) return []
  return fs
    .readdirSync(CHANGES, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
}

// STATE.md decides when it names a change, even an empty one (after ship). Only a missing STATE.md
// falls back to the most recently touched change that is still unfinished.
export function activeSlug(): string | null {
  const { data } = frontmatter(read(STATE))
  if ('change' in data) return data.change && exists(path.join(CHANGES, data.change)) ? data.change : null
  const byMtime = listChanges()
    .filter(slug => loadChange(slug).next !== null)
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
  const approvalState = (gate: GatedStage): ApprovalState => approvalOf(slug, gate)
  const isDone = (stage: Stage): boolean => {
    switch (stage) {
      case 'build':
      case 'diagnose':
        return exists(path.join(dir, 'verification.md'))
      case 'verify': {
        // Only a report sdlc generated from runs.jsonl counts (see runs.ts renderVerification).
        const v = frontmatter(read(path.join(dir, 'verification.md'))).data
        const runs = read(path.join(dir, 'runs.jsonl')).split('\n').slice(0, Number(v.runs)).join('\n')
        return Number(v.runs) >= 1 && v.generated === 'sdlc' && v.result === 'pass' && sha(runs) === v.digest
      }
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
    if ((gates as Stage[]).includes(stage) && approvalState(stage as GatedStage) !== 'approved') {
      next = { stage, kind: 'approve', state: approvalState(stage as GatedStage), gate: stage as GatedStage }
      break
    }
    if (stage === 'plan' && needsImpact(readImpact(slug)) && approvalState('impact') !== 'approved') {
      next = { stage, kind: 'approve', state: approvalState('impact'), gate: 'impact' }
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
    const what = next.gate === 'impact' ? `the cross-repo impact in ${change.slug}/impact.json and plan.md` : `${change.slug}/${APPROVAL_ARTIFACTS[next.gate]}`
    return `human gate: review ${what}, then run /sdlc-approve ${change.slug} ${next.gate}${why}`
  }
  if (next.stage === 'intent') return `/sdlc:start ${change.slug}`
  if (next.stage === 'notes') return `/sdlc:start ${change.slug} (spike: answer in notes.md)`
  return `/sdlc:${next.stage} ${change.slug}`
}
// ---------- plan parsing & scope drift ----------

// Evidence and gate state: written only by sdlc itself or the person's mod commands.
export const EVIDENCE_RE = /approvals\.jsonl|waivers\.jsonl|runs\.jsonl|\.sdlc[\\/](?:\.baseline|\.gate|unresolved\.json)|\.sdlc[\\/]changes[\\/][^\\/]+[\\/](?:verification\.md|impact\.json)/

// The plan's ## Verification commands, one per bullet. A command is the first backticked span when it
// sits in command position: right after the bullet marker, or after one leading `Label: `. Backticks later
// in prose (a path mentioned in a note) are not commands. A bullet with no backticks and no `: ` is a bare
// command (`- npm test`); a backtick-free `Label: prose` bullet is a note. Harness invocations (`sdlc.ts ...`,
// e.g. the red-first `run --expect-fail` or `check`) are not verification evidence and are not required.
export function planVerification(slug: string): string[] {
  const body = read(path.join(CHANGES, slug, 'plan.md'))
  const m = /^##\s+Verification\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body)
  return (m?.[1] ?? '').split('\n').flatMap(row => {
    const text = /^\s*[-*]\s+(.+)$/.exec(row)?.[1]
    if (!text) return []
    const cmd = (/^(?:[^`:]+:\s+)?`([^`]+)`/.exec(text)?.[1] ?? (text.includes('`') || text.includes(': ') ? '' : text)).trim()
    return cmd && !/\bsdlc\.ts\b/.test(cmd) ? [cmd] : []
  })
}

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

export const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
const GITIGNORED = ['usage.jsonl', '.baseline', '.gate', 'unresolved.json']

export function ensureGitignore(): void {
  if (!exists(SDLC)) return
  const ignore = path.join(SDLC, '.gitignore')
  const have = new Set(read(ignore).split('\n').filter(Boolean))
  const missing = GITIGNORED.filter(f => !have.has(f))
  if (missing.length) fs.appendFileSync(ignore, missing.join('\n') + '\n')
}

export function clearState(shipped: string): void {
  fs.writeFileSync(STATE, `---\nchange:\n---\n# State\n\nNo active change. Last shipped: ${shipped}.\n`)
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

## Decisions
<!-- skipped optional steps and defaults taken, one line each -->
`

export function createChange(slug: string, type: ChangeType, tier: Tier, title: string): void {
  const dir = path.join(CHANGES, slug)
  if (!exists(SDLC)) fs.mkdirSync(CHANGES, { recursive: true })
  ensureGitignore()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'intent.md'), intentTemplate(slug, type, tier, title))
  setActive(slug)
}

export function setActive(slug: string): void {
  const { body } = frontmatter(read(STATE))
  fs.mkdirSync(SDLC, { recursive: true })
  fs.writeFileSync(STATE, `---\nchange: ${slug}\nupdated: ${now()}\n---\n${body || '# State\n'}`)
}

export const WAIVERS = path.join(SDLC, 'waivers.jsonl')
export type Waiver = { slug: string; sensor: string; file: string; reason: string; by: string; at: string }

// Files sdlc itself wrote this turn count as sanctioned edits for the Stop gate's harness-tamper rule.
export function sanctionWrites(rels: string[]): void {
  const file = path.join(SDLC, '.gate')
  let gate: { tool?: string[] } = {}
  try {
    gate = JSON.parse(read(file)) as { tool?: string[] }
  } catch {
    gate = {}
  }
  gate.tool = [...new Set([...(gate.tool ?? []), ...rels.map(toPosix)])]
  fs.writeFileSync(file, JSON.stringify(gate))
}
