// The pure data model for sensors: diffs, globs, config, rules and findings. No fs, git or process access.
import { parseV4, parseV6 } from './configparse.ts'
import type { RoutingOverride } from './routing.ts'
export type Line = { n: number; text: string }
export type FileStatus = 'A' | 'M' | 'D' | 'R'
export type FileDiff = { file: string; from?: string; status: FileStatus; added: Line[]; removed: Line[]; binary?: true; oversize?: true }
export type Severity = 'block' | 'warn'
// Every sensor name a Finding can carry; /rig:waive accepts exactly these (a test keeps this in step with the sources).
export const SENSOR_NAMES = [
  'test-tamper', 'suppression', 'layering', 'size', 'secrets', 'rules', 'contract-impact', 'harness-tamper',
  'traceability', 'red-proof', 'unscanned', 'adhoc', 'commands', 'config', 'tier', 'unscoped',
]

export type Finding = { sensor: string; severity: Severity; file?: string; line?: number; message: string; fix: string; labels?: string[] }
export type Consumer = { name: string; path: string; repo?: string; test?: string }
export type Layer = { from: string; mustNotImport: string[]; why: string }
export type Rule = { id: string; pattern: string; paths?: string[]; message: string; why: string; action: Severity }
export type GateKey = 'S' | 'M' | 'L' | 'greenfield'
export type Level = 'unit' | 'integration' | 'acceptance' | 'api'
export type QualityCategory = 'lint' | 'types' | 'deps' | 'coupling' | 'complexity' | 'security' | 'perf'
export type QualityCmd = { cmd: string; count: string }
  export type Band = { id: string; query: string; count?: string; window: number; step: number; minSd: number; tools: string; routes: string[] }
  export type Scope = { name: string; root: string; fast?: Record<string, string>; full?: Record<string, string>; quality?: Partial<Record<QualityCategory, QualityCmd>>; deps?: string[] }
export type RatchetNode = 'build' | 'test' | 'sensors' | 'pr-review'
export const LEVELS: Level[] = ['unit', 'integration', 'acceptance', 'api']
export const QUALITY_CATEGORIES: QualityCategory[] = ['lint', 'types', 'deps', 'coupling', 'complexity', 'security', 'perf']
export const RATCHET_NODES: RatchetNode[] = ['build', 'test', 'sensors', 'pr-review']
// Soft budgets (spend governance spec §5). No budget set: spend shows, nothing warns or downshifts.
export type BudgetConfig = { teamMonthlyUsd: number | null; changeUsd: Partial<Record<'S' | 'M' | 'L', number>>; warnAt: [number, number, number]; downshift: boolean }
export const DEFAULT_BUDGET: BudgetConfig = { teamMonthlyUsd: null, changeUsd: {}, warnAt: [50, 80, 100], downshift: true }
export type SensorConfig = {
  fast: Record<string, string>
  full: Record<string, string>
  tests: string[]
  testSupport: string[]
  fixtures: string[]
  ignore: string[]
  contracts: string[]
  consumers: Consumer[]
  layers: Layer[]
  limits: { fileLines: number; diffLines: number; lineChars: number }
  knownRed: string[]
  build: 'native' | 'sdd'
  githooks: { prePush: 'ship' | 'off'; budgetMs: number }
  gates: Record<GateKey, ('spec' | 'plan' | 'design')[]>
  levels: Partial<Record<Level, string>>
  quality: Partial<Record<QualityCategory, QualityCmd>>
  ratchet: { rounds: Record<RatchetNode, number>; usd: Record<RatchetNode, number> }
  value: { rate: number; hours: Record<'S' | 'M' | 'L', number> }
  points: Record<'S' | 'M' | 'L', number>
  idleGapMs: number
  evals: { minPass: number; maxErrors: number; maxTurns: number; timeoutMs: number }
  routing: RoutingOverride
  bands: Band[]
  scopes: Record<string, Scope>
  scopeLimit: number
  ci: { scope: 'affected' | 'all' }
  affected: string
  sparseBase: boolean
  budget: BudgetConfig
}

export const DEFAULT_CONFIG: SensorConfig = {
  fast: {},
  full: {},
  tests: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/*Test.java', '**/*_spec.rb'],
  testSupport: ['**/testdata/**', '**/fixtures/**', '**/__fixtures__/**', '**/conftest.py', '**/testing/**', '**/test-helpers/**', '**/test_helpers/**'],
  fixtures: [],
  ignore: ['**/*.md', '**/*.lock', '**/package-lock.json'],
  contracts: ['api/**', 'schema/**', 'migrations/**', '**/*.proto', '**/openapi.*'],
  consumers: [],
  layers: [],
  limits: { fileLines: 400, diffLines: 500, lineChars: 160 },
  knownRed: [],
  build: 'native',
  githooks: { prePush: 'ship', budgetMs: 300_000 },
  gates: { S: [], M: ['design'], L: ['spec', 'plan', 'design'], greenfield: ['spec', 'plan', 'design'] },
  levels: {},
  quality: {},
  ratchet: { rounds: { build: 2, test: 2, sensors: 1, 'pr-review': 1 }, usd: { build: 6, test: 2, sensors: 2, 'pr-review': 2 } },
  value: { rate: 100, hours: { S: 2, M: 8, L: 24 } },
  points: { S: 5, M: 7, L: 11 },
  idleGapMs: 900_000,
  evals: { minPass: 0.9, maxErrors: 2, maxTurns: 30, timeoutMs: 600_000 },
  routing: {},
  bands: [],
  scopes: {},
  scopeLimit: 3,
  ci: { scope: 'affected' },
  affected: '',
  sparseBase: false,
  budget: structuredClone(DEFAULT_BUDGET),
}

export const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{16,}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['Azure storage key', /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/],
  ['env-style secret', /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)\s*=\s*[^\s"'$`<{(][^\s"']{15,}\s*$/m],
  ['generic secret assignment', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
]

// A private key spans lines: after its BEGIN line, mask every line through the matching END line (or to the end).
export function maskSecrets(text: string): string {
  let inKey = false
  return text.split('\n').map(l => {
    if (inKey) {
      inKey = !/-----END [A-Z ]*PRIVATE KEY-----/.test(l)
      return '[masked by sdlc]'
    }
    if (!SECRET_PATTERNS.some(([, re]) => re.test(l))) return l
    inKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(l)
    return '[masked by sdlc]'
  }).join('\n')
}

// Questions an artifact still leaves open: entries under `## Open questions` other than "none", and any
// "Q<n> ... still open / is open / unresolved" line elsewhere. Approval needs none, so a build never stalls on one.
export function openQuestions(text: string): string[] {
  const section = /^##\s+Open questions\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text)?.[1] ?? ''
  const listed = section.split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(l => l && !/^none\.?$/i.test(l))
  const prose = text.split('\n').filter(l => /\bQ\d+\b.*\b(?:still open|is open|unresolved)\b/i.test(l)).map(l => l.trim())
  return [...new Set([...listed, ...prose])]
}

// Concerns a spec, plan or design flags against a policy skill: bullets under `## Concerns` other than "none" without a
// `resolved:`. Approval needs none. A document with no Concerns section has none, so changes begun before it keep working.
export function unresolvedConcerns(text: string): string[] {
  // Any `## Concerns…` or `### Concerns…` heading opens the section (a variant must not fail open); it ends at the next heading of its level or above.
  const t = text.replace(/\r\n?/g, '\n')
  const head = /^(#{2,3})\s+Concerns\b[^\n]*\n/m.exec(t)
  const rest = head ? t.slice(head.index + head[0].length) : ''
  const section = rest.slice(0, new RegExp(`^#{1,${head?.[1]?.length ?? 2}}\\s`, 'm').exec(rest)?.index ?? rest.length)
  const items: { text: string; body: string; indent: number }[] = []
  for (const l of section.split('\n')) {
    const m = /^(\s*)(?:[-*]|\d+[.)])\s+(.*?)\s*$/.exec(l)
    const indent = (m?.[1] ?? /^\s*/.exec(l)?.[0] ?? '').length
    const cur = items[items.length - 1]
    if (m && (!cur || indent <= cur.indent || /\bowner:/i.test(m[2] ?? ''))) items.push({ text: m[2] ?? '', body: l, indent })
    else if (cur && l.trim() && indent > cur.indent) cur.body += `\n${l}`
  }
  return items.filter(i => i.text && !/^none\.?$/i.test(i.text) && !/\bresolved:/i.test(i.body)).map(i => i.text)
}

// ---------- globs ----------

// `**/` matches zero or more whole directories, `**` anything, `*` within one path segment.
export function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + (glob.endsWith('/') ? '.*' : '') + '$')
}

const compiled = new Map<string, RegExp>()
export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some(g => {
    let re = compiled.get(g)
    if (!re) compiled.set(g, (re = globToRegex(g)))
    return re.test(file)
  })
}
export const isTest = (file: string, cfg: SensorConfig): boolean => matchesAny(file, cfg.tests)
export const isSource = (file: string, cfg: SensorConfig): boolean =>
  !file.startsWith('.rig/') && !matchesAny(file, cfg.ignore)

// ---------- unified diff ----------

const ESCAPES: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92 }

// git C-quotes paths with unusual bytes ("caf\303\251.js"); decode the octal escapes back to UTF-8.
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const s = p.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ''
    if (c !== '\\') {
      bytes.push(...new TextEncoder().encode(c))
      continue
    }
    const next = s[i + 1] ?? ''
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      i++
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

// `--- a/x` / `+++ b/x`, with git's trailing tab for names containing spaces.
function sidePath(rest: string): string | null {
  const p = unquote(rest.replace(/\t$/, ''))
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
}

function headerPath(raw: string): string {
  const rest = raw.slice('diff --git '.length)
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest)
  if (quoted) return unquote(`"${quoted[1] ?? ''}"`)
  const i = rest.lastIndexOf(' b/')
  return i >= 0 ? rest.slice(i + 3) : rest
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let inHunk = false
  let oldN = 0
  let newN = 0
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { file: headerPath(raw), status: 'M', added: [], removed: [] }
      files.push(cur)
      inHunk = false
      continue
    }
    if (!cur) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      inHunk = true
      oldN = Number(hunk[1])
      newN = Number(hunk[2])
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('new file mode')) cur.status = 'A'
      else if (raw.startsWith('deleted file mode')) cur.status = 'D'
      else if (raw.startsWith('rename from ')) {
        cur.status = 'R'
        cur.from = unquote(raw.slice('rename from '.length))
      } else if (raw.startsWith('rename to ')) cur.file = unquote(raw.slice('rename to '.length))
      else if (raw.startsWith('Binary files ')) cur.binary = true
      else if (raw.startsWith('--- ')) {
        const p = sidePath(raw.slice(4))
        if (p && cur.status === 'D') cur.file = p
      } else if (raw.startsWith('+++ ')) {
        const p = sidePath(raw.slice(4))
        if (p) cur.file = p
      }
      continue
    }
    if (raw.startsWith('+')) cur.added.push({ n: newN++, text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.removed.push({ n: oldN++, text: raw.slice(1) })
    else if (raw.startsWith(' ')) {
      oldN++
      newN++
    }
  }
  return files
}

// ---------- config & rules ----------

type Json = Record<string, unknown>
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
export const isStringMap = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every(x => typeof x === 'string')

export const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

function parseJson(text: string, name: string): { value: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) }
  } catch (err) {
    return { value: null, error: `${name} is not valid JSON: ${(err as Error).message}` }
  }
}

export function parseConfig(text: string): { config: SensorConfig; errors: string[] } {
  const config: SensorConfig = structuredClone(DEFAULT_CONFIG)
  if (!text.trim()) return { config, errors: [] }
  const { value, error } = parseJson(text, 'sensors.json')
  if (error) return { config, errors: [error] }
  if (!isObject(value)) return { config, errors: ['sensors.json must be a JSON object'] }
  const errors: string[] = []
  for (const key of ['fast', 'full'] as const) {
    if (!(key in value)) continue
    if (isStringMap(value[key])) config[key] = value[key]
    else errors.push(`${key} must map names to command strings`)
  }
  for (const key of ['tests', 'testSupport', 'fixtures', 'ignore', 'contracts', 'knownRed'] as const) {
    if (!(key in value)) continue
    if (isStringList(value[key])) config[key] = value[key]
    else errors.push(`${key} must be a list of strings`)
  }
  if ('consumers' in value) {
    const list = value.consumers
    if (Array.isArray(list) && list.every(c => isObject(c) && typeof c.name === 'string' && typeof c.path === 'string')) config.consumers = list as Consumer[]
    else errors.push('consumers must be a list of { name, path, repo?, test? }')
  }
  if ('layers' in value) {
    const list = value.layers
    const valid = (l: unknown): boolean => isObject(l) && typeof l.from === 'string' && isStringList(l.mustNotImport) && typeof l.why === 'string' && l.why.trim() !== ''
    if (Array.isArray(list) && list.every(valid)) config.layers = list as Layer[]
    else errors.push('layers must be a list of { from, mustNotImport: [...], why }, and every layer needs a why')
  }
  if ('limits' in value) {
    const limits = isObject(value.limits) ? value.limits : {}
    for (const k of ['fileLines', 'diffLines', 'lineChars'] as const) {
      if (!(k in limits)) continue
      const v = limits[k]
      if (typeof v === 'number' && v > 0) config.limits[k] = v
      else errors.push(`limits.${k} must be a positive number`)
    }
  }
  if ('build' in value) {
    if (value.build === 'native' || value.build === 'sdd') config.build = value.build
    else errors.push('build must be "native" or "sdd"')
  }
  if ('githooks' in value) {
    const g = isObject(value.githooks) ? value.githooks : null
    if (!g) errors.push('githooks must be { prePush?: "ship" | "off", budgetMs?: number }')
    else {
      if ('prePush' in g) {
        if (g.prePush === 'ship' || g.prePush === 'off') config.githooks.prePush = g.prePush
        else errors.push('githooks.prePush must be "ship" or "off"')
      }
      if ('budgetMs' in g) {
        if (typeof g.budgetMs === 'number' && g.budgetMs > 0) config.githooks.budgetMs = g.budgetMs
        else errors.push('githooks.budgetMs must be a positive number')
      }
      for (const k of Object.keys(g)) if (k !== 'prePush' && k !== 'budgetMs') errors.push(`githooks: unknown key "${k}"`)
    }
  }
  parseV4(value, config, errors)
  parseV6(value, config, errors)
  for (const k of Object.keys(value)) if (!(k in DEFAULT_CONFIG)) errors.push(`unknown key "${k}"`)
  return { config, errors }
}

export function parseRules(text: string): { rules: Rule[]; errors: string[] } {
  if (!text.trim()) return { rules: [], errors: [] }
  const { value, error } = parseJson(text, 'rules.json')
  if (error) return { rules: [], errors: [error] }
  if (!Array.isArray(value)) return { rules: [], errors: ['rules.json must be a list of rules'] }
  const rules: Rule[] = []
  const errors: string[] = []
  value.forEach((r, i) => {
    const id = isObject(r) && typeof r.id === 'string' ? r.id : `#${i + 1}`
    if (!isObject(r) || typeof r.id !== 'string' || typeof r.message !== 'string') return errors.push(`rule ${id}: needs id and message`)
    if (typeof r.why !== 'string' || !r.why.trim()) return errors.push(`rule ${id}: needs a why (earn every rule)`)
    if (r.action !== 'warn' && r.action !== 'block') return errors.push(`rule ${id}: action must be warn or block`)
    if (typeof r.pattern !== 'string') return errors.push(`rule ${id}: needs a pattern`)
    if (r.paths !== undefined && !isStringList(r.paths)) return errors.push(`rule ${id}: paths must be a list of globs`)
    try {
      new RegExp(r.pattern)
    } catch {
      return errors.push(`rule ${id}: pattern is not a valid regular expression`)
    }
    rules.push(r as unknown as Rule)
  })
  return { rules, errors }
}

// ---------- findings ----------

// Repo-controlled text never reaches a terminal with control, bidi-override or zero-width characters in it (they could recolour, reorder or hide output).
export const printable = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
export const warnRow = (f: Finding): string => printable(`${f.sensor}${f.file ? ` ${f.file}` : ''}: ${f.message} → ${f.fix}`).replace(/\s+/g, ' ').slice(0, 200)
// The warnings a hook shows with their fix text (formatFindings counts them): five rows, then how many more.
export function warnLines(findings: Finding[], max = 5): string[] {
  const rows = [...new Set(findings.filter(f => f.severity === 'warn').map(warnRow))]
  return [...rows.slice(0, max).map(r => `  ! ${r}`), ...(rows.length > max ? [`  +${rows.length - max} more`] : [])]
}

// Silent success, verbose failure: nothing when clean; blocks first, grouped by sensor, deduplicated, capped.
export function formatFindings(findings: Finding[], max = 40): string {
  const seen = new Set<string>()
  const unique = findings.filter(f => {
    const key = `${f.sensor}|${f.file ?? ''}|${f.line ?? ''}|${f.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const blocks = unique.filter(f => f.severity === 'block')
  const warns = unique.filter(f => f.severity === 'warn')
  const rows: string[][] = []
  for (const sensor of [...new Set(blocks.map(f => f.sensor))]) {
    rows.push([`[${sensor}]`])
    for (const f of blocks.filter(b => b.sensor === sensor)) {
      const where = f.file ? `${f.file}${f.line ? ':' + f.line : ''}: ` : ''
      const labels = f.labels?.length ? ` (${f.labels.join(', ')})` : ''
      const [first = '', ...rest] = f.message.split('\n')
      rows.push([`  ✗ ${where}${first}${labels} → ${f.fix}`, ...rest].map(printable))
    }
  }
  const tail = warns.length ? [`warn: ${warns.length} (${[...new Set(warns.map(w => w.sensor))].map(s => `${s} ${warns.filter(w => w.sensor === s).length}`).join(', ')})`] : []
  const total = rows.reduce((n, r) => n + r.length, 0)
  const room = max - tail.length
  if (total <= room) return [...rows.flat(), ...tail].join('\n')
  // Cap physical lines: whole rows while they fit, then one "more" line.
  const shown: string[] = []
  for (const r of rows) {
    if (shown.length + r.length > room - 1) break
    shown.push(...r)
  }
  if (!shown.length) shown.push(...(rows[0] ?? []).slice(0, room - 1))
  return [...shown, `  … ${total - shown.length} more (run sdlc.ts check to see all)`, ...tail].join('\n')
}
