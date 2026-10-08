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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

// One bare remote, two clones (A and B), each with its own .sdlc ledger.
function team(): { a: string; b: string; remote: string } {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-'))
  execFileSync('git', ['init', '-q', '--bare', remote])
  const a = makeRepo()
  gitIn(a, 'remote', 'add', 'origin', remote)
  gitIn(a, 'push', '-q', 'origin', 'main')
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-clone-'))
  execFileSync('git', ['clone', '-q', remote, b])
  for (const r of [a, b]) write(r, '.sdlc/sensors.json', JSON.stringify({ budget: { teamMonthlyUsd: 10, changeUsd: { M: 4 } } }))
  return { a, b, remote }
}
const ledger = (repo: string, rows: object[]) => fs.appendFileSync(path.join(repo, '.sdlc/usage.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''))
const spendRow = (usd: number, change: string | null = null) => ({ at: new Date().toISOString(), kind: 'main', change, stage: 'build', usd })
const status = (repo: string, extra: string[] = []) => JSON.parse(sdlc(repo, ['spend', 'status', '--json', ...extra]).stdout)
const lsRef = (repo: string) => gitIn(repo, 'ls-tree', '-r', '--name-only', 'refs/rig/spend').split('\n').filter(Boolean)

test('a fresh clone without the ref counts this clone only and says so', () => {
  const { a } = team()
  ledger(a, [spendRow(2)])
  const s = status(a)
  assert.equal(s.spentUsd, 2)
  assert.equal(s.localOnly, true)
  assert.match(sdlc(a, ['spend', 'status']).stdout, /team total: this clone only/)
})

test('two clones publish; each sees the other, its own local rows count once, working tree and index untouched', () => {
  const { a, b } = team()
  sdlc(a, ['new', 'add-login', '--type', 'feature', '--tier', 'M'])
  ledger(a, [spendRow(3, 'add-login')])
  ledger(b, [spendRow(4, 'add-login'), spendRow(1)])
  const before = gitIn(a, 'status', '--porcelain') // after `new`: publish itself must not change it
  assert.equal(sdlc(a, ['spend', 'publish']).code, 0)
  assert.equal(sdlc(b, ['spend', 'publish']).code, 0, 'B publishes on top of A (fetch, rebuild, push)')
  assert.equal(gitIn(a, 'status', '--porcelain'), before)
  ledger(a, [spendRow(1)]) // unpushed: still counted, once
  const s = status(a)
  assert.equal(s.spentUsd, 9)
  assert.equal(s.localOnly, false)
  assert.equal(s.sources.length, 1, 'B is the one other source')
  assert.equal(s.level, 'tight')
  assert.equal(status(a, ['--change', 'add-login']).change.spentUsd, 7)
  const month = new Date().toISOString().slice(0, 7)
  assert.equal(lsRef(b).filter(p => p.startsWith(`${month}/`)).length, 2)
})

test('the clone id lives in the ledger: the first spend-id row wins, and a new ledger starts a new file without double counting', () => {
  const { a } = team()
  ledger(a, [spendRow(2)])
  sdlc(a, ['spend', 'publish'])
  const first = (JSON.parse(fs.readFileSync(path.join(a, '.sdlc/usage.jsonl'), 'utf8').split('\n').find(l => l.includes('spend-id')) ?? '{}') as { id: string }).id
  assert.match(first, /^[0-9a-f]{12}$/)
  ledger(a, [{ at: new Date().toISOString(), kind: 'event', change: null, stage: null, event: 'spend-id', id: 'ffffffffffff' }])
  sdlc(a, ['spend', 'publish'])
  assert.ok(!lsRef(a).some(p => p.includes('ffffffffffff')), 'a later forged id is ignored')
  fs.rmSync(path.join(a, '.sdlc/usage.jsonl'))
  ledger(a, [spendRow(1)])
  sdlc(a, ['spend', 'publish'])
  assert.equal(status(a, ['--no-fetch']).spentUsd, 3, 'old file (2) plus the new clone file (1)')
})

test('offline: publish warns and exits 0; status uses the cached copy and names its age', () => {
  const { a, b, remote } = team()
  ledger(b, [spendRow(4)])
  sdlc(b, ['spend', 'publish'])
  sdlc(a, ['spend', 'status'])
  fs.rmSync(remote, { recursive: true, force: true })
  ledger(a, [spendRow(1)])
  const p = sdlc(a, ['spend', 'publish'])
  assert.equal(p.code, 0)
  assert.match(p.stderr, /spend: push of refs\/rig\/spend was refused or timed out/)
  const text = sdlc(a, ['spend', 'status']).stdout
  assert.match(text, /fetch failed; using the copy from /)
  assert.equal(status(a).spentUsd, 5)
})

test('a malformed file on the ref is skipped with a warning; the others count', () => {
  const { a, b } = team()
  ledger(b, [spendRow(4)])
  sdlc(b, ['spend', 'publish'])
  const month = new Date().toISOString().slice(0, 7)
  const env = { ...process.env, GIT_INDEX_FILE: path.join(os.tmpdir(), `bad-${process.pid}.index`) }
  const tip = gitIn(b, 'rev-parse', 'refs/rig/spend')
  execFileSync('git', ['read-tree', tip], { cwd: b, env })
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: b, input: '{"id":"x"}' }).toString().trim()
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${month}/eeeeeeeeeeee.json`], { cwd: b, env })
  const tree = execFileSync('git', ['write-tree'], { cwd: b, env }).toString().trim()
  const c = execFileSync('git', ['commit-tree', tree, '-p', tip, '-m', 'bad'], { cwd: b, env }).toString().trim()
  gitIn(b, 'push', '-q', '--no-verify', 'origin', `${c}:refs/rig/spend`)
  const r = sdlc(a, ['spend', 'status'])
  assert.match(r.stdout + r.stderr, new RegExp(`skipped ${month}/eeeeeeeeeeee.json`))
  assert.equal(status(a).spentUsd, 4)
})

test('previous month: publish also rewrites last month\'s file from the ledger', () => {
  const { a } = team()
  const last = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0, 23)).toISOString()
  ledger(a, [{ ...spendRow(2), at: last }, spendRow(1)])
  sdlc(a, ['spend', 'publish'])
  assert.equal(lsRef(a).length, 2)
})

test('CI publish adds to the ci file once per run key', () => {
  const { a } = team()
  for (let i = 0; i < 2; i++) assert.equal(sdlc(a, ['spend', 'publish', '--ci', '--usd', '0.75', '--run', '9-1-review']).code, 0)
  sdlc(a, ['spend', 'publish', '--ci', '--usd', '0.25', '--run', '9-2-review'])
  assert.equal(status(a).spentUsd, 1)
  assert.equal(sdlc(a, ['spend', 'publish', '--ci', '--usd', '-1', '--run', '9-3-review']).code, 0)
  assert.equal(status(a).spentUsd, 1, 'a negative cost is refused without failing the job')
})

test('notify toasts each newly crossed level once', () => {
  const { a } = team()
  ledger(a, [spendRow(6)])
  assert.match(sdlc(a, ['spend', 'notify']).stdout, /rig budget notice: team \$6\.00 of \$10/)
  assert.equal(sdlc(a, ['spend', 'notify']).stdout.trim(), '')
  ledger(a, [spendRow(3)])
  assert.match(sdlc(a, ['spend', 'notify']).stdout, /rig budget tight/)
})

test('next --json carries pressure and budget; tight eases review effort; round caps do not move', () => {
  const { a } = team()
  sdlc(a, ['new', 'add-login', '--type', 'feature', '--tier', 'M'])
  const normal = JSON.parse(sdlc(a, ['next', 'add-login', '--json']).stdout)
  assert.equal(normal.pressure, 'normal')
  ledger(a, [spendRow(8.5)])
  const tight = JSON.parse(sdlc(a, ['next', 'add-login', '--json']).stdout)
  assert.equal(tight.pressure, 'tight')
  assert.equal(tight.budget.level, 'tight')
  assert.equal(tight.routes.reviewer.effort, 'medium')
  assert.equal(tight.routes.implementer.effort, normal.routes.implementer.effort)
  assert.equal(tight.round, normal.round)
  assert.equal(JSON.parse(sdlc(a, ['status', '--json', '--band']).stdout).budget.spentUsd, 8.5)
})

test('full-route is human only and turns downshift off for one change; warnings stay', () => {
  const { a } = team()
  sdlc(a, ['new', 'add-login', '--type', 'feature', '--tier', 'M'])
  ledger(a, [spendRow(9)])
  assert.equal(sdlc(a, ['approve', 'add-login', 'full-route']).code, 3, 'a model cannot grant it')
  const r = sdlc(a, ['approve', 'add-login', 'full-route'], { env: { SDLC_HUMAN: '1' } })
  assert.match(r.stdout, /approved add-login full-route/)
  const next = JSON.parse(sdlc(a, ['next', 'add-login', '--json']).stdout)
  assert.equal(next.pressure, 'normal')
  assert.equal(next.budget.level, 'tight')
})

test('the scorecard has a change budget row and metrics a budget block', () => {
  const { a } = team()
  sdlc(a, ['new', 'add-login', '--type', 'feature', '--tier', 'M'])
  ledger(a, [spendRow(5, 'add-login')])
  assert.match(sdlc(a, ['scorecard', 'add-login']).stdout, /\| Change budget \| \$5\.00 of \$4 \(125%\) · over by \$1\.00 \|/)
  const m = JSON.parse(sdlc(a, ['metrics', '--json']).stdout).metrics.budget
  assert.equal(m.spentUsd, 5)
  assert.equal(m.budgetUsd, 10)
  assert.equal(m.level, 'notice')
  assert.equal(m.changeBudgetHits, 1)
})
