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

test('maskSecrets masks a whole private-key block through its END line', async () => {
  const { maskSecrets } = await import('./model.ts')
  const pem = ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu', '-----END RSA ' + 'PRIVATE KEY-----']
  assert.equal(maskSecrets(['before', ...pem, 'after'].join('\n')), 'before\n[masked by sdlc]\n[masked by sdlc]\n[masked by sdlc]\nafter')
})

test('limits.lineChars is validated and raising it weakens the config', async () => {
  const { parseConfig } = await import('./model.ts')
  assert.deepEqual(parseConfig('{"limits":{"lineChars":0}}').errors, ['limits.lineChars must be a positive number'])
  const { weakensConfig } = await import('./sensors.ts')
  assert.deepEqual(weakensConfig('{"limits":{"lineChars":120}}', '{"limits":{"lineChars":200}}'), ['limits.lineChars raised 120 → 200'])
})

test('config build mode is native by default and only native or sdd', async () => {
  const { parseConfig } = await import('./model.ts')
  assert.equal(parseConfig('{}').config.build, 'native')
  assert.equal(parseConfig('{"build":"sdd"}').config.build, 'sdd')
  assert.deepEqual(parseConfig('{"build":"fast"}').errors, ['build must be "native" or "sdd"'])
})

test('sensors.json v0.4 keys parse, with defaults when absent', () => {
  const d = parseConfig('{}').config
  assert.deepEqual(d.gates, { S: [], M: [], L: ['spec', 'plan'], greenfield: ['spec', 'plan'] })
  assert.deepEqual(d.ratchet, { rounds: { build: 2, test: 2, sensors: 1, 'pr-review': 1 }, usd: { build: 6, test: 2, sensors: 2, 'pr-review': 2 } })
  assert.deepEqual(d.value, { rate: 100, hours: { S: 2, M: 8, L: 24 } })
  const { config, errors } = parseConfig(JSON.stringify({
    gates: { M: ['plan'] },
    levels: { unit: 'npm test', api: 'npm run test:api' },
    quality: { lint: { cmd: 'npx eslint .', count: 'lines' }, deps: { cmd: 'npm audit --json', count: 'json:metadata.vulnerabilities.total' } },
    ratchet: { build: 3, usd: { build: 10 } },
    value: { rate: 120, hours: { L: 40 } },
  }))
  assert.deepEqual(errors, [])
  assert.deepEqual(config.gates.M, ['plan'])
  assert.deepEqual(config.gates.L, ['spec', 'plan'], 'unnamed tiers keep defaults')
  assert.equal(config.levels.api, 'npm run test:api')
  assert.deepEqual(config.quality.deps, { cmd: 'npm audit --json', count: 'json:metadata.vulnerabilities.total' })
  assert.equal(config.ratchet.rounds.build, 3)
  assert.equal(config.ratchet.rounds.test, 2)
  assert.equal(config.ratchet.usd.build, 10)
  assert.equal(config.value.rate, 120)
  assert.equal(config.value.hours.L, 40)
  assert.equal(config.value.hours.S, 2)
})

test('sensors.json v0.4 keys reject bad shapes', () => {
  const bad = (o: unknown) => parseConfig(JSON.stringify(o)).errors.join('\n')
  assert.match(bad({ gates: { M: ['deploy'] } }), /gates\.M must list spec and\/or plan/)
  assert.match(bad({ levels: { smoke: 'x' } }), /levels: unknown level "smoke"/)
  assert.match(bad({ quality: { lint: 'npx eslint .' } }), /quality\.lint must be \{ cmd, count \}/)
  assert.match(bad({ quality: { lint: { cmd: 'x', count: 'words' } } }), /quality\.lint\.count must be exit, lines or json:<path>/)
  assert.match(bad({ ratchet: { build: 0 } }), /ratchet\.build must be a positive integer/)
  assert.match(bad({ value: { rate: -1 } }), /value\.rate must be a non-negative number/)
})
