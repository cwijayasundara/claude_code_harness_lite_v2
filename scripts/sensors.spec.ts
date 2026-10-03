import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG as CFG, type FileDiff, type SensorConfig, type Rule } from './model.ts'
import { testTamper, suppressions, TAMPER_PATTERNS, layering, size, secretsInDiff, rulesSensor, retiredIdentifiers, contractsFromPlan } from './sensors.ts'

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

test('size warns when a file crosses the line limit, and the diff limit blocks only from ship on', () => {
  const big = fd('src/a.ts', Array.from({ length: 30 }, () => 'x'))
  assert.equal(size([big], CFG, { 'src/a.ts': 410 }, 'stop')[0]?.severity, 'warn')
  assert.equal(size([big], CFG, { 'src/a.ts': 900 }, 'stop').length, 0, 'already over before this diff: no news')
  const huge = fd('src/b.ts', Array.from({ length: 600 }, () => 'y'), [], 'A')
  assert.equal(size([huge], CFG, { 'src/b.ts': 600 }, 'stop').find(f => !f.file)?.severity, 'warn')
  assert.equal(size([huge], CFG, { 'src/b.ts': 600 }, 'ship').find(f => !f.file)?.severity, 'block')
  assert.equal(size([fd('docs/x.md', Array.from({ length: 900 }, () => 'z'))], CFG, {}, 'ship').length, 0, 'ignored files do not count')
})

test('secrets in added lines block; the allow comment opts out', () => {
  assert.equal(secretsInDiff([fd('src/c.js', ['const key = "AKIAABCDEFGHIJKLMNOP"'])]).length, 1)
  assert.equal(secretsInDiff([fd('src/c.js', ['const key = "AKIAABCDEFGHIJKLMNOP" // sdlc:allow-secret test fixture'])]).length, 0)
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
