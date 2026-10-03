// The pure data model for sensors: diffs, globs, config, rules and findings. No fs, git or process access.
export type Line = { n: number; text: string }
export type FileStatus = 'A' | 'M' | 'D' | 'R'
export type FileDiff = { file: string; from?: string; status: FileStatus; added: Line[]; removed: Line[]; binary?: true }
export type Severity = 'block' | 'warn'
export type Finding = { sensor: string; severity: Severity; file?: string; line?: number; message: string; fix: string; labels?: string[] }
export type Consumer = { name: string; path: string; repo?: string; test?: string }
export type Layer = { from: string; mustNotImport: string[]; why: string }
export type Rule = { id: string; pattern: string; paths?: string[]; message: string; why: string; action: Severity }
export type SensorConfig = {
  fast: Record<string, string>
  full: Record<string, string>
  tests: string[]
  ignore: string[]
  contracts: string[]
  consumers: Consumer[]
  layers: Layer[]
  limits: { fileLines: number; diffLines: number }
  knownRed: string[]
}

export const DEFAULT_CONFIG: SensorConfig = {
  fast: {},
  full: {},
  tests: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/*Test.java', '**/*_spec.rb'],
  ignore: ['**/*.md', '**/*.lock', '**/package-lock.json'],
  contracts: ['api/**', 'schema/**', 'migrations/**', '**/*.proto', '**/openapi.*'],
  consumers: [],
  layers: [],
  limits: { fileLines: 400, diffLines: 500 },
  knownRed: [],
}

export const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['generic secret assignment', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
]

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
export const isSource = (file: string, cfg: SensorConfig): boolean => !file.startsWith('.sdlc/') && !matchesAny(file, cfg.ignore)

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
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const isStringMap = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every(x => typeof x === 'string')

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
  for (const key of ['tests', 'ignore', 'contracts', 'knownRed'] as const) {
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
    for (const k of ['fileLines', 'diffLines'] as const) {
      if (!(k in limits)) continue
      const v = limits[k]
      if (typeof v === 'number' && v > 0) config.limits[k] = v
      else errors.push(`limits.${k} must be a positive number`)
    }
  }
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
    if (r.paths !== undefined && !isStringList(r.paths)) return errors.push(`rule ${id}: paths must be a list of globs`)
    try {
      new RegExp(String(r.pattern))
    } catch {
      return errors.push(`rule ${id}: pattern is not a valid regular expression`)
    }
    rules.push(r as unknown as Rule)
  })
  return { rules, errors }
}

// ---------- findings ----------

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
      rows.push([`  ✗ ${where}${first}${labels} → ${f.fix}`, ...rest])
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
