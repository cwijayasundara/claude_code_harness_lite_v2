import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseUnifiedDiff, globToRegex, matchesAny, parseConfig, parseRules, formatFindings, warnRow, printable, DEFAULT_CONFIG, type Finding } from './model.ts'

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
    for (const m of fs.readFileSync(path.join(import.meta.dirname, f), 'utf8').matchAll(/(?:sensor: |\bwarn\()'([a-z-]+)'/g)) emitted.add(m[1]!)
  }
  emitted.delete('human-approval') // deliberately not waivable: it asks CI for an independent reviewer
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
  assert.deepEqual(d.gates, { S: [], M: ['design'], L: ['spec', 'plan', 'design'], greenfield: ['spec', 'plan', 'design'] })
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
  assert.deepEqual(config.gates.L, ['spec', 'plan', 'design'], 'unnamed tiers keep defaults')
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
  assert.match(bad({ gates: { M: ['deploy'] } }), /gates\.M must list spec, plan and\/or design/)
  assert.match(bad({ levels: { smoke: 'x' } }), /levels: unknown level "smoke"/)
  assert.match(bad({ quality: { lint: 'npx eslint .' } }), /quality\.lint must be \{ cmd, count \}/)
  assert.match(bad({ quality: { lint: { cmd: 'x', count: 'words' } } }), /quality\.lint\.count must be exit, lines or json:<path>/)
  assert.match(bad({ ratchet: { build: 0 } }), /ratchet\.build must be a positive integer/)
  assert.match(bad({ value: { rate: -1 } }), /value\.rate must be a non-negative number/)
})

test('v0.4 keys ignore prototype names and reject blank quality commands', () => {
  const errs = (t: string) => parseConfig(t).errors.join('\n')
  assert.match(errs('{"gates":{"toString":[]}}'), /gates: unknown tier "toString"/)
  const r = parseConfig('{"value":{"hours":{"__proto__":1}}}')
  assert.match(r.errors.join('\n'), /value\.hours: unknown tier "__proto__"/)
  assert.deepEqual(r.config.value.hours, { S: 2, M: 8, L: 24 })
  assert.equal(({} as Record<string, unknown>).toString !== undefined, true)
  assert.match(errs('{"quality":{"lint":{"cmd":"  ","count":"exit"}}}'), /quality\.lint must be \{ cmd, count \}/)
  assert.match(errs('{"quality":{"lint":{"cmd":"","count":"exit"}}}'), /quality\.lint must be \{ cmd, count \}/)
})

test('every starter stack in templates/stacks.json is a valid sensors.json fragment', () => {
  const stacks = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../templates/stacks.json'), 'utf8')) as Record<string, unknown>
  assert.ok(Object.keys(stacks).length >= 4)
  for (const [name, frag] of Object.entries(stacks)) assert.deepEqual(parseConfig(JSON.stringify(frag)).errors, [], name)
})

test('every starter stack declares unit and integration levels', () => {
  const stacks = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../templates/stacks.json'), 'utf8')) as Record<string, { levels?: Record<string, string> }>
  for (const [name, s] of Object.entries(stacks)) assert.ok(s.levels?.unit && s.levels.integration, `${name} needs unit and integration`)
})

const SPOOF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/
test('printable strips control, bidi-override and zero-width characters', () => {
  assert.equal(printable('a\x1b[31mb\u202Ec\u2066d\u200Be\u200Ff\u2069g\u202Ah'), 'a [31mb c d e f g h')
  assert.equal(printable('plain café → ok'), 'plain café → ok')
})

test('warn rows and block rows never carry control or bidi characters from file names, messages or fixes', () => {
  const evil = 'a\x1b[31mRED\u202Eb'
  const f = (severity: 'warn' | 'block'): Finding => ({ sensor: 's', severity, file: `x/${evil}.md`, line: 2, message: `bad ${evil}\nsecond ${evil}`, fix: `fix ${evil}`, labels: [evil] })
  assert.doesNotMatch(warnRow(f('warn')), SPOOF)
  const text = formatFindings([f('block'), f('block'), { ...f('warn'), line: 3 }])
  assert.doesNotMatch(text, SPOOF)
  assert.equal(text.split('\n').length, 4, 'a block message keeps its line breaks')
  assert.match(text, /RED/)
})

test('v0.6 keys default and parse: points, idleGapMs, scopeLimit, ci, affected, sparseBase', () => {
  const d = parseConfig('').config
  assert.deepEqual(d.points, { S: 5, M: 7, L: 11 })
  assert.equal(d.idleGapMs, 900_000)
  assert.equal(d.scopeLimit, 3)
  assert.deepEqual(d.ci, { scope: 'affected' })
  assert.equal(d.affected, '')
  assert.equal(d.sparseBase, false)
  assert.deepEqual(d.scopes, {})
  const c = parseConfig(JSON.stringify({ points: { S: 2, L: 13 }, idleGapMs: 60000, scopeLimit: 2, ci: { scope: 'all' }, affected: 'echo api', sparseBase: true }))
  assert.deepEqual(c.errors, [])
  assert.deepEqual(c.config.points, { S: 2, M: 7, L: 13 })
  assert.equal(c.config.idleGapMs, 60000)
  assert.equal(c.config.scopeLimit, 2)
  assert.equal(c.config.ci.scope, 'all')
  assert.equal(c.config.affected, 'echo api')
  assert.equal(c.config.sparseBase, true)
})

test('v0.6 keys reject bad values with a precise error', () => {
  const errs = (cfg: object): string[] => parseConfig(JSON.stringify(cfg)).errors
  assert.match(errs({ points: { S: 0 } }).join(), /points\.S must be a positive integer/)
  assert.match(errs({ points: { S: 1.5 } }).join(), /points\.S must be a positive integer/)
  assert.match(errs({ points: { XL: 3 } }).join(), /points: unknown tier "XL"/)
  assert.match(errs({ idleGapMs: -1 }).join(), /idleGapMs must be a positive integer/)
  assert.match(errs({ scopeLimit: 0 }).join(), /scopeLimit must be a positive integer/)
  assert.match(errs({ ci: { scope: 'some' } }).join(), /ci\.scope must be "affected" or "all"/)
  assert.match(errs({ sparseBase: 'yes' }).join(), /sparseBase must be true or false/)
})

test('scopes parse: name, root, command maps, deps; every mistake is named', () => {
  const ok = parseConfig(JSON.stringify({ scopes: {
    'packages/api/**': { name: 'api', root: 'packages/api', fast: { test: 'npm test' }, quality: { lint: { cmd: 'npx eslint .', count: 'lines' } }, deps: ['packages/shared/**'] },
    'packages/shared/**': { name: 'shared', root: 'packages/shared', full: { test: 'npm test' } },
  } }))
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.config.scopes['packages/api/**']?.name, 'api')
  assert.deepEqual(ok.config.scopes['packages/api/**']?.deps, ['packages/shared/**'])
  const errs = (scopes: object): string => parseConfig(JSON.stringify({ scopes })).errors.join('; ')
  assert.match(errs({ 'a/**': { name: 'a', root: '../escape' } }), /root must be a relative path inside the repo/)
  assert.match(errs({ 'a/**': { name: 'a', root: '/abs' } }), /root must be a relative path inside the repo/)
  assert.match(errs({ 'a/**': { root: 'a' } }), /name must be a non-empty string/)
  assert.match(errs({ 'a/**': { name: 'x', root: 'a' }, 'b/**': { name: 'x', root: 'b' } }), /scope name "x" is used twice/)
  assert.match(errs({ 'a/**': { name: 'a', root: 'a', deps: ['nope/**'] } }), /deps entry "nope\/\*\*" is not a declared scope glob/)
  assert.match(errs({ 'a/**': { name: 'a', root: 'a', levels: { unit: 'x' } } }), /levels is not supported yet/)
  assert.match(errs({ 'a/**': { name: 'a', root: 'a', fast: 'npm test' } }), /fast must map names to command strings/)
  assert.match(errs({ 'a/**': { name: 'a', root: 'a', bogus: 1 } }), /unknown key "bogus"/)
})

test('evals settings: defaults, overrides and precise errors', () => {
  assert.deepEqual(DEFAULT_CONFIG.evals, { minPass: 0.9, maxErrors: 2, maxTurns: 30, timeoutMs: 600_000 })
  const ok = parseConfig(JSON.stringify({ evals: { minPass: 0.8, maxErrors: 0, maxTurns: 10, timeoutMs: 60000 } }))
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.config.evals, { minPass: 0.8, maxErrors: 0, maxTurns: 10, timeoutMs: 60000 })
  const errs = (evals: unknown): string => parseConfig(JSON.stringify({ evals })).errors.join()
  assert.match(errs({ minPass: 1.5 }), /evals\.minPass must be a number from 0 to 1/)
  assert.match(errs({ maxTurns: 0 }), /evals\.maxTurns must be a positive integer/)
  assert.match(errs({ maxErrors: -1 }), /evals\.maxErrors must be a whole number/)
  assert.match(errs({ bogus: 1 }), /evals: unknown key "bogus"/)
  assert.match(errs('yes'), /evals must be \{ minPass, maxErrors, maxTurns, timeoutMs \}/)
})
