# Spend Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rig shows team spend per month and per change across every clone of a repo, warns at 50, 80 and 100% of soft budgets, and downshifts review effort and an Opus coordinator under pressure, without ever stopping work.

**Architecture:**
- **`scripts/spend.ts`** holds the pure math (rollup, projection, levels, pressure) and the git I/O for `refs/rig/spend`. Each clone owns one file per month on that ref, written with plumbing and a temporary index, and pushed with `--no-verify`.
- **Wiring:** `graph.step()` reads the budget view and passes pressure to `routing.route()`. The mod rewrites main-loop Opus steps to Sonnet under pressure and shows a budget segment in the band.

**Tech Stack:**
- Node ≥ 22.18 TypeScript (type stripping), with `node:test` for `scripts/*.spec.ts`.
- `claude-code/testing` for `tests/register.test.ts`.
- git plumbing.
- GitHub Actions YAML.

**Spec:** `docs/superpowers/specs/2026-10-08-spend-governance-design.md`. Read §12 (Amendments) first: it overrides earlier sections.

## Global Constraints

- **Never run rig on this repo.** No `sdlc.ts check --at ci`, no `/rig:start`, no change records. Verify with `npm run typecheck`, `node --disable-warning=ExperimentalWarning --test scripts/<file>.spec.ts`, `npm test` (which includes `claude plugin test .`) and `npm run test:integration:self`.
- **Nothing in this plan pauses, blocks or fails a push, a node or a turn.** Spend code failures print a warning and exit 0.
- **Count main rows only** (`kind: "main"`). Agent rows are already inside the main row's `usd`. Rows with `change: null` count under the key `(none)`.
- **Dollars:** an invalid or negative `usd` counts as 0. Round stored values with `Number(n.toFixed(4))`.
- **Dates and months are UTC.** `month` is `YYYY-MM`, the day key is `YYYY-MM-DD`, both sliced from ISO strings.
- **Ref:** `refs/rig/spend`, with file path `<YYYY-MM>/<id>.json`. `id` is 12 lowercase hex characters per clone, or `ci`.
- **Push:** `git push --no-verify`, 10 s timeout. Commit author and committer are `rig <rig@localhost>`.
- **Coordinator downshift model id:** `claude-sonnet-5-5` (pinned, never an alias).
- **Default `warnAt`:** `[50, 80, 100]`. Default `downshift`: `true`. Default budgets: none.
- **Review roles eased under pressure:** `reviewer`, `referee`, `slice-review`, by one effort step (high→medium, medium→low). Models never change. Floors still clamp.
- **Not touched:**
  - `ratchet.usd`, round caps, implementer routing, retries and gates;
  - `FOLLOWUP_CAP` in `scripts/pr.ts`;
  - the CI review's tier picker.
- **Commits:** end every commit message with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The `git commit -m` lines below omit it for brevity; add it.
- **Style:**
  - Match the surrounding code: dense one-line helpers, a comment only where the why is not obvious, no new dependencies.
  - Every new module starts with a one-line `//` purpose comment.

## Review Focus

1. **A clone that never publishes.** Its git hooks are not installed, or `core.hooksPath` belongs to someone else. Expected: `spend status` lists every counted source by id and `through` time, so the gap is visible. `sdlc.ts pr` also publishes, so shipping still reaches the ref. Pinned in Task 3: a test checks that status lists its sources. `pr` publishing is wired in Task 3 Step 5 and has no test of its own (it needs `gh`); the reviewer checks those three call sites.
2. **Id and ledger coming apart.** The ledger is deleted or recreated. Expected: a new id starts a fresh file holding only new rows, and nothing is counted twice. A forged second `spend-id` row is ignored, because the first one wins. Pinned in Task 3.
3. **A stale cache after time offline.** Expected: status and the band show the cached copy's age ("as of …") and never present it as current. Offline means lower warnings, never a false downshift. Pinned in Task 3 (status text) and Task 6 (band age).
4. **A fresh clone or CI checkout without the ref.** Expected: status says `team total: this clone only` and publish creates the ref. Pinned in Task 3.
5. **Pressure changing in the middle of a node.** Expected: only routes change (review effort), on the next `next --json`. Caps and blocks never move, and the coordinator switch is sticky for the session. Pinned in Task 4 (caps unchanged under pressure) and Task 6 (sticky).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/spend.ts` | create | Types, pure math, ref I/O, budget view, notices, `spend` CLI |
| `scripts/spend.spec.ts` | create | Unit tests for the pure math; two-clone ref tests against a bare remote |
| `scripts/routing.ts` | modify | `Pressure` type, `pressure` param on `route()` and `routes()` |
| `scripts/model.ts`, `scripts/configparse.ts`, `scripts/sensors.ts` | modify | `budget` config, parsing, weakening rules |
| `scripts/core.ts` | modify | `UsageRow.id`, new gitignored files |
| `scripts/graph.ts` | modify | `Step.pressure`, `Step.budget` |
| `scripts/ratchet.ts`, `scripts/sdlc.ts` | modify | `fullRoute` flag, `approve <slug> full-route`, `spend` command, publish after push check, top-level `budget` in status |
| `scripts/githooks.ts`, `scripts/pr.ts`, `scripts/vendor.ts` | modify | Publish after a passing push and after `pr`; vendor `spend` |
| `scripts/scorecard.ts`, `scripts/metrics.ts` | modify | Change budget row; `budget` block |
| `types/index.d.ts`, `hooks/register.ts`, `hooks/band.tsx`, `hooks/shared.ts`, `hooks/mission.tsx`, `tests/register.test.ts` | modify | Coordinator switch, band segment, notices, mission line |
| `templates/rig-review.yml`, `templates/rig-triage.yml`, `templates/rig-watch.yml` | modify | Read cost; a `spend` job publishes it |
| `README.md`, `DESIGN.md`, `CHANGELOG.md`, `skills/metrics/SKILL.md`, `skills/next/SKILL.md` | modify | Docs |

## Shared types (repeated in each task that uses them)

```ts
// scripts/routing.ts
export type Pressure = 'normal' | 'tight'
// scripts/model.ts (config lives with the other defaults; spend.ts re-exports both)
export type BudgetConfig = { teamMonthlyUsd: number | null; changeUsd: Partial<Record<Tier, number>>; warnAt: [number, number, number]; downshift: boolean }
export const DEFAULT_BUDGET: BudgetConfig = { teamMonthlyUsd: null, changeUsd: {}, warnAt: [50, 80, 100], downshift: true }
// scripts/spend.ts
export type Rollup = { id: string; month: string; through: string; usd: number; byDay: Record<string, number>; byChange: Record<string, number>; runs?: string[] }
export type Level = 'none' | 'ok' | 'notice' | 'tight' | 'over'
export type Source = { id: string; through: string }
export type ChangeBudget = { slug: string; spentUsd: number; budgetUsd: number | null; pct: number | null; level: Level }
export type BudgetView = { month: string; spentUsd: number; projectedUsd: number; budgetUsd: number | null; pct: number | null; level: Level; asOf: string | null; sources: Source[]; localOnly: boolean; change: ChangeBudget | null }
```

---

### Task 1: Pure spend math

**Files:**
- Create: `scripts/spend.ts`
- Modify: `scripts/routing.ts` (add `Pressure` type only)
- Modify: `scripts/model.ts` (add `BudgetConfig` and `DEFAULT_BUDGET` only; `SensorConfig` changes come in Task 2)
- Test: `scripts/spend.spec.ts`

**Import rule:** `core.ts` imports `model.ts`, so `model.ts` must never import `spend.ts`. `spend.ts` imports only from `core.ts`, `model.ts` and (types only) `routing.ts`. It never imports `graph.ts` or `check.ts`; callers pass config and change in.

**Interfaces:**
- Consumes: `UsageRow`, `Tier` from `scripts/core.ts`.
- Produces (from `scripts/spend.ts`): the shared types above, plus:
  - `monthOf(iso: string): string`
  - `prevMonth(iso: string): string`
  - `rollup(rows: UsageRow[], id: string, month: string, through: string): Rollup`
  - `projection(spent: number, nowIso: string): number`
  - `levelOf(spent: number, budget: number | null, warnAt: [number, number, number], projected?: number): Level`
  - `pressureOf(view: Pick<BudgetView, 'level' | 'change'>, cfg: BudgetConfig, fullRoute: boolean): Pressure`
  - `parseRollup(text: string): Rollup | null`
  - `teamSpent(files: Rollup[], selfId: string | null, local: Rollup): number`
  - `changeSpent(files: Rollup[], selfId: string | null, rows: UsageRow[], slug: string): number`
  - `changeBudgetText(c: ChangeBudget | null): string`
  - `HOT: Level[]`
  - `DEFAULT_BUDGET: BudgetConfig`
- Produces (from `scripts/routing.ts`): `export type Pressure = 'normal' | 'tight'`.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/spend.spec.ts
// Spend governance (spec 2026-10-08): rollups, projection, levels and pressure; the ref I/O tests follow in Task 3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UsageRow } from './core.ts'
import { rollup, projection, levelOf, pressureOf, parseRollup, teamSpent, changeSpent, monthOf, prevMonth, changeBudgetText, DEFAULT_BUDGET, type Rollup } from './spend.ts'

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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts`
Expected: FAIL, `Cannot find module './spend.ts'`.

- [ ] **Step 3: Add `Pressure` to `scripts/routing.ts`** (below the `Route` type)

```ts
// Budget pressure (spend governance spec §7): tight eases review effort one step; floors still clamp.
export type Pressure = 'normal' | 'tight'
```

- [ ] **Step 4a: Add the budget config type and default to `scripts/model.ts`** (above `SensorConfig`)

```ts
// Soft budgets (spend governance spec §5). No budget set: spend shows, nothing warns or downshifts.
export type BudgetConfig = { teamMonthlyUsd: number | null; changeUsd: Partial<Record<'S' | 'M' | 'L', number>>; warnAt: [number, number, number]; downshift: boolean }
export const DEFAULT_BUDGET: BudgetConfig = { teamMonthlyUsd: null, changeUsd: {}, warnAt: [50, 80, 100], downshift: true }
```

- [ ] **Step 4b: Write the pure part of `scripts/spend.ts`**

```ts
// Spend governance (spec 2026-10-08): team spend per month and per change from every clone's rollup on refs/rig/spend plus this
// clone's ledger; soft levels and downshift pressure. Nothing here blocks: failures warn and exit 0.
import type { UsageRow } from './core.ts'
import { DEFAULT_BUDGET, type BudgetConfig } from './model.ts'
import type { Pressure } from './routing.ts'

export { DEFAULT_BUDGET }
export type { BudgetConfig, Pressure }
export type Rollup = { id: string; month: string; through: string; usd: number; byDay: Record<string, number>; byChange: Record<string, number>; runs?: string[] }
export type Level = 'none' | 'ok' | 'notice' | 'tight' | 'over'
export type Source = { id: string; through: string }
export type ChangeBudget = { slug: string; spentUsd: number; budgetUsd: number | null; pct: number | null; level: Level }
export type BudgetView = { month: string; spentUsd: number; projectedUsd: number; budgetUsd: number | null; pct: number | null; level: Level; asOf: string | null; sources: Source[]; localOnly: boolean; change: ChangeBudget | null }

export const HOT: Level[] = ['tight', 'over']
const round4 = (n: number): number => Number(n.toFixed(4))
const usdOf = (r: UsageRow): number => (typeof r.usd === 'number' && Number.isFinite(r.usd) ? Math.max(0, r.usd) : 0)
const dollars = (n: number): string => `$${n.toFixed(2)}`
const cap = (n: number): string => (Number.isInteger(n) ? `$${n}` : dollars(n))

export const monthOf = (iso: string): string => iso.slice(0, 7)
export const prevMonth = (iso: string): string => { const d = new Date(iso); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7) }

// Main rows only: a main row's usd is the session ledger delta, which already holds its subagents.
export function rollup(rows: UsageRow[], id: string, month: string, through: string): Rollup {
  const r: Rollup = { id, month, through, usd: 0, byDay: {}, byChange: {} }
  for (const row of rows) {
    if (row.kind !== 'main' || monthOf(row.at) !== month) continue
    const d = usdOf(row), day = row.at.slice(0, 10), change = row.change ?? '(none)'
    r.usd += d
    r.byDay[day] = (r.byDay[day] ?? 0) + d
    r.byChange[change] = (r.byChange[change] ?? 0) + d
  }
  r.usd = round4(r.usd)
  for (const m of [r.byDay, r.byChange]) for (const k of Object.keys(m)) m[k] = round4(m[k] ?? 0)
  return r
}

export function projection(spent: number, nowIso: string): number {
  const t = new Date(nowIso)
  const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)
  const days = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  return round4((spent / Math.max(1, (t.getTime() - start) / 86_400_000)) * days)
}

// A projection only ever raises notice: downshift waits for money actually spent.
export function levelOf(spent: number, budget: number | null, warnAt: [number, number, number], projected?: number): Level {
  if (budget === null) return 'none'
  const pct = (spent / budget) * 100
  if (pct >= warnAt[2]) return 'over'
  if (pct >= warnAt[1]) return 'tight'
  return pct >= warnAt[0] || (projected !== undefined && (projected / budget) * 100 >= warnAt[0]) ? 'notice' : 'ok'
}

export function pressureOf(view: Pick<BudgetView, 'level' | 'change'>, cfg: BudgetConfig, fullRoute: boolean): Pressure {
  if (!cfg.downshift || fullRoute) return 'normal'
  return HOT.includes(view.level) || (view.change !== null && HOT.includes(view.change.level)) ? 'tight' : 'normal'
}

const ID_RE = /^(?:[0-9a-f]{12}|ci)$/
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const numMap = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(finite)
export function parseRollup(text: string): Rollup | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !ID_RE.test(v.id) || typeof v.month !== 'string' || !/^\d{4}-\d{2}$/.test(v.month)) return null
    if (typeof v.through !== 'string' || !finite(v.usd) || !numMap(v.byDay) || !numMap(v.byChange)) return null
    if (v.runs !== undefined && !(Array.isArray(v.runs) && v.runs.every(x => typeof x === 'string'))) return null
    return v as unknown as Rollup
  } catch {
    return null
  }
}

// This clone's pushed file is replaced by its local rollup, so unpushed turns count, and count once.
export function teamSpent(files: Rollup[], selfId: string | null, local: Rollup): number {
  return round4(files.filter(f => f.month === local.month && f.id !== selfId).reduce((s, f) => s + f.usd, 0) + local.usd)
}
export function changeSpent(files: Rollup[], selfId: string | null, rows: UsageRow[], slug: string): number {
  const mine = rows.filter(r => r.kind === 'main' && r.change === slug).reduce((s, r) => s + usdOf(r), 0)
  return round4(files.filter(f => f.id !== selfId).reduce((s, f) => s + (f.byChange[slug] ?? 0), 0) + mine)
}

export function changeBudgetText(c: ChangeBudget | null): string {
  if (!c || c.budgetUsd === null) return 'none set'
  const over = c.spentUsd > c.budgetUsd ? ` · over by ${dollars(c.spentUsd - c.budgetUsd)}` : ''
  return `${dollars(c.spentUsd)} of ${cap(c.budgetUsd)} (${Math.round(c.pct ?? 0)}%)${over}`
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/spend.ts scripts/spend.spec.ts scripts/routing.ts scripts/model.ts
git commit -m "feat: spend rollup, projection, levels and pressure"
```

---

### Task 2: `budget` config and its weakening rules

**Files:**
- Modify: `scripts/model.ts` (`SensorConfig`, `DEFAULT_CONFIG`)
- Modify: `scripts/configparse.ts` (`parseV6`)
- Modify: `scripts/sensors.ts` (`weakensConfig`)
- Test: `scripts/sensors.spec.ts`, `scripts/spend.spec.ts`

**Interfaces:**
- Consumes: `BudgetConfig`, `DEFAULT_BUDGET` from `scripts/spend.ts`:
  ```ts
  type BudgetConfig = { teamMonthlyUsd: number | null; changeUsd: Partial<Record<Tier, number>>; warnAt: [number, number, number]; downshift: boolean }
  ```
- Produces: `SensorConfig.budget: BudgetConfig`, parsed from `.sdlc/sensors.json` → `"budget"`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/spend.spec.ts`:

```ts
import { parseConfig } from './model.ts'

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
```

Append to `scripts/sensors.spec.ts`, after the `weakensConfig names every loosening` test:

```ts
test('weakensConfig flags raising or removing a budget, raising warnAt and turning downshift off; lowering is fine', () => {
  const cfg = (b: unknown) => JSON.stringify({ budget: b })
  const base = { teamMonthlyUsd: 500, changeUsd: { M: 20 }, warnAt: [50, 80, 100], downshift: true }
  const r = weakensConfig(cfg(base), cfg({ teamMonthlyUsd: 900, changeUsd: {}, warnAt: [50, 90, 100], downshift: false })).join('\n')
  for (const want of ['budget.teamMonthlyUsd raised 500 → 900', 'budget.changeUsd.M removed', 'budget.warnAt raised', 'budget.downshift turned off']) assert.ok(r.includes(want), `${want} in:\n${r}`)
  assert.ok(weakensConfig(cfg(base), cfg({})).join('\n').includes('budget.teamMonthlyUsd removed'))
  assert.deepEqual(weakensConfig(cfg(base), cfg({ ...base, teamMonthlyUsd: 300, changeUsd: { M: 10, S: 3 }, warnAt: [40, 70, 90] })), [])
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts scripts/sensors.spec.ts`
Expected: FAIL. `config.budget` is undefined, and `unknown key "budget"`.

- [ ] **Step 3: Add the config field and its default in `scripts/model.ts`**

- No new import: `BudgetConfig` and `DEFAULT_BUDGET` are already in this file (Task 1). Never import `spend.ts` here; that would create an import cycle through `core.ts`.
- Add `budget: BudgetConfig` to `SensorConfig`, after `sparseBase`.
- Add `budget: structuredClone(DEFAULT_BUDGET),` to `DEFAULT_CONFIG`, after `sparseBase: false,`.

- [ ] **Step 4: Parse `budget` in `scripts/configparse.ts`**

At the end of `parseV6`, before the `routing` line, add `if ('budget' in value) parseBudget(value.budget, config, errors)`. Then add below `parseV6`:

```ts
const BUDGET_KEYS = new Set(['teamMonthlyUsd', 'changeUsd', 'warnAt', 'downshift'])
// Soft budgets (spend governance spec §5): every field optional; no budget means spend is shown but never warns or downshifts.
function parseBudget(raw: unknown, config: SensorConfig, errors: string[]): void {
  if (!isObject(raw)) { errors.push('budget must be { teamMonthlyUsd, changeUsd: { S, M, L }, warnAt: [notice, tight, over], downshift }'); return }
  const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  for (const k of Object.keys(raw)) if (!BUDGET_KEYS.has(k)) errors.push(`budget: unknown key "${k}"`)
  if ('teamMonthlyUsd' in raw) { if (raw.teamMonthlyUsd === null || pos(raw.teamMonthlyUsd)) config.budget.teamMonthlyUsd = raw.teamMonthlyUsd; else errors.push('budget.teamMonthlyUsd must be a positive number of dollars') }
  if ('changeUsd' in raw) {
    if (!isObject(raw.changeUsd)) errors.push('budget.changeUsd must map S, M and L to dollars')
    else for (const [t, d] of Object.entries(raw.changeUsd)) {
      if (!(TIERS as readonly string[]).includes(t)) errors.push(`budget.changeUsd: unknown tier "${t}"`)
      else if (pos(d)) config.budget.changeUsd[t as 'S' | 'M' | 'L'] = d
      else errors.push(`budget.changeUsd.${t} must be a positive number of dollars`)
    }
  }
  if ('warnAt' in raw) {
    const w = raw.warnAt
    if (Array.isArray(w) && w.length === 3 && w.every(pos) && w[0] < w[1] && w[1] < w[2]) config.budget.warnAt = [w[0], w[1], w[2]]
    else errors.push('budget.warnAt must be three ascending positive percentages, like [50, 80, 100]')
  }
  if ('downshift' in raw) { if (typeof raw.downshift === 'boolean') config.budget.downshift = raw.downshift; else errors.push('budget.downshift must be true or false') }
}
```

`TIERS` and `isObject` are already used by `parseV6` in this file. If `TIERS` is local to `parseV6`'s module scope, reuse it as it is.

- [ ] **Step 5: Add the weakening rules in `scripts/sensors.ts`**

Add them inside `weakensConfig`, after the `githooks.budgetMs` line:

```ts
  // A soft budget weakens when it is raised or removed, or when downshift is turned off (spend governance spec §5, §12).
  const tb = b.budget.teamMonthlyUsd, ta = a.budget.teamMonthlyUsd
  if (tb !== null && ta === null) reasons.push('budget.teamMonthlyUsd removed')
  else if (tb !== null && ta !== null && ta > tb) reasons.push(`budget.teamMonthlyUsd raised ${tb} → ${ta}`)
  for (const t of ['S', 'M', 'L'] as const) {
    const x = b.budget.changeUsd[t], y = a.budget.changeUsd[t]
    if (x !== undefined && y === undefined) reasons.push(`budget.changeUsd.${t} removed`)
    else if (x !== undefined && y !== undefined && y > x) reasons.push(`budget.changeUsd.${t} raised ${x} → ${y}`)
  }
  if (a.budget.warnAt.some((v, i) => v > (b.budget.warnAt[i] ?? v))) reasons.push(`budget.warnAt raised ${b.budget.warnAt.join('/')} → ${a.budget.warnAt.join('/')}`)
  if (b.budget.downshift && !a.budget.downshift) reasons.push('budget.downshift turned off')
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts scripts/sensors.spec.ts scripts/configparse*.spec.ts 2>/dev/null; node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts && npm run typecheck`
Expected: PASS. Fix any existing test that deep-compares the whole `DEFAULT_CONFIG` by adding the `budget` default to its expectation.

- [ ] **Step 7: Commit**

```bash
git add scripts/model.ts scripts/configparse.ts scripts/sensors.ts scripts/spend.spec.ts scripts/sensors.spec.ts
git commit -m "feat: budget section in sensors.json; raising a budget is a reviewed harness edit"
```

---

### Task 3: The spend ref (clone id, publish, fetch, read, status)

**Files:**
- Modify: `scripts/spend.ts` (I/O, view, notices, CLI)
- Modify: `scripts/core.ts` (`UsageRow.id`; `GITIGNORED`)
- Modify: `scripts/sdlc.ts` (`spend` command; publish after a non-blocking push check)
- Modify: `scripts/pr.ts` (publish after a push)
- Modify: `scripts/vendor.ts` (`VENDORED` gains `'spend'`)
- Modify: `templates/settings.json` (deny model edits of the new state files)
- Test: `scripts/spend.spec.ts`

**Interfaces:**
- Consumes: Task 1's types and functions (`Rollup`, `BudgetView`, `BudgetConfig`, `Level`, `rollup`, `projection`, `levelOf`, `parseRollup`, `teamSpent`, `changeSpent`, `monthOf`, `prevMonth`, `changeBudgetText`, `HOT`).
- Produces (from `scripts/spend.ts`):
  - `SPEND_REF = 'refs/rig/spend'`
  - `peekId(): string | null` (reads only)
  - `cloneId(): string` (creates the ledger row if missing)
  - `readRef(): { tip: string | null; files: Rollup[]; bad: string[] }`
  - `fetchRef(): boolean`
  - `publish(o?: { ci?: { usd: number; run: string; slug?: string } }, nowIso?: string): { ok: boolean; message: string }`
  - `publishQuietly(): void` (prints the message to stderr when not ok; never throws)
  - `budgetView(cfg: BudgetConfig, change: { slug: string; tier: Tier; type: ChangeType } | null, nowIso?: string): BudgetView`
  - `crossings(view: BudgetView): string[]`
  - `cmdSpend(args: Args, ctx: () => { cfg: BudgetConfig; change: { slug: string; tier: Tier; type: ChangeType } | null }): void` (subcommands `status [--json] [--change <slug>] [--no-fetch]`, `publish [--ci --usd <n> --run <id> [--slug <s>]]`, `notify`). `sdlc.ts` supplies `ctx`, so `spend.ts` never imports `graph.ts` or `check.ts`.

- [ ] **Step 1: Write the failing two-clone tests**

Append to `scripts/spend.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts`
Expected: FAIL, `unknown command spend` (or similar).

- [ ] **Step 3: Update `scripts/core.ts`**

- Add `id?: string` to `UsageRow`. It appears only on `event: 'spend-id'` rows.
- Change `GITIGNORED` to:
  ```ts
  const GITIGNORED = ['usage.jsonl', '.baseline', '.gate', 'unresolved.json', 'gates.jsonl', 'spend-cache.json', 'spend-fetched', 'budget-seen.json']
  ```

- [ ] **Step 4: Add the I/O, view, notices and CLI to `scripts/spend.ts`**

Extend the imports at the top:

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ROOT, SDLC, USAGE, read, readJsonl, writeAtomic, now, out, fail, type Args, type ChangeType, type Tier, type UsageRow } from './core.ts'
```

(Merge with the Task 1 imports: keep `DEFAULT_BUDGET`/`BudgetConfig` from `./model.ts` and `Pressure` from `./routing.ts`.)

Append:

```ts
export const SPEND_REF = 'refs/rig/spend'
const CACHE = path.join(SDLC, 'spend-cache.json')
const FETCHED = path.join(SDLC, 'spend-fetched')
const SEEN = path.join(SDLC, 'budget-seen.json')
const TIMEOUT = 10_000
const RIG = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@localhost', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@localhost' }

function g(args: string[], o: { input?: string; env?: Record<string, string>; timeout?: number } = {}): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', input: o.input, env: { ...process.env, ...o.env }, stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], timeout: o.timeout ?? 120_000 }).trim()
  } catch {
    return null
  }
}

// The id lives in the ledger (first spend-id row wins), so it and the rows it counts cannot come apart.
type IdRow = UsageRow & { id?: string }
export const peekId = (): string | null => readJsonl<IdRow>(USAGE).find(r => r.kind === 'event' && r.event === 'spend-id' && typeof r.id === 'string' && /^[0-9a-f]{12}$/.test(r.id))?.id ?? null
export function cloneId(): string {
  const have = peekId()
  if (have) return have
  const id = crypto.randomBytes(6).toString('hex')
  fs.mkdirSync(SDLC, { recursive: true })
  fs.appendFileSync(USAGE, JSON.stringify({ at: now(), kind: 'event', change: null, stage: null, event: 'spend-id', id }) + '\n')
  return id
}

export function readRef(): { tip: string | null; files: Rollup[]; bad: string[] } {
  const tip = g(['rev-parse', '--verify', '-q', `${SPEND_REF}^{commit}`])
  if (!tip) return { tip: null, files: [], bad: [] }
  try { const c = JSON.parse(read(CACHE)) as { tip: string; files: Rollup[]; bad: string[] }; if (c.tip === tip) return c } catch { /* rebuild */ }
  const files: Rollup[] = []
  const bad: string[] = []
  for (const p of (g(['ls-tree', '-r', '--name-only', tip]) ?? '').split('\n').filter(Boolean)) {
    const r = parseRollup(g(['show', `${tip}:${p}`]) ?? '')
    if (r && p === `${r.month}/${r.id}.json`) files.push(r)
    else bad.push(p)
  }
  const result = { tip, files, bad }
  try { writeAtomic(CACHE, JSON.stringify(result)) } catch { /* cache only */ }
  return result
}

export function fetchRef(): boolean {
  if (g(['remote', 'get-url', 'origin']) === null) return false
  const ok = g(['fetch', '-q', '--no-tags', 'origin', `+${SPEND_REF}:${SPEND_REF}`], { timeout: TIMEOUT }) !== null
  if (ok) try { writeAtomic(FETCHED, now()) } catch { /* no .sdlc */ }
  return ok
}

type Entry = { path: string; text: string }
const json = (r: Rollup): string => JSON.stringify(r, null, 2) + '\n'

function cloneEntries(nowIso: string): Entry[] {
  const rows = readJsonl<UsageRow>(USAGE)
  const months = [prevMonth(nowIso), monthOf(nowIso)].filter(m => rows.some(r => r.kind === 'main' && monthOf(r.at) === m))
  if (!months.length) return []
  const id = cloneId()
  return months.map(m => ({ path: `${m}/${id}.json`, text: json(rollup(rows, id, m, nowIso)) }))
}

// CI adds one run at a time; the run key makes a re-run a no-op.
function ciEntries(tip: string | null, ci: { usd: number; run: string; slug?: string }, nowIso: string): Entry[] | null {
  const month = monthOf(nowIso), p = `${month}/ci.json`
  const cur = (tip ? parseRollup(g(['show', `${tip}:${p}`]) ?? '') : null) ?? { id: 'ci', month, through: nowIso, usd: 0, byDay: {}, byChange: {}, runs: [] }
  if ((cur.runs ?? []).includes(ci.run)) return null
  const day = nowIso.slice(0, 10), change = ci.slug ?? '(none)'
  return [{ path: p, text: json({ ...cur, through: nowIso, usd: round4(cur.usd + ci.usd), byDay: { ...cur.byDay, [day]: round4((cur.byDay[day] ?? 0) + ci.usd) }, byChange: { ...cur.byChange, [change]: round4((cur.byChange[change] ?? 0) + ci.usd) }, runs: [...(cur.runs ?? []), ci.run] }) }]
}

// Plumbing on a temporary index: the working tree and the real index are never touched.
function commitEntries(tip: string | null, entries: Entry[]): string | null {
  const index = path.join(os.tmpdir(), `rig-spend-${process.pid}-${Date.now()}.index`)
  const env = { GIT_INDEX_FILE: index }
  try {
    if (g(tip ? ['read-tree', tip] : ['read-tree', '--empty'], { env }) === null) return null
    for (const e of entries) {
      const blob = g(['hash-object', '-w', '--stdin'], { input: e.text })
      if (!blob || g(['update-index', '--add', '--cacheinfo', `100644,${blob},${e.path}`], { env }) === null) return null
    }
    const tree = g(['write-tree'], { env })
    return tree ? g(['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', `rig spend: ${entries.map(e => e.path).join(' ')}`], { env: { ...env, ...RIG } }) : null
  } finally {
    fs.rmSync(index, { force: true })
  }
}

export function publish(o: { ci?: { usd: number; run: string; slug?: string } } = {}, nowIso = now()): { ok: boolean; message: string } {
  if (g(['remote', 'get-url', 'origin']) === null) return { ok: false, message: 'spend: no origin remote; nothing published' }
  for (let attempt = 0; attempt < 2; attempt++) {
    const fetched = fetchRef()
    if (attempt > 0 && !fetched) break
    const tip = g(['rev-parse', '--verify', '-q', `${SPEND_REF}^{commit}`])
    const entries = o.ci ? ciEntries(tip, o.ci, nowIso) : cloneEntries(nowIso)
    if (entries === null) return { ok: true, message: 'spend: this CI run is already counted' }
    if (!entries.length) return { ok: true, message: 'spend: nothing to publish' }
    const commit = commitEntries(tip, entries)
    if (!commit) return { ok: false, message: 'spend: could not build the spend commit' }
    // --no-verify: a push from inside the pre-push hook must not run the hook again.
    if (g(['push', '-q', '--no-verify', 'origin', `${commit}:${SPEND_REF}`], { timeout: TIMEOUT }) !== null) {
      g(['update-ref', SPEND_REF, commit])
      return { ok: true, message: `spend: published ${entries.map(e => e.path).join(', ')}` }
    }
  }
  return { ok: false, message: 'spend: push of refs/rig/spend was refused or timed out; the next push retries' }
}

export function publishQuietly(): void {
  try { const r = publish(); if (!r.ok) process.stderr.write(`warn: ${r.message}\n`) } catch (e) { process.stderr.write(`warn: spend: ${String(e)}\n`) }
}

// Within one process only (status computes the view once per change); each turn is a new process, so the cost per turn is one rev-parse and one ledger read.
const viewMemo = new Map<string, BudgetView>()
export function budgetView(cfg: BudgetConfig, change: { slug: string; tier: Tier; type: ChangeType } | null, nowIso = now()): BudgetView {
  const ref = readRef()
  const size = (() => { try { return fs.statSync(USAGE).size } catch { return 0 } })()
  const key = `${ref.tip}|${size}|${change?.slug ?? ''}|${nowIso.slice(0, 13)}|${JSON.stringify(cfg)}`
  const hit = viewMemo.get(key)
  if (hit) return hit
  const rows = readJsonl<UsageRow>(USAGE)
  const selfId = peekId()
  const month = monthOf(nowIso)
  const local = rollup(rows, selfId ?? 'local', month, nowIso)
  const spentUsd = teamSpent(ref.files, selfId, local)
  const projectedUsd = projection(spentUsd, nowIso)
  const budgetUsd = cfg.teamMonthlyUsd
  const pct = budgetUsd === null ? null : round4((spentUsd / budgetUsd) * 100)
  let ch: ChangeBudget | null = null
  if (change) {
    const b = cfg.changeUsd[change.type === 'greenfield' ? 'L' : change.tier] ?? null
    const s = changeSpent(ref.files, selfId, rows, change.slug)
    ch = { slug: change.slug, spentUsd: s, budgetUsd: b, pct: b === null ? null : round4((s / b) * 100), level: levelOf(s, b, cfg.warnAt) }
  }
  const view: BudgetView = {
    month, spentUsd, projectedUsd, budgetUsd, pct, level: levelOf(spentUsd, budgetUsd, cfg.warnAt, projectedUsd),
    asOf: read(FETCHED).trim() || null, sources: ref.files.filter(f => f.month === month && f.id !== selfId).map(f => ({ id: f.id, through: f.through })),
    localOnly: ref.tip === null, change: ch,
  }
  viewMemo.set(key, view)
  return view
}

const RANK: Level[] = ['none', 'ok', 'notice', 'tight', 'over']
const newly = (lv: Level, seen: Level[]): Level[] => RANK.slice(2, RANK.indexOf(lv) + 1).filter(l => !seen.includes(l))
// One message per newly crossed level: once per level per month for the team, once per level per change.
export function crossings(view: BudgetView): string[] {
  type Seen = { month: string; team: Level[]; changes: Record<string, Level[]> }
  let seen: Seen
  try { seen = JSON.parse(read(SEEN)) as Seen } catch { seen = { month: view.month, team: [], changes: {} } }
  if (seen.month !== view.month) seen = { month: view.month, team: [], changes: seen.changes ?? {} }
  const msgs: string[] = []
  const t = newly(view.level, seen.team)
  if (t.length && view.budgetUsd !== null) {
    seen.team.push(...t)
    msgs.push(`rig budget ${view.level}: team ${dollars(view.spentUsd)} of ${cap(view.budgetUsd)} this month (${Math.round(view.pct ?? 0)}%), projected ${dollars(view.projectedUsd)}`)
  }
  const c = view.change
  if (c && c.budgetUsd !== null) {
    const n = newly(c.level, seen.changes[c.slug] ?? [])
    if (n.length) { seen.changes[c.slug] = [...(seen.changes[c.slug] ?? []), ...n]; msgs.push(`rig budget ${c.level}: ${c.slug} ${changeBudgetText(c)}`) }
  }
  try { writeAtomic(SEEN, JSON.stringify(seen)) } catch { /* no .sdlc */ }
  return msgs
}

function statusText(v: BudgetView, fetched: boolean, bad: string[]): string {
  const share = v.budgetUsd === null ? 'no team budget set' : `${dollars(v.spentUsd)} of ${cap(v.budgetUsd)} (${Math.round(v.pct ?? 0)}%), projected ${dollars(v.projectedUsd)} · ${v.level}`
  const lines = [`spend ${v.month}: ${v.budgetUsd === null ? `${dollars(v.spentUsd)}, projected ${dollars(v.projectedUsd)} (${share})` : share}`]
  lines.push(`sources: ${[...v.sources.map(s => `${s.id} through ${s.through.slice(0, 16)}Z`), 'this clone (local ledger)'].join(', ')}`)
  if (v.localOnly) lines.push('team total: this clone only (no refs/rig/spend fetched yet)')
  else if (!fetched) lines.push(`fetch failed; using the copy from ${v.asOf ?? 'an unknown time'}`)
  for (const p of bad) lines.push(`warn: skipped ${p}: not a valid spend file`)
  if (v.change) lines.push(`change ${v.change.slug}: ${changeBudgetText(v.change)}${v.change.budgetUsd === null ? '' : ` · ${v.change.level}`}`)
  return lines.join('\n')
}

export type SpendContext = () => { cfg: BudgetConfig; change: { slug: string; tier: Tier; type: ChangeType } | null }
// sdlc.ts passes the config and change in: spend.ts never imports graph.ts or check.ts (they import it).
export function cmdSpend(args: Args, ctx: SpendContext): void {
  const sub = args.pos[0]
  if (sub === 'publish') {
    if (!args.opt.ci) { const r = publish(); return r.ok ? out(r.message) : void process.stderr.write(`warn: ${r.message}\n`) }
    const usd = Number(args.opt.usd)
    const run = typeof args.opt.run === 'string' ? args.opt.run : ''
    if (args.opt.usd === undefined || args.opt.usd === true || !Number.isFinite(usd) || usd < 0 || !run) return void process.stderr.write('warn: spend: --ci needs --usd <finite number >= 0> and --run <id>; nothing published\n')
    const r = publish({ ci: { usd, run, slug: typeof args.opt.slug === 'string' ? args.opt.slug : undefined } })
    return r.ok ? out(r.message) : void process.stderr.write(`warn: ${r.message}\n`)
  }
  if (sub !== 'status' && sub !== 'notify') fail('usage: spend (status [--json] [--change <slug>] [--no-fetch] | publish [--ci --usd <n> --run <id> [--slug <slug>]] | notify)')
  const fetched = sub === 'status' && !args.opt['no-fetch'] ? fetchRef() : false
  const { cfg, change } = ctx()
  const view = budgetView(cfg, change)
  if (sub === 'notify') { const m = crossings(view); if (m.length) out(m.join('\n')); return }
  const { bad } = readRef()
  for (const p of bad) process.stderr.write(`warn: skipped ${p}: not a valid spend file\n`)
  out(args.opt.json ? JSON.stringify(view) : statusText(view, fetched, bad))
}
```

`--usd -1` arrives as the string `'-1'` only if the arg parser keeps leading-dash values. If it reads `-1` as a flag, the guard above still refuses it (`usd` is `true` or missing), which is the intended outcome.

- [ ] **Step 5: Wire up the command, push and PR publishing**

In `scripts/sdlc.ts`:
- Import `cmdSpend, publishQuietly` from `./spend.ts`.
- Add to `COMMANDS`, after `scorecard`:

```ts
  spend: args => cmdSpend(args, () => {
    const slug = typeof args.opt.change === 'string' ? checkSlug(args.opt.change) : activeSlug()
    const c = slug ? loadChange(slug) : null
    return { cfg: loadConfig().config.budget, change: c ? { slug: c.slug, tier: c.tier, type: c.type } : null }
  }),
```

(`activeSlug`, `loadChange`, `checkSlug` and `loadConfig` are already imported by `sdlc.ts`; add any that are not.)
- Change the `check` entry to:

```ts
  check: args => (args.opt.at === 'push' ? (cmdCheckPush(args), process.exitCode ? undefined : publishQuietly()) : cmdCheck(args)),
```

In `scripts/pr.ts`, call `publishQuietly()` right after each successful `git push --no-verify -u origin ${branch}` (two sites near lines 169 and 201) and after the follow-up push (near line 240). This covers clones whose git hooks are not installed. Import it from `./spend.ts`.

In `scripts/vendor.ts`, add `'spend'` to `VENDORED`, before `'sdlc'`.

In `templates/settings.json` `permissions.deny`, after `"Edit(/.sdlc/usage.jsonl)",`, add:

```json
      "Edit(/.sdlc/spend-cache.json)",
      "Edit(/.sdlc/spend-fetched)",
      "Edit(/.sdlc/budget-seen.json)",
```

A model could otherwise zero the cached team total and silence warnings and downshift. If a spec test pins the deny list, add the three entries to its expectation.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts scripts/githooks.spec.ts scripts/pr.spec.ts scripts/vendor.spec.ts && npm run typecheck`
Expected: PASS. If a githooks or pr test counts stderr lines and now sees `warn: spend: no origin remote`, change `publishQuietly` to stay silent when `publish` returns the `no origin remote` message. A repo without a remote is the normal test case, not a fault.

- [ ] **Step 7: Commit**

```bash
git add scripts/spend.ts scripts/spend.spec.ts scripts/core.ts scripts/sdlc.ts scripts/pr.ts scripts/vendor.ts templates/settings.json
git commit -m "feat: refs/rig/spend publish, fetch and status across clones; publish after push and pr"
```

---

### Task 4: Pressure eases review routes; `step()` and status carry the budget

**Files:**
- Modify: `scripts/routing.ts` (`route()`, `routes()`)
- Modify: `scripts/graph.ts` (`Step`, `step()`)
- Modify: `scripts/sdlc.ts` (`cmdStatus` top-level `budget`)
- Test: `scripts/routing.spec.ts`, `scripts/spend.spec.ts`

**Interfaces:**
- Consumes:
  - `Pressure = 'normal' | 'tight'` (routing.ts)
  - `budgetView(cfg, change, nowIso?)`, `pressureOf(view, cfg, fullRoute)`, `BudgetView` (spend.ts)
  - `Ratchet.fullRoute?: boolean` (added here, written in Task 5)
- Produces:
  - `route(role, type, tier, round = 0, override = {}, pressure: Pressure = 'normal')`
  - `routes(type, tier, round = 0, override = {}, pressure: Pressure = 'normal')`
  - `Step.pressure: Pressure`, `Step.budget: BudgetView`
  - `status --json` (and `--band`) gains top-level `budget: BudgetView | null`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/routing.spec.ts`:

```ts
test('tight pressure eases reviewer, referee and slice-review by one effort step; models, floors and other roles unchanged', () => {
  for (const t of ['S', 'M', 'L'] as const) {
    for (const role of ROLES) {
      const n = route(role, 'feature', t, 0, {}, 'normal').route
      const p = route(role, 'feature', t, 0, {}, 'tight').route
      if (n === 'main' || p === 'main') { assert.deepEqual(p, n); continue }
      assert.equal(p.model, n.model, `${role} ${t} keeps its model`)
      const eased = ['reviewer', 'referee', 'slice-review'].includes(role)
      const want = eased ? (({ high: 'medium', medium: 'low', low: 'low' }) as const)[n.effort] : n.effort
      assert.equal(p.effort, want, `${role} ${t}`)
    }
  }
  assert.deepEqual(route('implementer', 'feature', 'S', 2, {}, 'tight').route, route('implementer', 'feature', 'S', 2).route, 'retries untouched')
  assert.deepEqual(route('reviewer', 'feature', 'S', 0, { reviewer: { S: { model: 'haiku' } } }, 'tight').route, { model: 'sonnet', effort: 'low' }, 'floor still clamps')
})
```

Append to `scripts/spend.spec.ts`:

```ts
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
```

`new <slug> --type <type> --tier <tier>` is how `scripts/checkpoint.spec.ts` creates a change; it leaves `.sdlc/sensors.json` alone, so the test's budget survives. Slugs need two or more characters (`SLUG_RE`).

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/routing.spec.ts scripts/spend.spec.ts`
Expected: FAIL. The sixth argument to `route` is ignored, and `pressure` is undefined.

- [ ] **Step 3: Ease review routes in `scripts/routing.ts`**

```ts
const EASED: Role[] = ['reviewer', 'referee', 'slice-review']
export function route(role: Role, type: ChangeType, tier: Tier, round = 0, override: RoutingOverride = {}, pressure: Pressure = 'normal'): { route: Route; warning?: string } {
  // …existing body up to and including the implementer retry loop…
  if (pressure === 'tight' && EASED.includes(role)) x = { model: x.model, effort: EFFORTS[Math.max(0, EFFORTS.indexOf(x.effort) - 1)]! }
  // …existing floor clamp unchanged…
}
```

Pass `pressure` through `routes(type, tier, round = 0, override = {}, pressure: Pressure = 'normal')` into each `route(...)` call.

- [ ] **Step 4: Carry pressure and budget through `step()` in `scripts/graph.ts`**

- Import `budgetView, pressureOf, type BudgetView, type Pressure` from `./spend.ts`.
- Extend `Step` with `pressure: Pressure; budget: BudgetView`.
- In `step()`, replace the `routed`/`base` lines with:

```ts
  const { config } = loadConfig()
  const budget = budgetView(config.budget, { slug, tier: change.tier, type: change.type })
  // Budget pressure eases review effort only; round caps and ratchet.usd never move (spend governance spec §12.1).
  const pressure = pressureOf(budget, config.budget, ratchet.fullRoute === true)
  const routed = routesFor(change.type, change.tier, retry, config.routing, pressure)
  const base = { slug, node, round, progress, command: nextCommand(change), model: modelFor(change.type, change.tier), routes: routed.routes, routeWarnings: routed.warnings, pressure, budget }
```

Use `config` for the later `config.ratchet.usd[...]` lookup in the same function instead of a second `loadConfig()`.

In `scripts/ratchet.ts`, add `fullRoute?: boolean` to the `Ratchet` type.

- [ ] **Step 5: Add top-level `budget` to status**

In `scripts/sdlc.ts` `cmdStatus`, add `budget` to both JSON outputs (the `--band` lean one and the full one):
- with an active change: the active step's `budget`;
- with none: `budgetView(loadConfig().config.budget, null)`.

```ts
  const budgetOf = (st: { budget: BudgetView } | null): BudgetView => st?.budget ?? budgetView(loadConfig().config.budget, null)
```

Compute `step(active)` once per call and reuse it for both `step` and `budget`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts && npm run typecheck`
Expected: PASS. Existing tests that deep-compare a whole `Step` or `next --json` object need `pressure: 'normal'` and a `budget` matcher. Update those expectations; do not loosen any assertion.

- [ ] **Step 7: Commit**

```bash
git add scripts/routing.ts scripts/routing.spec.ts scripts/graph.ts scripts/ratchet.ts scripts/sdlc.ts scripts/spend.spec.ts
git commit -m "feat: budget pressure eases review effort; next and status carry the budget view"
```

---

### Task 5: `/rig-approve <slug> full-route`

**Files:**
- Modify: `scripts/sdlc.ts` (`cmdApprove`)
- Modify: `hooks/register.ts`, `scripts/vendor.ts` (usage text and argument hint)
- Modify: `skills/next/SKILL.md` (one line)
- Test: `scripts/spend.spec.ts`

**Interfaces:**
- Consumes: `readRatchet`, `writeRatchet`, `appendEvent` (ratchet.ts); `Ratchet.fullRoute?: boolean` (Task 4); `pressureOf` reads `fullRoute` in `step()` (Task 4).
- Produces: `sdlc.ts approve <slug> full-route` (human only) sets `ratchet.json` `fullRoute: true` and logs an `approved` event of kind `full-route`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/spend.spec.ts`:

```ts
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
```


- [ ] **Step 2: Run it and confirm it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts`
Expected: FAIL, `nothing to approve: x/full-route does not exist`.

- [ ] **Step 3: Handle `full-route` in `cmdApprove`** (after the `budget` branch)

```ts
  if (stage === 'full-route') {
    const r = readRatchet(slug)
    r.fullRoute = true
    writeRatchet(slug, r)
    appendEvent(slug, { node: 'any', verdict: 'approved', kind: 'full-route', reason: 'a person turned budget downshift off for this change' })
    return out(`approved ${slug} full-route: budget downshift is off for this change; budget warnings still show`)
  }
```

- [ ] **Step 4: Update the user-facing text**

- `scripts/vendor.ts` also carries this usage string (the generated standalone approve skill). Update it there too: `grep -rn 'impact|budget|tier' scripts hooks skills templates` must show only the new form.
- In `hooks/register.ts`, change both `<intent|spec|plan|design|impact|budget|tier S|M|L [type]>` strings (the argument hint and the usage reply) to `<intent|spec|plan|design|impact|budget|full-route|tier S|M|L [type]>`.
- In `skills/next/SKILL.md`, add one line to the list after the `blocked` bullet:
  `- \`pressure: tight\` in the JSON means a soft budget is near its limit: routes already carry eased review effort; keep going. A person can run \`/rig-approve <slug> full-route\` to keep full routing for this change.`

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts && npm run typecheck && npm run typecheck:mod`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/sdlc.ts scripts/vendor.ts hooks/register.ts skills/next/SKILL.md scripts/spend.spec.ts
git commit -m "feat: /rig-approve <slug> full-route keeps full routing for one change"
```

---

### Task 6: The mod — coordinator switch, band segment, notices, mission line

**Files:**
- Modify: `types/index.d.ts`, `hooks/shared.ts`, `hooks/register.ts`, `hooks/band.tsx`, `hooks/mission.tsx`
- Test: `tests/register.test.ts`

**Interfaces:**
- Consumes: `status --json --band` top-level `budget` and `step.pressure` (Task 4); `sdlc.ts spend notify` prints one toast line per new crossing (Task 3). The `BudgetView` shape:
  ```ts
  { month: string; spentUsd: number; projectedUsd: number; budgetUsd: number | null; pct: number | null; level: Level; asOf: string | null; sources: Source[]; localOnly: boolean; change: ChangeBudget | null }
  ```
- Produces:
  - `BudgetBand` type in `types/index.d.ts`
  - `Status.budget?`, `StepInfo.pressure?`, `Band.budget?`
  - `COORDINATOR_DOWNSHIFT = 'claude-sonnet-5-5'` in `hooks/shared.ts`
  - `budgetText(b)`, `budgetColor(b)` exported from `hooks/band.tsx`

- [ ] **Step 1: Write the failing tests**

In `tests/register.test.ts`:
- Add `budget: null as unknown` and `pressure: 'normal'` to the `world` object in `worldOf`.
- In the `status` stdout JSON add `budget: world.budget`.
- Change `step: world.step` to `step: { ...(world.step as object), pressure: world.pressure }`.
- Add `: sub === 'spend' ? world.notify` to the `process.run` stdout chain, with `notify: ''` in `world`.

Then add:

```ts
  test('under tight pressure an Opus main loop moves to pinned Sonnet once and stays; subagents and Sonnet sessions are untouched', async ($, on) => {
    const world = worldOf(on)
    world.pressure = 'tight'
    const models: string[] = []
    on('turn.step', async function* ($, e) { models.push(e.model); return { turnId: e.turnId, index: e.index, text: '' } } as never)
    on('turn.start', () => ({ turnId: 't' }) as never)
    await $.session.start(SESSION)
    await $.turn.start({} as never)
    const step = async (model: string, agentId?: string) => { const s = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) }); for await (const _ of s) { /* drain */ } return s.result }
    const stepAt = async (index: number, model: string) => { const s = $.turn.step({ turnId: 't1', index, model, messageCount: 1 }); for await (const _ of s) { /* drain */ } return s.result }
    await step('claude-opus-5-5', 'a1')
    await stepAt(1, 'claude-opus-5-5') // mid-turn: not switched yet
    await step('claude-sonnet-5-5')
    await step('claude-opus-5-5')
    world.pressure = 'normal'
    await $.turn.start({} as never)
    await step('claude-opus-5-5')
    expect(models).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect(world.toasts.filter(t => t.includes('coordinator moved to Sonnet')).length).toBe(1)
  })

  test('normal pressure never rewrites the model', async ($, on) => {
    worldOf(on)
    const models: string[] = []
    on('turn.step', async function* ($, e) { models.push(e.model); return { turnId: e.turnId, index: e.index, text: '' } } as never)
    on('turn.start', () => ({ turnId: 't' }) as never)
    await $.session.start(SESSION)
    await $.turn.start({} as never)
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for await (const _ of s) { /* drain */ }
    expect(models).toEqual(['claude-opus-5-5'])
  })

  test('a budget crossing toasts what spend notify prints; the band shows team and change spend with its age', async ($, on) => {
    const world = worldOf(on)
    world.budget = { month: '2026-10', spentUsd: 212, projectedUsd: 470, budgetUsd: 500, pct: 42.4, level: 'notice', asOf: '2026-10-01T00:00:00.000Z', sources: [], localOnly: false, change: { slug: 'add-login', spentUsd: 9, budgetUsd: 20, pct: 45, level: 'ok' } }
    world.notify = 'rig budget notice: team $212.00 of $500 this month (42%), projected $470.00\n'
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(SESSION)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(world.toasts.some(t => t.startsWith('rig budget notice'))).toBe(true)
    const { budgetText } = await import('../hooks/band')
    expect(budgetText(world.budget as never, Date.parse('2026-10-01T05:00:00.000Z'))).toBe(' · team $212/$500 · proj $470 · change $9.00/$20 · as of 5h ago')
  })
```

The base `turn.step` handler uses the streaming hook form (`async function*`). If `claude-code/testing` wants a different base form, adjust only the base handler, using the `StreamHook` type in `.claude-plugin/types/claude-code/index.d.ts` (around line 11582).

- [ ] **Step 2: Run them and confirm they fail**

Run: `claude plugin test .`
Expected: the three new tests FAIL (models unchanged; no toast; `budgetText` not exported).

- [ ] **Step 3: Add the types to `types/index.d.ts`**

```ts
export type BudgetLevel = 'none' | 'ok' | 'notice' | 'tight' | 'over'
export type BudgetBand = { month: string; spentUsd: number; projectedUsd: number; budgetUsd: number | null; pct: number | null; level: BudgetLevel; asOf: string | null; sources: { id: string; through: string }[]; localOnly: boolean; change: { slug: string; spentUsd: number; budgetUsd: number | null; pct: number | null; level: BudgetLevel } | null }
```

- Add `pressure?: 'normal' | 'tight'` to `StepInfo`.
- Add `budget?: BudgetBand | null` to `Status` and to `Band`.

- [ ] **Step 4: Add the constant to `hooks/shared.ts`**

```ts
// The coordinator's model under budget pressure: pinned like templates/settings.json, never an alias (DESIGN.md principle 7).
export const COORDINATOR_DOWNSHIFT = 'claude-sonnet-5-5'
```

- [ ] **Step 5: Update `hooks/register.ts`**

- Import `COORDINATOR_DOWNSHIFT` from `./shared`.
- Next to the other module state (`let turnChange…`), add:

```ts
let turnPressure: 'normal' | 'tight' = 'normal'
let coordinatorSwitched = false
```

- In the `session.start` handler, reset `coordinatorSwitched = false`.
- The `step` helper in the test sends `index: 0`, a turn's first step.
- In `turn.start`, replace the status line with:

```ts
    if (await isInitialised($)) { const s = await statusJson($); ({ change: turnChange, stage: turnStage } = stageOf(s)); turnPressure = s?.step?.pressure ?? 'normal' }
```

- Add, after `turn.start`:

```ts
  // Budget downshift (spend governance spec §7, §12.7): an Opus main loop moves to pinned Sonnet once under pressure and stays,
  // so its cache is rebuilt once. Subagent steps keep the routes their launches picked.
  on('turn.step', async function* ($, e, next) {
    if (mod.aside || e.agentId || !/opus/i.test(e.model)) return yield* next(e)
    // Only at a turn's first step: a turn's earlier Opus responses (and thinking) are never handed to Sonnet mid-loop.
    if (!coordinatorSwitched && turnPressure === 'tight' && e.index === 0) {
      coordinatorSwitched = true
      $.ui.toast('rig: budget tight, coordinator moved to Sonnet for this session')
    }
    return yield* next(coordinatorSwitched ? { ...e, model: COORDINATOR_DOWNSHIFT } : e)
  })
```

- In `refreshBand`, add `budget: status?.budget ?? null` to the `Band` value.
- In `turn.complete`, right after `if (!e.agentId) status = await refreshBand($)`, add:

```ts
      const hot = (l?: string) => l === 'notice' || l === 'tight' || l === 'over'
      if (!e.agentId && (hot(status?.budget?.level) || hot(status?.budget?.change?.level))) {
        const n = await $.process.run(sdlc($, ['spend', 'notify']))
        for (const line of n.stdout.split('\n').filter(Boolean)) $.ui.toast(line)
      }
```

- [ ] **Step 6: Add the band segment in `hooks/band.tsx`**

```tsx
const ago = (iso: string, nowMs: number): string => { const h = Math.floor((nowMs - Date.parse(iso)) / 3_600_000); return h >= 24 ? `${Math.floor(h / 24)}d` : `${h}h` }
// Team and change budget; empty when none is set. The cached ref's age shows past an hour, so an old copy never reads as current.
export const budgetText = (b?: BudgetBand | null, nowMs = Date.now()): string => {
  if (!b) return ''
  const team = b.budgetUsd !== null ? `team ${cap(b.spentUsd)}/${cap(b.budgetUsd)} · proj ${cap(b.projectedUsd)}` : ''
  const change = b.change && b.change.budgetUsd !== null ? `change ${usd(b.change.spentUsd)}/${cap(b.change.budgetUsd)}` : ''
  if (!team && !change) return ''
  const age = b.localOnly ? ' · this clone only' : b.asOf && nowMs - Date.parse(b.asOf) > 3_600_000 ? ` · as of ${ago(b.asOf, nowMs)} ago` : ''
  return ` · ${[team, change].filter(Boolean).join(' · ')}${age}`
}
export const budgetColor = (b?: BudgetBand | null): string | undefined => {
  const levels = [b?.level, b?.change?.level]
  return levels.includes('over') ? 'red' : levels.includes('tight') ? 'yellow' : undefined
}
```

- Import `BudgetBand` from `../types`.
- `cap` already exists in this file. It prints whole dollars as `$212`; keep it, and the test expects `$212/$500` and `proj $470`.
- In the render, after the sensors `<Text>`, add:
  `<Text color={budgetColor(current.budget)} dimColor={!budgetColor(current.budget)}>{budgetText(current.budget)} </Text>`

- [ ] **Step 7: Add the mission line in `hooks/mission.tsx`**

Next to the existing `this change …` `<Text>` line, add:

```tsx
        {band?.budget && budgetText(band.budget) ? <Text color={budgetColor(band.budget)}>{`budget ${budgetText(band.budget).replace(/^ · /, '')}`}</Text> : null}
```

(Import `budgetText`, `budgetColor` from `./band`. Use whatever local variable holds the `Band` in that component.)

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `npm run typecheck:mod && claude plugin test .`
Expected: PASS, with all earlier mod tests still green.

- [ ] **Step 9: Commit**

```bash
git add types/index.d.ts hooks/shared.ts hooks/register.ts hooks/band.tsx hooks/mission.tsx tests/register.test.ts
git commit -m "feat: band and pane show budgets; crossings toast; an Opus coordinator moves to Sonnet under pressure"
```

---

### Task 7: Scorecard row and metrics block

**Files:**
- Modify: `scripts/scorecard.ts` (`renderScorecard`)
- Modify: `scripts/metrics.ts` (`budget` block)
- Modify: `skills/metrics/SKILL.md`
- Test: `scripts/spend.spec.ts`

**Interfaces:**
- Consumes:
  - `budgetView(cfg, change, nowIso?) → BudgetView`
  - `changeBudgetText(c: ChangeBudget | null) → string`
  - `fetchRef()`, `readRef()`, `peekId()`, `changeSpent(files, selfId, rows, slug)` (spend.ts)
- Produces:
  - a `| Change budget | … |` row in the PR scorecard
  - `metrics --json` → `metrics.budget = { month, spentUsd, projectedUsd, budgetUsd, level, sources, changeBudgetHits }`

- [ ] **Step 1: Write the failing test**

Append to `scripts/spend.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/spend.spec.ts`
Expected: FAIL, no `Change budget` row.

- [ ] **Step 3: Add the scorecard row**

In `renderScorecard` (`scripts/scorecard.ts`), right after the `| Budget |` row, add:

```ts
    `| Change budget | ${changeBudgetText(budgetView(config.budget, { slug, tier: change.tier, type: change.type }).change)} |`,
```

Import `budgetView, changeBudgetText` from `./spend.ts`. Use the `config` and `change` already in scope in `renderScorecard`. If they are not in scope, call `loadConfig()` and `loadChange(slug)` as `story()` does.

- [ ] **Step 4: Add the metrics block**

In `scripts/metrics.ts`, after the cost block:

```ts
  // Budget (spend governance spec §6): the team month across every clone that published, and changes in the window over their budget.
  fetchRef()
  const bv = budgetView(config.budget, null)
  const ref = readRef()
  const ledgerRows = readJsonl<UsageRow>(USAGE)
  const changeBudgetHits = changes.filter(c => {
    const b = config.budget.changeUsd[c.type === 'greenfield' ? 'L' : c.tier]
    return b !== undefined && changeSpent(ref.files, peekId(), ledgerRows, c.slug) >= b
  }).length
  const budget = { month: bv.month, spentUsd: bv.spentUsd, projectedUsd: bv.projectedUsd, budgetUsd: bv.budgetUsd, level: bv.level, sources: bv.sources.length + 1, changeBudgetHits }
```

- Use the `config` variable `metrics.ts` already loads. If there is none, add `const { config } = loadConfig()`.
- `changes` here must include unshipped changes active in the window. If the existing `changes` list is shipped-only, use `listChanges().map(loadChange)` filtered to the window for this count.
- Add `budget` to the `--json` `metrics` object.
- Add `'', 'budget (soft; every clone that published plus this one)', JSON.stringify(budget, null, 2)` to the text output, after `cost`.

In `skills/metrics/SKILL.md`, add one line describing the `budget` block, next to where `cost` is described.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/scorecard.ts scripts/metrics.ts skills/metrics/SKILL.md scripts/spend.spec.ts
git commit -m "feat: change budget in the PR scorecard; budget block in metrics"
```

---

### Task 8: CI spend (after the person's remote ref check)

**Files:**
- Modify: `templates/rig-review.yml`, `templates/rig-triage.yml`, `templates/rig-watch.yml`
- Test: `scripts/cicd.spec.ts`

**Interfaces:**
- Consumes: `sdlc.ts spend publish --ci --usd <n> --run <id>` (Task 3; refuses a non-finite or negative usd and exits 0).
- Produces: in each workflow, a cost step with `id: cost` and output `usd` after the Claude step, plus a `spend` job.

- [ ] **Step 1: The person checks the remote ref (manual; outward-facing, so not run by an agent)**

Ask the person to run this on a scratch GitHub repo they own:

```bash
git commit --allow-empty -m probe && git push origin HEAD:refs/rig/spend   # local push of a custom ref
git ls-remote origin 'refs/rig/*'                                          # it is listed
```

They should also push one Actions job with `permissions: contents: write` that runs `git fetch origin '+refs/rig/spend:refs/rig/spend' && git push --no-verify origin refs/rig/spend:refs/rig/spend`.

- **If either is refused:** stop. Apply spec §12.9: change `SPEND_REF` to `refs/heads/rig-spend`, re-run Task 3's tests, then continue.
- **Record the outcome** in `docs/superpowers/specs/2026-10-08-spend-governance-design.md` §12.9 as one line.

- [ ] **Step 2: Write the failing test**

Append to `scripts/cicd.spec.ts`, following its `yml(name)` helper:

```ts
test('each workflow that runs Claude reads the run cost and publishes it from a model-free job with write access', () => {
  for (const name of ['rig-review.yml', 'rig-triage.yml', 'rig-watch.yml']) {
    const t = yml(name)
    assert.match(t, /total_cost_usd/, `${name} reads the cost from execution_file`)
    assert.match(t, /Number\.isFinite\(u\) && u >= 0/, `${name} accepts only a finite cost ≥ 0`)
    const job = t.slice(t.indexOf('\n  spend:'))
    assert.ok(job.length > 10, `${name} has a spend job`)
    assert.match(job, /contents: write/)
    assert.doesNotMatch(job, /claude-code-action/, `${name}: the spend job runs no model`)
    assert.match(job, /spend publish --ci --usd "\$USD" --run "\$RUN"/)
    assert.match(job, /if \[ ! -f \.sdlc\/bin\/spend\.ts \]; then echo "::notice::/, `${name}: an old base branch skips with a notice`)
    assert.match(job, /github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  }
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/cicd.spec.ts`
Expected: FAIL, `rig-review.yml reads the cost from execution_file`.

- [ ] **Step 4: Edit `templates/rig-review.yml`**

1. Add `id: claude` to the `anthropics/claude-code-action` step.
2. Add `outputs: { usd: ${{ steps.cost.outputs.usd }} }` to the `review` job, as a block mapping under `review:` in the file's YAML style.
3. After the Claude step, add:

```yaml
      # The run's cost, from the action's message log; only a finite number >= 0 leaves this job (spend governance spec §12.5).
      - name: Read the run's cost
        id: cost
        if: always() && steps.claude.outputs.execution_file != ''
        env:
          FILE: ${{ steps.claude.outputs.execution_file }}
        run: |
          usd=$(node -e 'try { const m = JSON.parse(require("fs").readFileSync(process.env.FILE, "utf8")); const r = [].concat(m).reverse().find(x => x && x.type === "result"); const u = r && r.total_cost_usd; if (typeof u === "number" && Number.isFinite(u) && u >= 0) console.log(u) } catch {}')
          echo "usd=$usd" >> "$GITHUB_OUTPUT"
```

4. Add a job at the end of `jobs:`:

```yaml
  # Publishes CI spend to refs/rig/spend. Runs no model; same-repo PRs only; the base branch's checker, never the PR's.
  spend:
    needs: review
    if: always() && needs.review.outputs.usd != '' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Publish CI spend
        env:
          USD: ${{ needs.review.outputs.usd }}
          RUN: ${{ github.run_id }}-${{ github.run_attempt }}-review
        # The base branch may predate spend (the PR that adds it): skip with a notice, never fail.
        run: |
          if [ ! -f .sdlc/bin/spend.ts ]; then echo "::notice::rig spend not vendored on the base branch yet; CI spend not published"; exit 0; fi
          node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts spend publish --ci --usd "$USD" --run "$RUN" || echo "::warning::rig spend publish failed""
```

- [ ] **Step 5: Edit `templates/rig-triage.yml`**

1. Add `id: claude` to its `claude-code-action` step.
2. Add `outputs:` with `usd: ${{ steps.cost.outputs.usd }}` to the `triage` job.
3. Add the same `Read the run's cost` step as in Step 4, item 3, after the Claude step.
4. Add this job:

```yaml
  spend:
    needs: triage
    if: always() && needs.triage.outputs.usd != '' && github.event.workflow_run.head_repository.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.repository.default_branch }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Publish CI spend
        env:
          USD: ${{ needs.triage.outputs.usd }}
          RUN: ${{ github.run_id }}-${{ github.run_attempt }}-triage
        # The base branch may predate spend (the PR that adds it): skip with a notice, never fail.
        run: |
          if [ ! -f .sdlc/bin/spend.ts ]; then echo "::notice::rig spend not vendored on the base branch yet; CI spend not published"; exit 0; fi
          node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts spend publish --ci --usd "$USD" --run "$RUN" || echo "::warning::rig spend publish failed""
```

- [ ] **Step 6: Edit `templates/rig-watch.yml`**

1. Add `id: claude` to the `diagnose` job's `claude-code-action` step.
2. Add `outputs:` with `usd: ${{ steps.cost.outputs.usd }}` to `diagnose`.
3. Add the same `Read the run's cost` step as in Step 4, item 3, after the Claude step.
4. Add this job:

```yaml
  spend:
    needs: diagnose
    if: always() && needs.diagnose.outputs.usd != ''
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Publish CI spend
        env:
          USD: ${{ needs.diagnose.outputs.usd }}
          RUN: ${{ github.run_id }}-${{ github.run_attempt }}-watch
        # The base branch may predate spend (the PR that adds it): skip with a notice, never fail.
        run: |
          if [ ! -f .sdlc/bin/spend.ts ]; then echo "::notice::rig spend not vendored on the base branch yet; CI spend not published"; exit 0; fi
          node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts spend publish --ci --usd "$USD" --run "$RUN" || echo "::warning::rig spend publish failed""
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/cicd.spec.ts scripts/*.spec.ts`
Expected: PASS. If an existing `cicd.spec.ts` test pins the full job list or a hash of a template, update that expectation to include `spend`.

- [ ] **Step 8: Commit**

```bash
git add templates/rig-review.yml templates/rig-triage.yml templates/rig-watch.yml scripts/cicd.spec.ts docs/superpowers/specs/2026-10-08-spend-governance-design.md
git commit -m "feat: CI workflows publish their Claude run cost to refs/rig/spend from a model-free job"
```

---

### Task 9: Docs and the full verification pass

**Files:**
- Modify: `README.md`, `DESIGN.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above. Produces: docs only.

- [ ] **Step 1: README.** Add a `Budgets` section after the routing section:
  - **Config:** the `budget` block in `.sdlc/sensors.json` (the spec §5 example).
  - **`sdlc.ts spend status`:** what it shows, the sources list, `this clone only`, and the cached copy's age.
  - **Levels:** 50, 80 and 100%, and what each shows.
  - **Downshift:** review effort one step lower, plus Opus coordinator → `claude-sonnet-5-5`, once per session. With default settings, expect modest savings.
  - **Opt-outs:** `budget.downshift: false` (a reviewed edit) and `/rig-approve <slug> full-route`.
  - **Not a stop:** state that budgets never pause work, and that `ratchet.usd` with `/rig-approve <slug> budget` is the separate runaway guard.
  - **CI cost:** read from the action's log. On a subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) it is notional and counted as reported.
- [ ] **Step 2: DESIGN.md.**
  - Principle 7 gains one sentence: "The one sanctioned mid-session switch is budget downshift: an Opus main loop moves to pinned Sonnet once under pressure and stays (spend governance spec §7)."
  - Add a short spend governance section: the ref, the per-clone file, main rows only, the levels, the levers, and no hard stops.
- [ ] **Step 3: CHANGELOG.md.** Add an entry under the unreleased heading listing:
  - `spend status`, `spend publish`, `spend notify`
  - the `budget` config
  - the band, pane, scorecard and metrics additions
  - the downshift levers
  - `full-route`
  - the CI spend jobs
- [ ] **Step 4: Full verification**

Run, in order:

```bash
npm run typecheck
npm run typecheck:mod
node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts
claude plugin test .
npm run test:integration:self
```

Expected: every command exits 0. Report the counts from each. Never run `sdlc.ts check --at ci` or any rig command against this repo.

- [ ] **Step 5: Commit**

```bash
git add README.md DESIGN.md CHANGELOG.md
git commit -m "docs: spend governance in README, DESIGN and CHANGELOG"
```
