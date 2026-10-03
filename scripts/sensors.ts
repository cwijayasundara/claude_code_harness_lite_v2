// Language-agnostic sensors: pure functions from a parsed diff and config to findings.
// Language knowledge lives in the pattern tables below, never in code paths per language.
import { type FileDiff, type Finding, type SensorConfig, isTest, isSource } from './model.ts'

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
