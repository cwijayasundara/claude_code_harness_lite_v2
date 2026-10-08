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
