import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnifiedDiff, globToRegex, matchesAny, parseConfig, parseRules, formatFindings, DEFAULT_CONFIG, type Finding } from './model.ts'

test('parses a modified file with added and removed line numbers', () => {
  const d = parseUnifiedDiff('diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -3 +3,2 @@\n-old\n+new\n+more\n')
  assert.deepEqual(d, [{ file: 'src/a.js', status: 'M', added: [{ n: 3, text: 'new' }, { n: 4, text: 'more' }], removed: [{ n: 3, text: 'old' }] }])
})

test('parses new, deleted, renamed and binary files', () => {
  const text = [
    'diff --git a/n.js b/n.js', 'new file mode 100644', '--- /dev/null', '+++ b/n.js', '@@ -0,0 +1 @@', '+x',
    'diff --git a/d.js b/d.js', 'deleted file mode 100644', '--- a/d.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-y',
    'diff --git a/old.js b/new.js', 'similarity index 90%', 'rename from old.js', 'rename to new.js', '--- a/old.js', '+++ b/new.js', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ',
  ].join('\n')
  const d = parseUnifiedDiff(text)
  assert.deepEqual(d.map(f => [f.file, f.status, f.from ?? null, Boolean(f.binary)]), [
    ['n.js', 'A', null, false], ['d.js', 'D', null, false], ['new.js', 'R', 'old.js', false], ['img.png', 'M', null, true],
  ])
  assert.equal(d[1]?.removed[0]?.text, 'y')
})

test('handles quoted non-ASCII paths, paths with spaces and CRLF', () => {
  const quoted = parseUnifiedDiff('diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\r\n--- "a/caf\\303\\251.js"\r\n+++ "b/caf\\303\\251.js"\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')
  assert.equal(quoted[0]?.file, 'café.js')
  assert.equal(quoted[0]?.added[0]?.text, 'b')
  const spaced = parseUnifiedDiff('diff --git a/my dir/x y.js b/my dir/x y.js\n--- a/my dir/x y.js\t\n+++ b/my dir/x y.js\t\n@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(spaced[0]?.file, 'my dir/x y.js')
})

test('a hunk line starting with --- or +++ is content, not a header', () => {
  const d = parseUnifiedDiff('diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n---- old rule\n++++ new rule\n')
  assert.deepEqual([d[0]?.removed[0]?.text, d[0]?.added[0]?.text], ['--- old rule', '+++ new rule'])
})

test('globs: ** spans directories without matching partial names', () => {
  assert.ok(globToRegex('**/test/**').test('test/a.js'))
  assert.ok(globToRegex('**/test/**').test('pkg/test/a.js'))
  assert.ok(!globToRegex('**/test/**').test('latest/a.js'))
  assert.ok(globToRegex('**/*.test.*').test('src/a.test.ts'))
  assert.ok(globToRegex('tests/**').test('tests/x/y.js'))
  assert.ok(globToRegex('src/**/*.ts').test('src/a.ts'))
  assert.ok(matchesAny('../checkout-service/src/a.ts', ['../checkout-service/**']))
})

test('config: defaults, merging and validation errors', () => {
  assert.deepEqual(parseConfig('').config, DEFAULT_CONFIG)
  const ok = parseConfig(JSON.stringify({ fast: { test: 'npm test' }, limits: { diffLines: 300 } }))
  assert.deepEqual([ok.errors, ok.config.fast.test, ok.config.limits.diffLines, ok.config.limits.fileLines], [[], 'npm test', 300, 400])
  assert.match(parseConfig('{nope').errors[0] ?? '', /not valid JSON/)
  assert.match(parseConfig(JSON.stringify({ layers: [{ from: 'src/**', mustNotImport: ['x'] }] })).errors[0] ?? '', /needs a why/)
  assert.match(parseConfig(JSON.stringify({ limit: {} })).errors[0] ?? '', /unknown key "limit"/)
  assert.match(parseConfig(JSON.stringify({ limits: { fileLines: -1 } })).errors[0] ?? '', /positive/)
})

test('rules: why is required and patterns must compile', () => {
  const good = parseRules(JSON.stringify([{ id: 'no-print', pattern: 'print\\(', message: 'use the logger', why: 'stdout is the protocol', action: 'block' }]))
  assert.deepEqual([good.errors, good.rules.length], [[], 1])
  assert.match(parseRules(JSON.stringify([{ id: 'x', pattern: 'a', message: 'm', action: 'warn' }])).errors[0] ?? '', /why/)
  assert.match(parseRules(JSON.stringify([{ id: 'x', message: 'm', why: 'w', action: 'warn' }])).errors[0] ?? '', /needs a pattern/)
  assert.match(parseRules(JSON.stringify([{ id: 'x', pattern: '(', message: 'm', why: 'w', action: 'warn' }])).errors[0] ?? '', /pattern/)
})

test('findings: silent when empty, blocks first, deduplicated, capped, warns summarised', () => {
  assert.equal(formatFindings([]), '')
  const b = (i: number): Finding => ({ sensor: 'layering', severity: 'block', file: 'src/a.ts', line: i, message: `m${i}`, fix: 'f' })
  const w: Finding = { sensor: 'size', severity: 'warn', file: 'src/big.ts', message: 'big', fix: 'split' }
  const text = formatFindings([w, b(1), b(1), b(2)])
  assert.match(text.split('\n')[0] ?? '', /\[layering\]/)
  assert.equal(text.match(/✗/g)?.length, 2)
  assert.match(text, /warn: 1 \(size 1\)/)
  const many = formatFindings(Array.from({ length: 60 }, (_, i) => b(i)), 40)
  assert.equal(many.split('\n').length, 40)
  assert.match(many, /… 22 more/)
})

test('findings: multi-line messages count physical lines toward the cap, fix on the first line', () => {
  const big = (i: number): Finding => ({ sensor: 'commands', severity: 'block', message: Array.from({ length: 20 }, (_, k) => `l${i}.${k}`).join('\n'), fix: 'fixit' })
  const warn: Finding = { sensor: 'size', severity: 'warn', message: 'w', fix: 'f' }
  const text = formatFindings([big(1), big(2), big(3), big(4), warn])
  assert.ok(text.split('\n').length <= 40)
  assert.match(text, /… \d+ more/)
  assert.match(text, /l1\.0 → fixit/)
})

test('fixtures must be a list of strings', () => {
  assert.match(parseConfig(JSON.stringify({ fixtures: 'x' })).errors[0] ?? '', /fixtures must be a list of strings/)
  assert.deepEqual(parseConfig(JSON.stringify({ fixtures: ['x/**'] })).config.fixtures, ['x/**'])
})

test('every sensor name emitted by the scripts is waivable', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { SENSOR_NAMES } = await import('./model.ts')
  const emitted = new Set<string>()
  for (const f of fs.readdirSync(import.meta.dirname).filter(n => n.endsWith('.ts') && !n.endsWith('.spec.ts') && n !== 'testkit.ts')) {
    for (const m of fs.readFileSync(path.join(import.meta.dirname, f), 'utf8').matchAll(/sensor: '([a-z-]+)'/g)) emitted.add(m[1]!)
  }
  assert.deepEqual([...emitted].filter(n => !SENSOR_NAMES.includes(n)), [])
  assert.deepEqual(SENSOR_NAMES.filter(n => !emitted.has(n)), [])
})

test('maskSecrets replaces every line that matches a secret pattern', async () => {
  const { maskSecrets } = await import('./model.ts')
  const key = 'AKIA' + 'IOSFODNN7EXAMPLE'
  assert.equal(maskSecrets(`ok\nkey=${key}\nend`), 'ok\n[masked by sdlc]\nend')
})
