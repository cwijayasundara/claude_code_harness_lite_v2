// Language-agnostic sensors: pure functions from a parsed diff and config to findings.
// Language knowledge lives in the pattern tables below, never in code paths per language.
import { parseConfig, parseRules, type FileDiff, type Finding, type Rule, type SensorConfig, isTest, isSource, matchesAny, globToRegex, SECRET_PATTERNS } from './model.ts'

export const TAMPER_PATTERNS: { id: string; re: RegExp; what: string }[] = [
  { id: 'skip-or-only', re: /\b(?:it|describe|test|context|suite)\.(?:skip|only|todo)\s*[.(]/, what: 'test skipped or focused' },
  { id: 'x-prefixed', re: /^\s*x(?:it|describe|test|context)\s*\(/, what: 'test disabled with an x prefix' },
  { id: 'jasmine-focus', re: /^\s*f(?:it|describe|context)\s*\(/, what: 'test focused with an f prefix' },
  { id: 'pytest-skip', re: /^\s*@pytest\.mark\.(?:skip|skipif|xfail)\b/, what: 'pytest skip/xfail marker' },
  { id: 'unittest-skip', re: /^\s*@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/, what: 'unittest skip decorator' },
  { id: 'junit-disabled', re: /^\s*@(?:Disabled|Ignore)\b(?!\w)/, what: 'JUnit @Disabled/@Ignore' },
  { id: 'go-skip', re: /\bt\.Skip(?:Now|f)?\(/, what: 'Go t.Skip' },
  { id: 'rspec-pending', re: /^\s*(?:pending|skip)\b(?:\s+["']|\s*$|\s+do\b)/, what: 'RSpec pending/skip' },
]

export const SUPPRESSIONS: RegExp[] = [
  /eslint-disable/, /@ts-(?:ignore|expect-error|nocheck)\b/, /#\s*type:\s*ignore/, /#\s*noqa\b/, /pylint:\s*disable/,
  /\/\/\s*nolint\b/, /@SuppressWarnings\b/, /rubocop:disable/, /#\s*pragma:\s*no\s*cover/, /istanbul\s+ignore/,
]

const REASONED = /(?:\s--\s*|\bbecause\b\s*)\S/i
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|--|;)/
const ASSERTION = /\bassert(?:\.\w+\s*\(|\w*\s*[!(])|^\s*assert\s|\bexpect\s*[({]|\.should\b|\bAssert\.\w+\s*\(|\bt\.(?:Error|Fatal)f?\s*\(|\brequire\.\w+\s*\(/g
const THRESHOLD_KEY = /coverage|threshold|fail[_-]under|minimum|\b(?:lines|branches|functions|statements)\b/i
const CONFIG_FILE = /(?:^|\/)(?:[^/]*\.(?:json|ya?ml|toml|cfg|ini|xml|gradle|kts|properties)|\.[\w-]*rc(?:\.\w+)?|[^/]*\.config\.[cm]?[jt]s)$/
const SNAPSHOT = /(?:^|\/)__snapshots__\/|\.snap$/
const KEEP_TESTS = "keep the test and make the code pass it; removing a test needs the person's /sdlc-waive"

const countAssertions = (texts: string[]): number =>
  texts.filter(t => !COMMENT_LINE.test(t)).reduce((n, t) => n + (t.match(ASSERTION)?.length ?? 0), 0)

function similarity(gone: Set<string>, candidate: FileDiff): number {
  if (!gone.size) return 1
  const have = new Set(candidate.added.map(l => l.text.trim()))
  let hit = 0
  for (const line of gone) if (have.has(line)) hit++
  return hit / gone.size
}

function loweredThresholds(diffs: FileDiff[]): Finding[] {
  const findings: Finding[] = []
  const key = (t: string): string => t.replace(/\d+(?:\.\d+)?/g, '#').trim()
  const num = (t: string): number => Number(/\d+(?:\.\d+)?/.exec(t)?.[0])
  for (const d of diffs.filter(f => CONFIG_FILE.test(f.file) && !f.binary)) {
    const before = new Map(d.removed.filter(l => THRESHOLD_KEY.test(l.text) && /\d/.test(l.text)).map(l => [key(l.text), num(l.text)]))
    for (const l of d.added) {
      const was = before.get(key(l.text))
      if (was !== undefined && THRESHOLD_KEY.test(l.text) && num(l.text) < was) {
        findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, line: l.n, message: `threshold lowered from ${was} to ${num(l.text)}`, fix: 'restore the threshold and add the missing tests instead' })
      }
    }
  }
  return findings
}

export function testTamper(diffs: FileDiff[], cfg: SensorConfig): Finding[] {
  const findings: Finding[] = []
  const tests = diffs.filter(d => isTest(d.file, cfg) && !d.binary)
  const newFiles = tests.filter(d => d.status === 'A')
  const reported = new Set<string>()
  for (const d of tests.filter(t => t.status === 'D')) {
    const gone = new Set(d.removed.map(l => l.text.trim()).filter(Boolean))
    if (!newFiles.some(n => similarity(gone, n) >= 0.6)) {
      reported.add(d.file)
      findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, message: 'test file deleted', fix: KEEP_TESTS })
    }
  }
  for (const d of tests) {
    for (const l of d.added.filter(a => !COMMENT_LINE.test(a.text))) {
      const hit = TAMPER_PATTERNS.find(p => p.re.test(l.text))
      if (hit) findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, line: l.n, message: `${hit.what}: ${l.text.trim()}`, fix: KEEP_TESTS })
    }
  }
  const removed = countAssertions(tests.filter(d => !reported.has(d.file)).flatMap(d => d.removed.map(l => l.text)))
  const added = countAssertions(tests.flatMap(d => d.added.map(l => l.text)))
  if (removed > added) {
    findings.push({ sensor: 'test-tamper', severity: 'block', message: `assertions dropped across the test diff: ${removed} removed, ${added} added`, fix: 'keep every assertion that still applies; a weaker test hides bugs' })
  }
  findings.push(...loweredThresholds(diffs))
  for (const d of diffs) {
    if (SNAPSHOT.test(d.file) && d.status === 'M') findings.push({ sensor: 'test-tamper', severity: 'warn', file: d.file, message: 'snapshot rewritten', fix: 'check the snapshot change is intended' })
  }
  return findings
}

export function suppressions(diffs: FileDiff[], cfg: SensorConfig): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => !f.binary && (isSource(f.file, cfg) || isTest(f.file, cfg)))) {
    for (const l of d.added) {
      if (SUPPRESSIONS.some(re => re.test(l.text)) && !REASONED.test(l.text)) {
        findings.push({ sensor: 'suppression', severity: 'block', file: d.file, line: l.n, message: `suppression added: ${l.text.trim()}`, fix: 'fix the warning instead, or give the reason on the same line after "--" or "because"' })
      }
    }
  }
  return findings
}

const IMPORT_LINE = /^\s*(?:import|from|require|use|using|#\s*include|include|extern\s+crate)\b|\brequire\s*\(|\bimport\s*\(/
const word = (t: string): RegExp => new RegExp(`(?:^|[^A-Za-z0-9_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9_])`)

export function layering(diffs: FileDiff[], cfg: SensorConfig): Finding[] {
  const findings: Finding[] = []
  for (const layer of cfg.layers) {
    const from = globToRegex(layer.from)
    const banned = layer.mustNotImport.map(t => ({ t, re: word(t) }))
    for (const d of diffs.filter(f => from.test(f.file) && !f.binary)) {
      for (const l of d.added.filter(a => IMPORT_LINE.test(a.text) && !/^\s*(?:\/\/|#(?!\s*include))/.test(a.text))) {
        const hit = banned.find(b => b.re.test(l.text))
        if (hit) findings.push({ sensor: 'layering', severity: 'block', file: d.file, line: l.n, message: `${layer.from} must not import ${hit.t}: ${layer.why}`, fix: `depend on an interface owned by this layer and inject the ${hit.t} implementation at the boundary` })
      }
    }
  }
  return findings
}

export function size(diffs: FileDiff[], cfg: SensorConfig, fileLines: Record<string, number>, point: 'edit' | 'stop' | 'ship' | 'ci'): Finding[] {
  const findings: Finding[] = []
  const counted = diffs.filter(d => isSource(d.file, cfg) && !d.binary)
  for (const d of counted.filter(f => f.status !== 'D')) {
    const now = fileLines[d.file]
    if (now === undefined) continue
    const before = now - d.added.length + d.removed.length
    if (now > cfg.limits.fileLines && before <= cfg.limits.fileLines) {
      findings.push({ sensor: 'size', severity: 'warn', file: d.file, message: `grew to ${now} lines (limit ${cfg.limits.fileLines})`, fix: 'split it by responsibility before it grows further' })
    }
  }
  const total = counted.reduce((n, d) => n + d.added.length + d.removed.length, 0)
  if (total > cfg.limits.diffLines && point !== 'edit') {
    findings.push({ sensor: 'size', severity: point === 'stop' ? 'warn' : 'block', message: `diff is ${total} changed lines (limit ${cfg.limits.diffLines})`, fix: 'ship it as smaller changes, or the person records an override with /sdlc-waive size * <reason>' })
  }
  return findings
}

export function secretsInDiff(diffs: FileDiff[]): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => !f.binary)) {
    for (const l of d.added) {
      if (/sdlc:allow-secret/.test(l.text)) continue
      const hit = SECRET_PATTERNS.find(([, re]) => re.test(l.text))
      if (hit) findings.push({ sensor: 'secrets', severity: 'block', file: d.file, line: l.n, message: `possible ${hit[0]}`, fix: 'load it from the environment or a secret store; for a test fixture add "sdlc:allow-secret <why>" on the line' })
    }
  }
  return findings
}

export function rulesSensor(diffs: FileDiff[], rules: { id: string; pattern: string; paths?: string[]; message: string; why: string; action: 'warn' | 'block' }[]): Finding[] {
  const findings: Finding[] = []
  for (const rule of rules) {
    const re = new RegExp(rule.pattern)
    for (const d of diffs.filter(f => !f.binary && !f.file.startsWith('.sdlc/') && (!rule.paths || matchesAny(f.file, rule.paths)))) {
      for (const l of d.added.filter(a => re.test(a.text))) {
        findings.push({ sensor: 'rules', severity: rule.action, file: d.file, line: l.n, message: `${rule.message} (${rule.why})`, fix: `follow rule ${rule.id} in .sdlc/rules.json`, labels: [rule.id] })
      }
    }
  }
  return findings
}

// Rename and drop statements whose old name lives only in added lines of a new migration file.
export const RETIRE_PATTERNS: RegExp[] = [
  /\bRENAME\s+COLUMN\s+["'`]?(\w+)["'`]?\s+TO\b/i,
  /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)/i,
  /\bALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+TO\b/i,
  /\brename_column\s*\(?\s*:\w+\s*,\s*:(\w+)/,
  /\bremove_column\s*\(?\s*:\w+\s*,\s*:(\w+)/,
  /\bRenameField\s*\([^)]*old_name\s*=\s*["'](\w+)["']/,
  /\bRemoveField\s*\([^)]*name\s*=\s*["'](\w+)["']/,
  /\brenameColumn\s*\(\s*["'](\w+)["']/,
  /\bdropColumn\s*\(\s*["'](\w+)["']/,
]

const STOP_WORDS = new Set([
  'id', 'name', 'type', 'string', 'number', 'integer', 'int', 'value', 'data', 'text', 'true', 'false', 'null', 'table', 'column',
  'create', 'alter', 'drop', 'not', 'default', 'primary', 'key', 'references', 'varchar', 'numeric', 'serial', 'boolean', 'timestamp',
  'message', 'service', 'rpc', 'returns', 'optional', 'required', 'repeated', 'import', 'package', 'syntax', 'option', 'enum', 'oneof',
  'properties', 'items', 'object', 'array', 'description', 'format', 'schema', 'paths', 'get', 'post', 'put', 'patch', 'delete',
])
const TOKEN = /[A-Za-z_][A-Za-z0-9_]{2,}/g
const PROSE_LINE = /^\s*(?:\/\/|#|--|\/\*|\*)/
const PROSE_VALUE = /^(\s*["']?(?:description|summary|title)["']?\s*:).*$/i
// Comment lines and the value of description/summary/title keys are prose, not identifiers.
const code = (text: string): string => (PROSE_LINE.test(text) ? '' : text.replace(PROSE_VALUE, '$1'))
const tokens = (lines: { text: string }[]): Set<string> => new Set(lines.flatMap(l => code(l.text).match(TOKEN) ?? []))
const MAX_IDS = 50

export function retiredIdentifiers(diffs: FileDiff[], cfg: SensorConfig, producerContractText: string): string[] {
  const stillThere = new Set(producerContractText.match(TOKEN) ?? [])
  const ids = new Set<string>()
  for (const d of diffs.filter(f => matchesAny(f.file, cfg.contracts) && !f.binary)) {
    const added = tokens(d.added)
    for (const t of tokens(d.removed)) if (!added.has(t) && !stillThere.has(t)) ids.add(t)
    for (const l of d.added) for (const re of RETIRE_PATTERNS) {
      for (const m of l.text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) if (m[1]) ids.add(m[1])
    }
  }
  return [...ids].filter(t => !STOP_WORDS.has(t.toLowerCase()) && !/^\d/.test(t)).slice(0, MAX_IDS)
}

export function contractsFromPlan(planText: string): string[] {
  const section = /^##\s+Contracts\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(planText)?.[1] ?? ''
  return section
    .split('\n')
    .map(row => /^\s*[-*]\s*(?:rename|remove|drop|retire)\s+`([A-Za-z_]\w*)`/i.exec(row)?.[1])
    .filter((id): id is string => Boolean(id))
}

export const PROTECTED = ['.sdlc/sensors.json', '.sdlc/rules.json', '.sdlc/guides/**', '.sdlc/bin/**', 'CLAUDE.md', '.claude/**', '.github/workflows/sdlc-check.yml', 'CODEOWNERS', '.github/CODEOWNERS']
// ci: compare case-insensitively (macOS and Windows file systems treat CLAUDE.MD and CLAUDE.md as one file).
export const isProtected = (file: string, ci = false): boolean => (ci ? matchesAny(file.toLowerCase(), PROTECTED.map(p => p.toLowerCase())) : matchesAny(file, PROTECTED))
const SENSORS = '.sdlc/sensors.json'
const RULES = '.sdlc/rules.json'

const removedFrom = (before: string[], after: string[]): string[] => before.filter(x => !after.includes(x))

export function weakensConfig(beforeText: string, afterText: string): string[] {
  const after = parseConfig(afterText)
  if (after.errors.some(e => /not valid JSON|must be a JSON object/.test(e))) return ['sensors.json no longer parses']
  const b = parseConfig(beforeText).config
  const a = after.config
  const reasons: string[] = []
  for (const k of ['fileLines', 'diffLines'] as const) if (a.limits[k] > b.limits[k]) reasons.push(`limits.${k} raised ${b.limits[k]} → ${a.limits[k]}`)
  for (const k of ['tests', 'contracts'] as const) for (const g of removedFrom(b[k], a[k])) reasons.push(`${k} glob removed ${g}`)
  for (const g of removedFrom(a.ignore, b.ignore)) reasons.push(`ignore added ${g}`)
  for (const k of removedFrom(a.knownRed, b.knownRed)) reasons.push(`knownRed added ${k}`)
  for (const p of ['fast', 'full'] as const) for (const name of removedFrom(Object.keys(b[p]), Object.keys(a[p]))) reasons.push(`${p}.${name} removed`)
  for (const c of removedFrom(b.consumers.map(x => x.name), a.consumers.map(x => x.name))) reasons.push(`consumer ${c} removed`)
  for (const l of b.layers) {
    const now = a.layers.find(x => x.from === l.from)
    if (!now) reasons.push(`layer ${l.from} removed`)
    else for (const t of removedFrom(l.mustNotImport, now.mustNotImport)) reasons.push(`layer ${l.from} now allows ${t}`)
  }
  return reasons
}

export function weakensRules(beforeText: string, afterText: string): string[] {
  const b = parseRules(beforeText).rules
  const a = parseRules(afterText).rules
  const reasons = removedFrom(b.map(r => r.id), a.map(r => r.id)).map(id => `rule ${id} removed`)
  for (const r of b) if (r.action === 'block' && a.find(x => x.id === r.id)?.action === 'warn') reasons.push(`rule ${r.id} downgraded to warn`)
  return reasons
}

export function onlyKnownRedRemoved(beforeText: string, afterText: string): boolean {
  try {
    const b = JSON.parse(beforeText) as Record<string, unknown> & { knownRed?: string[] }
    const a = JSON.parse(afterText) as Record<string, unknown> & { knownRed?: string[] }
    const { knownRed: kb = [], ...restB } = b
    const { knownRed: ka = [], ...restA } = a
    return JSON.stringify(restA) === JSON.stringify(restB) && ka.every(k => kb.includes(k))
  } catch {
    return false
  }
}

export function harnessTamper(diffs: FileDiff[], o: { point: 'stop' | 'ship' | 'ci'; toolEdited?: Set<string>; before: (f: string) => string; after: (f: string) => string }): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => isProtected(f.file))) {
    const weaker = d.file === SENSORS ? weakensConfig(o.before(d.file), o.after(d.file)) : d.file === RULES ? weakensRules(o.before(d.file), o.after(d.file)) : []
    const reasons = d.status === 'D' ? [`${d.file} deleted`, ...weaker] : weaker
    if (o.point === 'stop') {
      if (o.toolEdited && !o.toolEdited.has(d.file)) {
        if (d.file === SENSORS && onlyKnownRedRemoved(o.before(d.file), o.after(d.file))) continue
        findings.push({ sensor: 'harness-tamper', severity: 'block', file: d.file, message: 'harness file changed outside Write/Edit (via Bash?)', fix: `revert it (git checkout -- ${d.file}), or ask the person to make this change` })
      } else if (reasons.length) {
        findings.push({ sensor: 'harness-tamper', severity: 'warn', file: d.file, message: reasons.join('; '), fix: 'the person allowed this edit; it shows in the review brief', labels: ['weakens-harness'] })
      }
      continue
    }
    findings.push(reasons.length
      ? { sensor: 'harness-tamper', severity: 'block', file: d.file, message: reasons.join('; '), fix: `a person must approve: /sdlc-waive harness-tamper ${d.file} <reason>`, labels: ['weakens-harness'] }
      : { sensor: 'harness-tamper', severity: 'warn', file: d.file, message: 'harness file changed', fix: 'needs human review' })
  }
  return findings
}
