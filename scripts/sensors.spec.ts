import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG as CFG, type FileDiff, type SensorConfig, type Rule, parseConfig } from './model.ts'
import { withoutFixtures, testTamper, suppressions, TAMPER_PATTERNS, layering, size, secretsInDiff, rulesSensor, retiredIdentifiers, contractsFromPlan, weakensConfig, weakensRules, isProtected, onlyKnownRedRemoved, harnessTamper, behaviourIds, missingBehaviours } from './sensors.ts'

export const fd = (file: string, added: string[] = [], removed: string[] = [], status: FileDiff['status'] = 'M'): FileDiff => ({
  file, status, added: added.map((text, i) => ({ n: i + 1, text })), removed: removed.map((text, i) => ({ n: i + 1, text })),
})
const blocks = <T extends { severity: string }>(fs: T[]): T[] => fs.filter(f => f.severity === 'block')

// Every tamper row has a positive and a negative fixture (spec §5.4).
const FIXTURES: Record<string, [string, string]> = {
  'skip-or-only': ["it.skip('adds', () => {})", "const rest = myit.skip(2)"],
  'jasmine-focus': ["fit('x', () => {})", '  fill(x)'],
  'x-prefixed': ["  xit('adds', () => {})", '  exit(1)'],
  'pytest-skip': ['@pytest.mark.skip(reason="slow")', '# docs mention pytest.mark.skip'],
  'unittest-skip': ['@unittest.skip("flaky")', 'unittest.skipTest_helper()'],
  'junit-disabled': ['  @Disabled', '  @DisabledForJreRange(min = JAVA_8)'],
  'go-skip': ['\tt.Skip("slow")', '\tt.SkipTo(next)'],
  'rspec-pending': ['  pending "not yet"', "  expect(t.status).toBe('pending')"],
}

test('every tamper pattern has fixtures', () => {
  assert.deepEqual(TAMPER_PATTERNS.map(p => p.id).sort(), Object.keys(FIXTURES).sort())
})

for (const [id, [positive, negative]] of Object.entries(FIXTURES)) {
  test(`tamper ${id}: positive blocks, negative passes`, () => {
    assert.equal(blocks(testTamper([fd('test/a.test.js', [positive])], CFG)).length, 1, positive)
    assert.equal(blocks(testTamper([fd('test/a.test.js', [negative])], CFG)).length, 0, negative)
  })
}

test('skip markers in non-test files are ignored', () => {
  assert.equal(testTamper([fd('src/a.js', ["it.skip('x')"])], CFG).length, 0)
})

test('assertions are counted across all test files, so moving tests is neutral', () => {
  const moved = [fd('test/a.test.js', [], ['  expect(a).toBe(1)', '  expect(b).toBe(2)']), fd('test/b.test.js', ['  expect(a).toBe(1)', '  expect(b).toBe(2)'])]
  assert.equal(blocks(testTamper(moved, CFG)).length, 0)
  const dropped = [fd('test/a.test.js', ['  expect(a).toBeTruthy()'], ['  expect(a).toBe(1)', '  expect(b).toBe(2)'])]
  assert.match(blocks(testTamper(dropped, CFG))[0]?.message ?? '', /2 removed, 1 added/)
  const comments = [fd('test/a.test.js', [], ['  // expect(a).toBe(1) was flaky'])]
  assert.equal(blocks(testTamper(comments, CFG)).length, 0)
})

test('a deleted test file blocks unless its content reappears in a new file', () => {
  const body = ["test('a', () => {", '  expect(add(1, 2)).toBe(3)', '})']
  assert.equal(blocks(testTamper([fd('test/a.test.js', [], body, 'D')], CFG)).length, 1)
  assert.equal(blocks(testTamper([fd('test/a.test.js', [], body, 'D'), fd('test/math/a.test.js', body, [], 'A')], CFG)).length, 0)
})

test('a lowered coverage threshold in config blocks; source code numbers do not', () => {
  assert.equal(blocks(testTamper([fd('package.json', ['    "lines": 80,'], ['    "lines": 85,'])], CFG)).length, 1)
  assert.equal(blocks(testTamper([fd('pyproject.toml', ['fail_under = 70'], ['fail_under = 85'])], CFG)).length, 1)
  assert.equal(blocks(testTamper([fd('package.json', ['    "lines": 90,'], ['    "lines": 85,'])], CFG)).length, 0)
  assert.equal(blocks(testTamper([fd('src/report.js', ['const lines = 80'], ['const lines = 85'])], CFG)).length, 0)
})

test('rewritten snapshots warn', () => {
  const r = testTamper([fd('test/__snapshots__/a.test.js.snap', ['x'], ['y'])], CFG)
  assert.deepEqual(r.map(f => f.severity), ['warn'])
})

test('suppression comments block unless they carry a reason', () => {
  for (const line of ['// eslint-disable-next-line no-console', 'x = y  # type: ignore', 'import os  # noqa', '// @ts-ignore', '//nolint', '@SuppressWarnings("unchecked")', '# rubocop:disable Metrics/AbcSize']) {
    assert.equal(blocks(suppressions([fd('src/a.ts', [line])], CFG)).length, 1, line)
  }
  assert.equal(suppressions([fd('src/a.ts', ['// eslint-disable-next-line no-console -- the CLI prints by design'])], CFG).length, 0)
  assert.equal(suppressions([fd('src/a.py', ['x = y  # type: ignore because the stub is wrong upstream'])], CFG).length, 0)
  assert.equal(suppressions([fd('README.md', ['use // eslint-disable sparingly'])], CFG).length, 0)
})

test('assert.* calls count as assertions', () => {
  const r = testTamper([fd('test/a.test.js', ['  assert.equal(add(1, 2), 3)'], ['  assert.equal(add(1, 2), 3)', '  assert.equal(add(0, 0), 0)'])], CFG)
  assert.match(blocks(r)[0]?.message ?? '', /2 removed, 1 added/)
})

test('each assertion form counts exactly once', () => {
  for (const line of ['assert.equal(a, b)', 'assert.ok(x)', 'assert_eq!(a, b)', 'assert!(x)', 'expect { x }.to raise_error', 'self.assertEqual(a, b)', 'assert x == 1', 'expect(a).toBe(1)']) {
    const r = testTamper([fd('test/a.test.js', [], [line])], CFG)
    assert.match(blocks(r)[0]?.message ?? '', /1 removed, 0 added/, line)
  }
})

test('focus and skip variants block', () => {
  assert.equal(blocks(testTamper([fd('test/a.test.js', ["it.skip.each([1])('x', () => {})"])], CFG)).length, 1)
  assert.equal(blocks(testTamper([fd('test/a.test.js', ["describe.only.each([1])('x', () => {})"])], CFG)).length, 1)
})

test('a commented-out tamper line does not block', () => {
  assert.equal(blocks(testTamper([fd('test/a.test.js', ["// it.skip('x')"])], CFG)).length, 0)
})

test('a lone deleted test file with assertions yields exactly one block', () => {
  const r = blocks(testTamper([fd('test/a.test.js', [], ["test('a', () => {", '  expect(add(1, 2)).toBe(3)', '})'], 'D')], CFG))
  assert.equal(r.length, 1)
  assert.match(r[0]?.message ?? '', /test file deleted/)
})

const withLayers: SensorConfig = { ...CFG, layers: [{ from: 'src/domain/**', mustNotImport: ['infra', 'http'], why: 'the domain stays framework-free' }] }

test('layering blocks forbidden imports in any import syntax, and nothing else', () => {
  for (const line of ["import { db } from '../infra/db'", 'from infra.db import session', "const h = require('../http/client')", 'use crate::infra::db;', '#include "infra/db.h"', 'import com.acme.infra.Db;']) {
    const r = layering([fd('src/domain/order.ts', [line])], withLayers)
    assert.equal(r.length, 1, line)
    assert.match(r[0]?.message ?? '', /framework-free/)
  }
  assert.equal(layering([fd('src/domain/order.ts', ['// talks to infra later', "import { infraction } from './rules'"])], withLayers).length, 0)
  assert.equal(layering([fd('src/app/main.ts', ["import { db } from '../infra/db'"])], withLayers).length, 0)
})

test('size blocks when a file crosses the line limit at stop, and the diff limit blocks only from ship on', () => {
  const big = fd('src/a.ts', Array.from({ length: 30 }, () => 'x'))
  assert.equal(size([big], CFG, { 'src/a.ts': 410 }, 'stop')[0]?.severity, 'block')
  assert.equal(size([big], CFG, { 'src/a.ts': 900 }, 'stop').length, 0, 'already over before this diff: no news')
  const huge = fd('src/b.ts', Array.from({ length: 600 }, () => 'y'), [], 'A')
  assert.equal(size([huge], CFG, { 'src/b.ts': 600 }, 'stop').find(f => !f.file)?.severity, 'warn')
  assert.equal(size([huge], CFG, { 'src/b.ts': 600 }, 'ship').find(f => !f.file)?.severity, 'block')
  assert.equal(size([fd('docs/x.md', Array.from({ length: 900 }, () => 'z'))], CFG, {}, 'ship').length, 0, 'ignored files do not count')
})

test('secrets in added lines block; an in-line allow comment does not opt out', () => {
  assert.equal(secretsInDiff([fd('src/c.js', ['const key = "AKIAABCDEFGHIJKLMNOP"'])]).length, 1)
  assert.equal(secretsInDiff([fd('src/c.js', ['const key = "AKIAABCDEFGHIJKLMNOP" // rig:allow-secret test fixture'])]).length, 1, 'an in-line marker no longer exempts: only base-branch fixtures do')
})

test('rules apply to added lines within their paths, labelled with the rule id', () => {
  const rules: Rule[] = [{ id: 'no-print', pattern: '\\bprint\\(', paths: ['src/**'], message: 'use the logger', why: 'stdout carries the protocol', action: 'block' }]
  const r = rulesSensor([fd('src/a.py', ['print("x")']), fd('scripts/b.py', ['print("y")'])], rules)
  assert.deepEqual(r.map(f => [f.file, f.labels?.[0], f.severity]), [['src/a.py', 'no-print', 'block']])
  assert.match(r[0]?.message ?? '', /stdout carries the protocol/)
})

test('retired identifiers: removed tokens from contract files, minus generic words and names still present', () => {
  const schema = fd('schema/billing.sql', ['  promotional_discount NUMERIC,'], ['  discount_rate NUMERIC,', '  id SERIAL,'])
  assert.deepEqual(retiredIdentifiers([schema], CFG, 'CREATE TABLE billing (id SERIAL, promotional_discount NUMERIC)'), ['discount_rate'])
  assert.deepEqual(retiredIdentifiers([schema], CFG, 'discount_rate is still exported in api/v1'), [])
  assert.deepEqual(retiredIdentifiers([fd('src/billing.ts', [], ['discount_rate'])], CFG, ''), [], 'only contract files count')
})

test('retired identifiers: migration-style renames and drops in added lines', () => {
  const mig = fd('migrations/0042_rename.sql', ['ALTER TABLE billing RENAME COLUMN discount_rate TO promotional_discount;', 'ALTER TABLE billing DROP COLUMN legacy_code;'], [], 'A')
  assert.deepEqual(retiredIdentifiers([mig], CFG, 'CREATE TABLE billing (discount_rate NUMERIC)').sort(), ['discount_rate', 'legacy_code'])
  const rails = fd('migrations/20261003_rename.rb', ['    rename_column :billing, :discount_rate, :promotional_discount'], [], 'A')
  assert.deepEqual(retiredIdentifiers([rails], CFG, ''), ['discount_rate'])
})

test('contractsFromPlan reads rename and remove lines only', () => {
  const plan = '## Contracts\n- rename `discount_rate` → `promotional_discount`\n- remove `legacy_code`\n- add `currency`\n## Risks\n- rename `x`\n'
  assert.deepEqual(contractsFromPlan(plan), ['discount_rate', 'legacy_code'])
  assert.deepEqual(contractsFromPlan('## Contracts\nnone\n'), [])
})

test('retired identifiers: comment and description prose is not a contract change', () => {
  const proto = fd('api/rate.proto', ['  // discount applied at checkout'], ['  // the rate of discount we apply'])
  assert.deepEqual(retiredIdentifiers([proto], CFG, ''), [])
  const oas = fd('api/openapi.yaml', ['    description: Amount after tax'], ['    description: Amount before tax'])
  assert.deepEqual(retiredIdentifiers([oas], CFG, ''), [])
})

test('retired identifiers: migration history does not hide a schema rename; every drop on a line counts', () => {
  const schema = fd('schema/billing.sql', ['  promotional_discount NUMERIC,'], ['  discount_rate NUMERIC,'])
  assert.deepEqual(retiredIdentifiers([schema], CFG, 'CREATE TABLE billing (promotional_discount NUMERIC)'), ['discount_rate'])
  const mig = fd('migrations/2.sql', ['ALTER TABLE t DROP COLUMN aaa_col, DROP COLUMN bbb_col;'], [], 'A')
  assert.deepEqual(retiredIdentifiers([mig], CFG, '').sort(), ['aaa_col', 'bbb_col'])
})

const J = (o: object) => JSON.stringify(o, null, 2)

test('weakensConfig names every loosening and nothing else', () => {
  const before = J({ fast: { lint: 'eslint .', test: 'npm test' }, limits: { diffLines: 500 }, layers: [{ from: 'src/domain/**', mustNotImport: ['infra'], why: 'w' }], knownRed: [] })
  const after = J({ fast: { test: 'npm test' }, limits: { diffLines: 900 }, layers: [], knownRed: ['fast.test'], ignore: ['**/*.md', '**/*.lock', '**/package-lock.json', 'src/**'] })
  const reasons = weakensConfig(before, after).join('\n')
  for (const r of [/diffLines raised 500 → 900/, /fast\.lint removed/, /layer src\/domain\/\*\* removed/, /knownRed added fast\.test/, /ignore added src\/\*\*/]) assert.match(reasons, r)
  assert.deepEqual(weakensConfig(before, J({ fast: { lint: 'eslint . --max-warnings 0', test: 'npm test' }, limits: { diffLines: 400 }, layers: [{ from: 'src/domain/**', mustNotImport: ['infra', 'http'], why: 'w' }] })), [])
  assert.deepEqual(weakensConfig(before, '{ broken'), ['sensors.json no longer parses'])
})

test('onlyKnownRedRemoved accepts the ratchet and nothing more', () => {
  const before = J({ fast: { lint: 'x' }, knownRed: ['fast.lint'] })
  assert.ok(onlyKnownRedRemoved(before, J({ fast: { lint: 'x' }, knownRed: [] })))
  assert.ok(!onlyKnownRedRemoved(before, J({ fast: { lint: 'y' }, knownRed: [] })))
})

test('harnessTamper: Bash-made edits block at Stop, weakening blocks at ship, plain edits warn', () => {
  const cfgDiff = fd('.sdlc/sensors.json', ['x'], ['y'])
  const before = () => J({ limits: { diffLines: 500 } })
  const weaker = () => J({ limits: { diffLines: 900 } })
  const viaBash = harnessTamper([cfgDiff], { point: 'stop', toolEdited: new Set(), before, after: weaker })
  assert.match(viaBash[0]?.message ?? '', /outside Write\/Edit/)
  assert.equal(viaBash[0]?.severity, 'block')
  assert.equal(harnessTamper([cfgDiff], { point: 'stop', toolEdited: new Set(['.sdlc/sensors.json']), before, after: weaker })[0]?.severity, 'warn')
  const ship = harnessTamper([cfgDiff], { point: 'ship', before, after: weaker })
  assert.deepEqual([ship[0]?.severity, ship[0]?.labels], ['block', ['weakens-harness']])
  assert.equal(harnessTamper([fd('CLAUDE.md', ['more'])], { point: 'ci', before: () => '', after: () => '' })[0]?.severity, 'warn')
  assert.deepEqual(harnessTamper([fd('src/a.ts', ['x'])], { point: 'stop', toolEdited: new Set(), before, after: before }), [])
})

test('weakensRules names removed and downgraded rules only', () => {
  const rule = (id: string, action: string) => ({ id, action, pattern: 'x', message: 'm', why: 'w' })
  const before = J([rule('a', 'block'), rule('b', 'block'), rule('c', 'warn')])
  const reasons = weakensRules(before, J([rule('a', 'warn'), rule('c', 'warn')]))
  assert.deepEqual(reasons, ['rule b removed', 'rule a downgraded to warn'])
  assert.deepEqual(weakensRules(before, before), [])
})

test('isProtected compares case-insensitively when asked; a deleted sensors.json is reported', () => {
  assert.ok(!isProtected('CLAUDE.MD'))
  assert.ok(isProtected('CLAUDE.MD', true))
  assert.ok(isProtected('.sdlc/Sensors.json', true))
  const gone = harnessTamper([fd('.sdlc/sensors.json', [], ['x'], 'D')], { point: 'ship', before: () => J({}), after: () => '' })
  assert.match(gone[0]?.message ?? '', /\.sdlc\/sensors\.json deleted/)
})

test('behaviour ids come from the named section only; a test must name each one', () => {
  const spec = '## Context\nB9 is context\n## Behaviours\n- B1 given...\n- B2 given...\n- B10 given...\n## Out of scope\nB3\n'
  assert.deepEqual(behaviourIds(spec, 'Behaviours'), ['B1', 'B2', 'B10'])
  assert.deepEqual(missingBehaviours(['B1', 'B2', 'B10'], "test('B1 adds', ...)\n// covers B10\n"), ['B2'])
  assert.deepEqual(missingBehaviours(['B1'], "test('B11 other')"), ['B1'])
})

test('files matching fixtures skip the pattern sensors, others do not', () => {
  const diff = [fd('scripts/detect.spec.ts', ["it.skip('x', () => {})", 'const key = "AKIAABCDEFGHIJKLMNOP"'])]
  const fx = { ...CFG, fixtures: ['scripts/*.spec.ts'] }
  const run = (cfg: typeof CFG) => { const d = withoutFixtures(diff, cfg); return [...testTamper(d, cfg), ...secretsInDiff(d)] }
  assert.equal(run(fx).length, 0)
  assert.ok(run({ ...CFG, tests: ['scripts/*.spec.ts'] }).length >= 2)
})

test('weakensConfig counts added fixtures and removed testSupport globs', () => {
  const reasons = weakensConfig(J({ testSupport: ['a/**', 'b/**'] }), J({ testSupport: ['a/**'], fixtures: ['x/**'] })).join('\n')
  assert.match(reasons, /fixtures added x\/\*\*/)
  assert.match(reasons, /testSupport glob removed b\/\*\*/)
  assert.deepEqual(weakensConfig(J({ fixtures: ['x/**'] }), J({})), [])
})

test('a deleted test file matching fixtures is still reported', () => {
  const cfg = { ...CFG, tests: ['scripts/*.spec.ts'], fixtures: ['scripts/*.spec.ts'] }
  const d = withoutFixtures([fd('scripts/a.spec.ts', [], ['it("x", () => {})'], 'D')], cfg)
  assert.ok(testTamper(d, cfg).some(f => f.message === 'test file deleted'))
})

test('size warns once per file on added lines over limits.lineChars, not at edit time', () => {
  const cfg = { ...CFG, limits: { ...CFG.limits, lineChars: 20 } }
  const added = [{ n: 3, text: 'x'.repeat(21) }, { n: 4, text: 'ok' }, { n: 9, text: 'y'.repeat(30) }]
  const d = { file: 'src/a.ts', status: 'M' as const, added, removed: [] }
  const f = size([d], cfg, { 'src/a.ts': 10 }, 'stop')
  assert.deepEqual(f.map(x => [x.sensor, x.severity, x.line, x.message]), [['size', 'warn', 3, '2 added line(s) over 20 characters']])
  assert.deepEqual(size([d], cfg, { 'src/a.ts': 10 }, 'edit'), [])
})

test('weakensConfig names v0.4 weakenings: a gate removed, a cap or budget raised, a level or category removed', () => {
  const before = JSON.stringify({ gates: { M: ['plan'] }, levels: { unit: 'npm test' }, quality: { lint: { cmd: 'x', count: 'lines' } } })
  const after = JSON.stringify({ gates: { M: [], L: ['plan'] }, ratchet: { build: 4, usd: { test: 9 } } })
  const reasons = weakensConfig(before, after)
  assert.ok(reasons.includes('gate M removed plan'))
  assert.ok(reasons.includes('gate L removed spec'))
  assert.ok(reasons.includes('ratchet.build raised 2 → 4'))
  assert.ok(reasons.includes('ratchet.usd.test raised 2 → 9'))
  assert.ok(reasons.includes('levels.unit removed'))
  assert.ok(reasons.includes('quality.lint removed'))
  assert.deepEqual(weakensConfig(after, before).filter(r => /gate|ratchet|removed/.test(r)), [], 'tightening is not weakening')
})

test('weakensConfig flags changed and added declared level and quality commands', () => {
  const cfg = (o: object) => JSON.stringify(o)
  const base = { levels: { unit: 'npm test' }, quality: { lint: { cmd: 'eslint .', count: 'lines' } } }
  const only = (r: string[]) => r.filter(x => /^(levels|quality)\./.test(x))
  assert.deepEqual(only(weakensConfig(cfg(base), cfg(base))), [])
  assert.deepEqual(only(weakensConfig(cfg(base), cfg({ ...base, levels: { unit: 'true' } }))), ['levels.unit changed'])
  assert.deepEqual(only(weakensConfig(cfg(base), cfg({ ...base, quality: { lint: { cmd: 'true', count: 'lines' } } }))), ['quality.lint changed'])
  assert.deepEqual(only(weakensConfig(cfg(base), cfg({ ...base, quality: { lint: { cmd: 'eslint .', count: 'exit' } } }))), ['quality.lint changed'])
  assert.deepEqual(only(weakensConfig(cfg(base), cfg({ ...base, levels: { unit: 'npm test', api: 'x' } }))), ['levels.api added'])
  assert.deepEqual(only(weakensConfig(cfg(base), cfg({ ...base, quality: { ...base.quality, deps: { cmd: 'x', count: 'exit' } } }))), ['quality.deps added'])
})

test('the repo-root plugin marketplace and the vendored mod are protected, case-insensitively', () => {
  for (const f of ['.claude-plugin/marketplace.json', '.sdlc/mod/hooks/register.ts']) assert.ok(isProtected(f) && isProtected(f.toUpperCase(), true), f)
})

test('legacy sdlc names stay honoured: protected old workflow, both secret markers', () => {
  assert.ok(isProtected('.github/workflows/sdlc-check.yml'))
  assert.ok(isProtected('.github/workflows/rig-check.yml'))
  const line = 'const key = "AKIAABCDEFGHIJKLMNOP"'
  assert.equal(secretsInDiff([fd('src/c.js', [line + ' // sdlc:allow-secret fixture'])]).length, 1)
  assert.equal(secretsInDiff([fd('src/c.js', [line + ' // rig:allow-secret fixture'])]).length, 1)
  assert.equal(secretsInDiff([fd('src/c.js', [line])]).length, 1)
})

test('secrets: provider keys, JWTs and unquoted env-file secrets are caught', () => {
  for (const line of ['key = AIzaSyA1234567890abcdefghijklmnopqrstuv', 'const k = "sk_live_abcdefghijklmnop1234"', 'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'DB_PASSWORD=hunter2hunter2hunter2', 'export API_KEY=abcdef0123456789abcdef'])
    assert.equal(secretsInDiff([fd('config/prod.env', [line])]).length, 1, line)
  for (const line of ['DB_PASSWORD=${DB_PASSWORD}', 'API_KEY=', 'TOKEN=$TOKEN', 'const password = process.env.PASSWORD'])
    assert.equal(secretsInDiff([fd('config/prod.env', [line])]).length, 0, line)
})

test('size: a file too large to scan is blocked, never silently skipped', () => {
  const f = size([{ file: 'dump.sql', status: 'A', added: [], removed: [], binary: true, oversize: true }], CFG, {}, 'stop')
  assert.equal(f.length, 1)
  assert.equal(f[0]?.sensor, 'unscanned', 'its own sensor name, so a size waiver cannot cover it')
  assert.match(f[0]?.message ?? '', /not scanned/)
})

test('githooks config defaults to ship, parses, and turning pre-push off counts as weakening', () => {
  assert.deepEqual(parseConfig('').config.githooks, { prePush: 'ship', budgetMs: 300_000 })
  const off = parseConfig('{"githooks":{"prePush":"off","budgetMs":1000}}')
  assert.deepEqual(off.errors, [])
  assert.deepEqual(off.config.githooks, { prePush: 'off', budgetMs: 1000 })
  assert.match(parseConfig('{"githooks":{"prePush":"later"}}').errors.join(), /githooks\.prePush must be/)
  assert.match(parseConfig('{"githooks":{"budgetMs":-1}}').errors.join(), /githooks\.budgetMs must be a positive number/)
  assert.match(parseConfig('{"githooks":{"nope":1}}').errors.join(), /githooks: unknown key "nope"/)
  assert.match(parseConfig('{"githooks":5}').errors.join(), /githooks must be/)
  assert.ok(weakensConfig('{}', '{"githooks":{"prePush":"off"}}').some(r => /prePush/.test(r)))
  assert.ok(weakensConfig('{}', '{"githooks":{"budgetMs":900000}}').some(r => /budgetMs/.test(r)))
  assert.deepEqual(weakensConfig('{}', '{"githooks":{"budgetMs":1000}}'), [])
})

test('the git hook scripts are protected harness files', () => {
  assert.ok(isProtected('.sdlc/githooks/pre-commit'))
  assert.ok(isProtected('.sdlc/githooks/pre-push'))
})

test('a file crossing the line limit blocks at edit and stop, and only warns at ship and ci', () => {
  const cfg = parseConfig(JSON.stringify({ limits: { fileLines: 10 } })).config
  const crossing: FileDiff = { file: 'src/a.ts', status: 'M', added: Array.from({ length: 5 }, (_, i) => ({ n: i + 1, text: 'x' })), removed: [] } // 12 lines now, 7 before: crossed
  for (const point of ['edit', 'stop'] as const) {
    const f = size([crossing], cfg, { 'src/a.ts': 12 }, point).find(x => x.sensor === 'size')
    assert.equal(f?.severity, 'block', point)
    assert.match(f?.message ?? '', /grew to 12 lines \(limit 10\)/)
  }
  for (const point of ['ship', 'ci'] as const) assert.equal(size([crossing], cfg, { 'src/a.ts': 12 }, point).find(x => x.sensor === 'size')?.severity, 'warn', point)
})

test('a file that was already over the limit is not blamed for growing', () => {
  const cfg = parseConfig(JSON.stringify({ limits: { fileLines: 10 } })).config
  const d: FileDiff = { file: 'src/a.ts', status: 'M', added: [{ n: 1, text: 'x' }], removed: [] }
  assert.deepEqual(size([d], cfg, { 'src/a.ts': 30 }, 'edit').filter(f => f.message.includes('grew')), [])
})
