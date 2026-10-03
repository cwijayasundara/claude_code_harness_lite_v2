import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG as CFG, type FileDiff } from './model.ts'
import { testTamper, suppressions, TAMPER_PATTERNS } from './sensors.ts'

export const fd = (file: string, added: string[] = [], removed: string[] = [], status: FileDiff['status'] = 'M'): FileDiff => ({
  file, status, added: added.map((text, i) => ({ n: i + 1, text })), removed: removed.map((text, i) => ({ n: i + 1, text })),
})
const blocks = <T extends { severity: string }>(fs: T[]): T[] => fs.filter(f => f.severity === 'block')

// Every tamper row has a positive and a negative fixture (spec §5.4).
const FIXTURES: Record<string, [string, string]> = {
  'skip-or-only': ["it.skip('adds', () => {})", "const rest = myit.skip(2)"],
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
