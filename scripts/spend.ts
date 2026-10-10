// Spend governance (spec 2026-10-08): team spend per month and per change from every clone's rollup on refs/rig/spend plus this
// clone's ledger; soft levels and downshift pressure. Nothing here blocks: failures warn and exit 0.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { SDLC, USAGE, SLUG_RE, ROOT, read, readJsonl, writeAtomic, now, out, fail, type Args, type ChangeType, type Tier, type UsageRow } from './core.ts'
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
// Slugs and days are user data: read and bump the maps through own keys only, so "constructor" or "toString" is just a name.
const own = (m: Record<string, number>, k: string): number => (Object.hasOwn(m, k) ? (m[k] ?? 0) : 0)
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
    r.byDay[day] = own(r.byDay, day) + d
    r.byChange[change] = own(r.byChange, change) + d
  }
  r.usd = round4(r.usd)
  for (const m of [r.byDay, r.byChange]) for (const k of Object.keys(m)) m[k] = round4(own(m, k))
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
  try { return asRollup(JSON.parse(text)) } catch { return null }
}
function asRollup(parsed: unknown): Rollup | null {
  try {
    const v = parsed as Record<string, unknown>
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
  return round4(files.filter(f => f.id !== selfId).reduce((s, f) => s + own(f.byChange, slug), 0) + mine)
}

export function changeBudgetText(c: ChangeBudget | null): string {
  if (!c || c.budgetUsd === null) return 'none set'
  const over = c.spentUsd > c.budgetUsd ? ` · over by ${dollars(c.spentUsd - c.budgetUsd)}` : ''
  return `${dollars(c.spentUsd)} of ${cap(c.budgetUsd)} (${Math.round(c.pct ?? 0)}%)${over}`
}

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
  try {
    const c = JSON.parse(read(CACHE)) as { tip: string; files: unknown; bad: unknown }
    if (c.tip === tip && Array.isArray(c.files) && c.files.every(f => asRollup(f) !== null) && Array.isArray(c.bad) && c.bad.every(b => typeof b === 'string')) return c as { tip: string; files: Rollup[]; bad: string[] }
  } catch { /* rebuild */ }
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
  if (ok) try { writeAtomic(FETCHED, now()) } catch { /* no .rig */ }
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
// A string result is a refusal: an unreadable ci.json is never overwritten.
function ciEntries(tip: string | null, ci: { usd: number; run: string; slug?: string }, nowIso: string): Entry[] | null | string {
  const month = monthOf(nowIso), p = `${month}/ci.json`
  const have = tip ? g(['show', `${tip}:${p}`]) : null
  const parsed = have === null ? null : parseRollup(have)
  if (have !== null && parsed === null) return 'spend: ci.json on the ref is malformed; not overwritten'
  const cur = parsed ?? { id: 'ci', month, through: nowIso, usd: 0, byDay: {}, byChange: {}, runs: [] }
  if ((cur.runs ?? []).includes(ci.run)) return null
  const day = nowIso.slice(0, 10), change = ci.slug ?? '(none)'
  return [{ path: p, text: json({ ...cur, through: nowIso, usd: round4(cur.usd + ci.usd), byDay: { ...cur.byDay, [day]: round4(own(cur.byDay, day) + ci.usd) }, byChange: { ...cur.byChange, [change]: round4(own(cur.byChange, change) + ci.usd) }, runs: [...(cur.runs ?? []), ci.run] }) }]
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

const unchanged = (tip: string | null, e: Entry): boolean => {
  const cur = tip ? parseRollup(g(['show', `${tip}:${e.path}`]) ?? '') : null, next = parseRollup(e.text)
  return cur !== null && next !== null && JSON.stringify({ ...cur, through: '' }) === JSON.stringify({ ...next, through: '' })
}

export function publish(o: { ci?: { usd: number; run: string; slug?: string } } = {}, nowIso = now()): { ok: boolean; message: string } {
  if (g(['remote', 'get-url', 'origin']) === null) return { ok: false, message: 'spend: no origin remote; nothing published' }
  for (let attempt = 0; attempt < 2; attempt++) {
    const fetched = fetchRef()
    if (attempt > 0 && !fetched) break
    const tip = g(['rev-parse', '--verify', '-q', `${SPEND_REF}^{commit}`])
    const built = o.ci ? ciEntries(tip, o.ci, nowIso) : cloneEntries(nowIso)
    if (typeof built === 'string') return { ok: false, message: built }
    if (built === null) return { ok: true, message: 'spend: this CI run is already counted' }
    if (!built.length) return { ok: true, message: 'spend: nothing to publish' }
    // Only `through` moves when no row is new: skip the commit and the push.
    const entries = built.filter(e => !unchanged(tip, e))
    if (!entries.length) return { ok: true, message: 'spend: nothing changed' }
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

// For the paths that must never fail (next, band, pr, metrics): a spend error warns once and reads as no budget.
export function safeBudgetView(cfg: BudgetConfig, change: { slug: string; tier: Tier; type: ChangeType } | null, nowIso = now()): BudgetView {
  try { return budgetView(cfg, change, nowIso) } catch (e) {
    process.stderr.write(`warn: spend: ${e instanceof Error ? e.message : String(e)}\n`)
    return { month: monthOf(nowIso), spentUsd: 0, projectedUsd: 0, budgetUsd: null, pct: null, level: 'none', asOf: null, sources: [], localOnly: true, change: change ? { slug: change.slug, spentUsd: 0, budgetUsd: null, pct: null, level: 'none' } : null }
  }
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
    const had = Object.hasOwn(seen.changes, c.slug) ? seen.changes[c.slug] ?? [] : []
    const n = newly(c.level, had)
    if (n.length) { seen.changes[c.slug] = [...had, ...n]; msgs.push(`rig budget ${c.level}: ${c.slug} ${changeBudgetText(c)}`) }
  }
  try { writeAtomic(SEEN, JSON.stringify(seen)) } catch { /* no .rig */ }
  return msgs
}

function statusText(v: BudgetView, fetch: 'ok' | 'failed' | 'none', bad: string[]): string {
  const share = v.budgetUsd === null ? 'no team budget set' : `${dollars(v.spentUsd)} of ${cap(v.budgetUsd)} (${Math.round(v.pct ?? 0)}%), projected ${dollars(v.projectedUsd)} · ${v.level}`
  const lines = [`spend ${v.month}: ${v.budgetUsd === null ? `${dollars(v.spentUsd)}, projected ${dollars(v.projectedUsd)} (${share})` : share}`]
  lines.push(`sources: ${[...v.sources.map(s => `${s.id} through ${s.through.slice(0, 16)}Z`), 'this clone (local ledger)'].join(', ')}`)
  if (v.localOnly) lines.push('team total: this clone only (no refs/rig/spend fetched yet)')
  else if (fetch === 'failed') lines.push(`fetch failed; using the copy from ${v.asOf ?? 'an unknown time'}`)
  else if (fetch === 'none') lines.push(`using the cached copy from ${v.asOf ?? 'an unknown time'}`)
  for (const p of bad) lines.push(`warn: skipped ${p}: not a valid spend file`)
  if (v.change) lines.push(`change ${v.change.slug}: ${changeBudgetText(v.change)}${v.change.budgetUsd === null ? '' : ` · ${v.change.level}`}`)
  return lines.join('\n')
}

export type SpendContext = () => { cfg: BudgetConfig; change: { slug: string; tier: Tier; type: ChangeType } | null }
// sdlc.ts passes the config and change in: spend.ts never imports graph.ts or check.ts (they import it).
export function cmdSpend(args: Args, ctx: SpendContext): void {
  const sub = args.pos[0]
  if (sub !== 'status' && sub !== 'notify' && sub !== 'publish') fail('usage: spend (status [--json] [--change <slug>] [--no-fetch] | publish [--ci --usd <n> --run <id> [--slug <slug>]] | notify)')
  try { run(args, ctx, sub) } catch (e) { process.stderr.write(`warn: spend: ${e instanceof Error ? e.message : String(e)}\n`) }
}

function run(args: Args, ctx: SpendContext, sub: string): void {
  if (sub === 'publish') {
    if (!args.opt.ci) { const r = publish(); return r.ok ? out(r.message) : void process.stderr.write(`warn: ${r.message}\n`) }
    const usd = Number(args.opt.usd)
    const run = typeof args.opt.run === 'string' ? args.opt.run : ''
    if (args.opt.usd === undefined || args.opt.usd === true || !Number.isFinite(usd) || usd < 0 || !run) return void process.stderr.write('warn: spend: --ci needs --usd <finite number >= 0> and --run <id>; nothing published\n')
    const raw = args.opt.slug
    const slug = typeof raw === 'string' && SLUG_RE.test(raw) ? raw : undefined
    if (raw !== undefined && slug === undefined) process.stderr.write('warn: spend: --slug is not a valid change slug; counted under (none)\n')
    const r = publish({ ci: { usd, run, slug } })
    return r.ok ? out(r.message) : void process.stderr.write(`warn: ${r.message}\n`)
  }
  const attempt = sub === 'status' && !args.opt['no-fetch'] && g(['remote', 'get-url', 'origin']) !== null
  const fetched = attempt ? fetchRef() : false
  const { cfg, change } = ctx()
  const view = safeBudgetView(cfg, change)
  if (sub === 'notify') { const m = crossings(view); if (m.length) out(m.join('\n')); return }
  const { bad } = readRef()
  for (const p of bad) process.stderr.write(`warn: skipped ${p}: not a valid spend file\n`)
  out(args.opt.json ? JSON.stringify(view) : statusText(view, !attempt ? 'none' : fetched ? 'ok' : 'failed', bad))
}
