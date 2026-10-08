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
export type Stage = 'intent' | 'spec' | 'plan' | 'design' | 'build' | 'diagnose' | 'test' | 'sensors' | 'pr' | 'pr-review' | 'notes'
export type GatedStage = 'intent' | 'spec' | 'plan' | 'design' | 'impact'
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
  first?: boolean // the session's first main turn: its ctx is the system prompt plus the prompt, before any work
  event?: string
  id?: string
  skill?: string
  rule?: string
}

export type Args = { pos: string[]; opt: Record<string, string | true> }
export type HookInput = {
  session_id?: string
  cwd?: string
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

export const APPROVAL_ARTIFACTS: Record<GatedStage, string> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', design: 'design.md', impact: 'plan.md' }
export type ImpactHit = { consumer: string; file: string; line: number; id: string }
export type Impact = { at: string; ids: string[]; hits: ImpactHit[]; missing: string[] }

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

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/
// A slug names a directory under .sdlc/changes: it must be a plain name of an existing change, never a path.
export function checkSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) fail(`invalid change name ${slug}`)
  if (!fs.existsSync(path.join(CHANGES, slug))) fail(`no change named ${slug}`)
  return slug
}

export function fail(message: string, code = 1): never {
  process.stderr.write(message + '\n')
  process.exit(code)
}

// A diff larger than the default 1 MB buffer must not turn into "no changes": allow 256 MB.
export function gitIn(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }).trim()
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
  // One approval covers the problem and the design, so a change to either makes it stale.
  if (gate === 'design') return sha(`${read(path.join(dir, 'intent.md'))}\n${read(path.join(dir, 'design.md'))}`)
  const artifact = read(approvalFile(slug, gate))
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

// The file an approval covers. The impact approval follows the plan document, so editing design.md makes it stale too.
export const approvalFile = (slug: string, gate: GatedStage): string => (gate === 'impact' ? planPath(slug) : path.join(CHANGES, slug, APPROVAL_ARTIFACTS[gate]))

// A change's plan document: design.md (feature and greenfield) when it exists, else plan.md. Every reader of the plan goes through here.
// A plan.md the person already approved stays the plan: a design.md added later must not widen the scope unapproved.
export const planPath = (slug: string): string => {
  const plan = path.join(CHANGES, slug, 'plan.md')
  const useDesign = exists(path.join(CHANGES, slug, 'design.md')) && !(exists(plan) && readJsonl<Approval>(APPROVALS).some(a => a.slug === slug && a.stage === 'plan'))
  return useDesign ? path.join(CHANGES, slug, 'design.md') : plan
}
export const planName = (slug: string): string => path.basename(planPath(slug))

export function approvalOf(slug: string, gate: GatedStage): ApprovalState {
  const latest = readJsonl<Approval>(APPROVALS).filter(a => a.slug === slug && a.stage === gate).at(-1)
  if (!latest) return 'missing'
  return latest.digest === approvalDigest(slug, gate) ? 'approved' : 'stale'
}

// The person approved the plan document: its own gate (plan, or design for feature and greenfield).
export const planApproved = (slug: string): boolean => approvalOf(slug, planName(slug) === 'design.md' ? 'design' : 'plan') === 'approved'

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
    .filter(d => d.isDirectory() && SLUG_RE.test(d.name))
    .map(d => d.name)
}

// Shipped means the scope record is committed with the change, which git can prove. v0.1 changes count too. One ls-tree of HEAD
// per (short-lived) process: status asks for every change each turn, and `git log -- <path>` for an unshipped one walks all history.
let committed: Set<string> | null = null
export function isShipped(slug: string): boolean {
  const dir = toPosix(path.relative(ROOT, CHANGES))
  committed ??= new Set((git(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', dir]) ?? '').split('\0'))
  return committed.has(`${dir}/${slug}/ship.json`)
}

// ---------- plan parsing & scope drift ----------

// Evidence file names, written only by sdlc itself or the person's commands (ratchet record refuses them as --from).
export const EVIDENCE_NAME_RE = /approvals\.jsonl|waivers\.jsonl|usage\.jsonl|runs\.jsonl|ratchet\.json|events\.jsonl|ship\.json|proposals\.json/

// The plan's ## Verification bullets, split into required commands and ignored bullets (never dropped silently).
// A command is the first backticked span in command position: right at the bullet start, or right after the
// first `: ` (so a label may itself contain backticks). Backticks later in prose are not commands. A bullet with
// no backticks and no `: ` is a bare command (`- npm test`); anything else is ignored. `sdlc.ts run -- "cmd"` is
// unwrapped to cmd; `sdlc.ts run --expect-fail ...` (red evidence), `sdlc.ts check ...` and other sdlc.ts
// invocations are ignored.
export function planVerificationBullets(slug: string): { commands: string[]; ignored: string[] } {
  const body = read(planPath(slug))
  const m = /^##\s+Verification\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body)
  const commands: string[] = []
  const ignored: string[] = []
  for (const row of (m?.[1] ?? '').split('\n')) {
    const text = /^\s*[-*]\s+(.+)$/.exec(row)?.[1]?.trim()
    if (!text) continue
    const rest = text.startsWith('`') ? text : text.includes(': ') ? text.slice(text.indexOf(': ') + 2).trimStart() : text
    let cmd = (rest.startsWith('`') ? /^`([^`]+)`/.exec(rest)?.[1] : text.includes('`') || text.includes(': ') ? undefined : text)?.trim()
    const wrapped = cmd && /\bsdlc\.ts\s+(.*)$/.exec(cmd)?.[1]
    if (wrapped !== undefined && wrapped !== '') cmd = /^run\s+(?:--slug\s+\S+\s+)?--\s+(["'])(.+)\1$/.exec(wrapped)?.[2]
    else if (wrapped === '') cmd = undefined
    if (cmd) commands.push(cmd)
    else ignored.push(text)
  }
  return { commands, ignored }
}

export const planVerification = (slug: string): string[] => planVerificationBullets(slug).commands

export function planFiles(slug: string): string[] {
  const { body } = frontmatter(read(planPath(slug)))
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
      if (re.test(row) && !/(?:rig|sdlc):allow-secret/.test(row)) hits.push(`${file}:${i + 1}: possible ${name}`)
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
  const section = /^##\s+Files\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text)?.[1] ?? ''
  const wide = [...new Set(section.split('\n').map(row => /^\s*[-*]\s+`?([^`\s]+)`?\s*$/.exec(row)?.[1]).filter(p => p === '**' || p === '*'))]
  for (const w of wide) problems.push(`"## Files" lists "${w}", which is too broad: the scope gate would allow every file; list the paths or narrower globs`)
  return problems
}

export const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
// A standalone repo runs its own copy from .sdlc/bin, where skills are /rig-<name> and agents rig-<name>.
export const IS_VENDORED = path.basename(import.meta.dirname) === 'bin'
export const skillRef = (name: string): string => `/rig${IS_VENDORED ? '-' : ':'}${name}`
export const agentRef = (name: string): string => `rig${IS_VENDORED ? '-' : ':'}${name}`
// Managed settings (the platform team's, which no engineer can edit): the OS file plus managed-settings.d/ drop-ins in name order.
// Objects merge, arrays concatenate, later scalars win. RIG_MANAGED_DIR overrides the directory (tests). Server-managed settings are not visible here.
export const MANAGED_DIR = process.env.RIG_MANAGED_DIR || (process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
  : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code')
export function managedFiles(dir = MANAGED_DIR): string[] {
  const d = path.join(dir, 'managed-settings.d')
  let drops: string[] = []
  try { drops = fs.readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => path.join(d, f)) } catch { /* none, or unreadable */ }
  return [path.join(dir, 'managed-settings.json'), ...drops].filter(f => { try { JSON.parse(fs.readFileSync(f, 'utf8')); return true } catch { return false } })
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k,
  isObj(a[k]) && isObj(b[k]) ? deepMerge(a[k], b[k]) : Array.isArray(a[k]) && Array.isArray(b[k]) ? [...a[k], ...b[k]] : k in b ? b[k] : a[k]]))
export const managedSettings = (dir = MANAGED_DIR): Record<string, unknown> =>
  managedFiles(dir).reduce<Record<string, unknown>>((acc, f) => { const v: unknown = JSON.parse(fs.readFileSync(f, 'utf8')); return isObj(v) ? deepMerge(acc, v) : acc }, {})

const GITIGNORED = ['usage.jsonl', '.baseline', '.gate', 'unresolved.json', 'gates.jsonl', 'spend-cache.json', 'spend-fetched', 'budget-seen.json']

// Parallel hooks (subagents) read-modify-write the same small state file: serialise them with a mkdir lock (stale after 10 s;
// after 5 s of waiting, proceed rather than wedge the hook) and write by rename so a reader never sees half a file.
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    try { fs.mkdirSync(lock); break } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true }) } catch { /* raced */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { return fn() } finally { try { fs.rmdirSync(lock) } catch { /* not ours */ } }
}
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

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

export const intentTemplate = (slug: string, type: ChangeType, tier: Tier, title: string, points?: number, source?: string): string => `---
slug: ${slug}
type: ${type}
tier: ${tier}
${source ? `source: ${source}\n` : ''}${points ? `points: ${points}\n` : ''}created: ${now()}
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

## Open questions
none
`

export function createChange(slug: string, type: ChangeType, tier: Tier, title: string, points?: { value: number; set: boolean }, source?: string): void {
  const dir = path.join(CHANGES, slug)
  if (!exists(SDLC)) fs.mkdirSync(CHANGES, { recursive: true })
  ensureGitignore()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'intent.md'), intentTemplate(slug, type, tier, title, points?.value, source))
  // Evidence written by sdlc itself: a change with a versioned ratchet.json is a v0.4 change; one without is legacy.
  // The tier and type are recorded here because intent.md is model-writable: it may raise them, only a person lowers them.
  fs.writeFileSync(path.join(dir, 'ratchet.json'), JSON.stringify({ version: 4, tier, type, ...(points?.set ? { points: points.value } : {}), nodes: {}, slices: {}, baseline: {} }, null, 2) + '\n')
  setActive(slug)
}

// A body sdlc itself wrote (init, clearState, or this function) is replaced; anything else was written by
// the model or the person and is kept.
const GENERATED_STATE = /^\s*(?:# State\s*)?(?:(?:No active change\.|Active change: [a-z0-9-]+\. Next: see \/rig-status\.)[^\n]*)?\s*$/
export function setActive(slug: string): void {
  const { body } = frontmatter(read(STATE))
  const kept = body && !GENERATED_STATE.test(body) ? body : `# State\n\nActive change: ${slug}. Next: see /rig-status.\n`
  fs.mkdirSync(SDLC, { recursive: true })
  fs.writeFileSync(STATE, `---\nchange: ${slug}\n---\n${kept}`)
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
