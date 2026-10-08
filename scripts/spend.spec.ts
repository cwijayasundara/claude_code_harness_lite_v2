// Spend governance (spec 2026-10-08): rollups, projection, levels and pressure; the ref I/O tests follow in Task 3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UsageRow } from './core.ts'
import { rollup, projection, levelOf, pressureOf, parseRollup, teamSpent, changeSpent, monthOf, prevMonth, changeBudgetText, DEFAULT_BUDGET, type Rollup } from './spend.ts'
import { parseConfig } from './model.ts'

const row = (at: string, usd: unknown, o: Partial<UsageRow> = {}): UsageRow => ({ at, kind: 'main', change: null, stage: null, usd: usd as number, ...o })
const R = (id: string, month: string, usd: number, byChange: Record<string, number> = {}): Rollup => ({ id, month, through: `${month}-05T00:00:00.000Z`, usd, byDay: {}, byChange })

test('rollup counts main rows of the month only, buckets change: null as (none), and treats bad usd as 0', () => {
  const rows = [
    row('2026-10-01T10:00:00.000Z', 1.5, { change: 'a' }),
    row('2026-10-01T23:59:59.000Z', 0.5),
    row('2026-10-02T00:00:00.000Z', -3, { change: 'a' }),
    row('2026-10-02T01:00:00.000Z', Number.NaN),
    row('2026-10-02T02:00:00.000Z', 2, { kind: 'agent', change: 'a' }),
    row('2026-09-30T23:00:00.000Z', 9, { change: 'a' }),
  ]
  assert.deepEqual(rollup(rows, 'abcdefabcdef', '2026-10', '2026-10-02T03:00:00.000Z'), {
    id: 'abcdefabcdef', month: '2026-10', through: '2026-10-02T03:00:00.000Z', usd: 2,
    byDay: { '2026-10-01': 2, '2026-10-02': 0 }, byChange: { a: 1.5, '(none)': 0.5 },
  })
})

test('projection scales by elapsed UTC days with a floor of one day', () => {
  assert.equal(projection(10, '2026-10-01T06:00:00.000Z'), 310)
  assert.equal(projection(100, '2026-10-16T00:00:00.000Z'), 206.6667)
  assert.equal(projection(300, '2026-10-31T23:59:59.999Z'), 300)
  assert.equal(monthOf('2026-10-08T17:00:00.000Z'), '2026-10')
  assert.equal(prevMonth('2026-01-03T00:00:00.000Z'), '2025-12')
})

test('levels: none without a budget, projection raises notice only, thresholds follow warnAt', () => {
  const w: [number, number, number] = [50, 80, 100]
  assert.equal(levelOf(999, null, w), 'none')
  assert.equal(levelOf(10, 100, w), 'ok')
  assert.equal(levelOf(10, 100, w, 60), 'notice')
  assert.equal(levelOf(10, 100, w, 500), 'notice', 'a projection never raises tight or over')
  assert.equal(levelOf(50, 100, w), 'notice')
  assert.equal(levelOf(80, 100, w), 'tight')
  assert.equal(levelOf(100, 100, w), 'over')
  assert.equal(levelOf(30, 100, [20, 30, 90]), 'tight')
})

test('pressure is tight when team or change is tight or over, unless downshift is off or the change has full-route', () => {
  const v = (team: string, change?: string) => ({ level: team, change: change ? { slug: 'c', spentUsd: 0, budgetUsd: 1, pct: 0, level: change } : null }) as never
  assert.equal(pressureOf(v('ok'), DEFAULT_BUDGET, false), 'normal')
  assert.equal(pressureOf(v('notice', 'notice'), DEFAULT_BUDGET, false), 'normal')
  assert.equal(pressureOf(v('tight'), DEFAULT_BUDGET, false), 'tight')
  assert.equal(pressureOf(v('ok', 'over'), DEFAULT_BUDGET, false), 'tight')
  assert.equal(pressureOf(v('over'), { ...DEFAULT_BUDGET, downshift: false }, false), 'normal')
  assert.equal(pressureOf(v('over'), DEFAULT_BUDGET, true), 'normal')
})

test('parseRollup accepts a valid file and rejects bad ids, months, negative or non-finite dollars', () => {
  const ok = R('abcdefabcdef', '2026-10', 3, { a: 3 })
  assert.deepEqual(parseRollup(JSON.stringify(ok)), ok)
  assert.deepEqual(parseRollup(JSON.stringify({ ...R('ci', '2026-10', 1), runs: ['1-1-review'] }))?.runs, ['1-1-review'])
  for (const bad of [{ ...ok, id: 'Bob' }, { ...ok, month: '2026-1' }, { ...ok, usd: -1 }, { ...ok, byChange: { a: 'x' } }, { ...ok, runs: [1] }]) assert.equal(parseRollup(JSON.stringify(bad)), null)
  assert.equal(parseRollup('{not json'), null)
})

test('team spend replaces this clone\'s pushed file with its local rollup; change spend adds every other file', () => {
  const files = [R('aaaaaaaaaaaa', '2026-10', 5, { x: 2 }), R('bbbbbbbbbbbb', '2026-10', 7, { x: 1 }), R('bbbbbbbbbbbb', '2026-09', 50, { x: 4 }), R('ci', '2026-10', 1, { x: 0.5 })]
  const local = R('aaaaaaaaaaaa', '2026-10', 6)
  assert.equal(teamSpent(files, 'aaaaaaaaaaaa', local), 14)
  assert.equal(teamSpent(files, null, R('local', '2026-10', 6)), 19)
  const rows = [row('2026-10-01T00:00:00.000Z', 3, { change: 'x' }), row('2026-10-01T00:00:00.000Z', 9, { change: 'y' })]
  assert.equal(changeSpent(files, 'aaaaaaaaaaaa', rows, 'x'), 8.5)
})

test('changeBudgetText says none set, a share, or how far over', () => {
  assert.equal(changeBudgetText(null), 'none set')
  assert.equal(changeBudgetText({ slug: 'x', spentUsd: 9.1, budgetUsd: 20, pct: 45.5, level: 'ok' }), '$9.10 of $20 (46%)')
  assert.equal(changeBudgetText({ slug: 'x', spentUsd: 23, budgetUsd: 20, pct: 115, level: 'over' }), '$23.00 of $20 (115%) · over by $3.00')
})

test('budget config: defaults, a full section, and errors for each bad field', () => {
  assert.deepEqual(parseConfig('{}').config.budget, DEFAULT_BUDGET)
  const full = parseConfig(JSON.stringify({ budget: { teamMonthlyUsd: 500, changeUsd: { S: 5, M: 20, L: 60 }, warnAt: [40, 70, 100], downshift: false } }))
  assert.deepEqual(full.errors, [])
  assert.deepEqual(full.config.budget, { teamMonthlyUsd: 500, changeUsd: { S: 5, M: 20, L: 60 }, warnAt: [40, 70, 100], downshift: false })
  const bad = parseConfig(JSON.stringify({ budget: { teamMonthlyUsd: -1, changeUsd: { X: 5, M: 0 }, warnAt: [80, 50, 100], downshift: 'no', extra: 1 } })).errors.join('\n')
  for (const want of ['budget.teamMonthlyUsd', 'budget.changeUsd: unknown tier "X"', 'budget.changeUsd.M', 'budget.warnAt', 'budget.downshift', 'budget: unknown key "extra"']) assert.match(bad, new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(parseConfig('{"budget": 5}').errors.join('\n'), /budget must be/)
  assert.deepEqual(parseConfig(JSON.stringify({ budget: DEFAULT_BUDGET })).errors, [], 'the default round-trips')
})
