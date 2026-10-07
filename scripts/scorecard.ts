// One story's numbers (band, pane, PR body): tokens, cost per node, estimated value, rounds and autonomy.
import path from 'node:path'
import { CHANGES, USAGE, planPath, read, readJsonl, frontmatter, out, fail, checkSlug, type Args, type UsageRow } from './core.ts'
import { loadChange, step } from './graph.ts'
import { readEvents, readRatchet } from './ratchet.ts'
import { loadConfig } from './check.ts'
import { pointsOf } from './points.ts'
import { readRuns } from './runs.ts'
import { timing } from './timing.ts'
import type { RatchetNode } from './model.ts'

export type Story = { slug: string; node: string | null; verdict: string; round: number; cap: number; tokens: number; tokensByNode: Record<string, number>; budgetByNode: Record<string, { spent: number; cap: number }>; usd: number; usdByNode: Record<string, number>; valueUsd: number; valueHours: number; autoApproved: number; escalations: number; levels: string; sensors: string; points: number; pointsSource: string; workMs: number; spanMs: number; idleMs: number; lastActivity: string | null }

const tokensOf = (r: UsageRow): number => (r.in ?? 0) + (r.out ?? 0) + (r.cr ?? 0) + (r.cw ?? 0)

// Estimated value hours: the tier default, or the architect's override in plan.md, which needs a reason on the same line.
export function valueHoursFor(slug: string, tier: string, hoursByTier: Record<string, number>): number {
  const override = /^value_hours:[ \t]*(\d+(?:\.\d+)?)[ \t]+because[ \t]+\S/m.exec(read(planPath(slug)))
  return override ? Number(override[1]) : hoursByTier[tier] ?? 0
}

export function story(slug: string): Story {
  checkSlug(slug)
  const { config } = loadConfig()
  const change = loadChange(slug)
  const s = step(slug)
  const rows = readJsonl<UsageRow>(USAGE).filter(r => r.change === slug)
  // Money actually spent: main rows only, grouped by stage, before any budget credit. Buckets sum exactly to the total.
  const usdByNode: Record<string, number> = {}
  const tokensByNode: Record<string, number> = {}
  for (const r of rows) {
    const node = r.stage || '(none)'
    tokensByNode[node] = (tokensByNode[node] ?? 0) + tokensOf(r)
    if (r.kind === 'main') usdByNode[node] = (usdByNode[node] ?? 0) + (typeof r.usd === 'number' && Number.isFinite(r.usd) ? Math.max(0, r.usd) : 0)
  }
  for (const k of Object.keys(usdByNode)) usdByNode[k] = Number((usdByNode[k] ?? 0).toFixed(4))
  const budgetByNode: Record<string, { spent: number; cap: number }> = {}
  for (const [n, cap] of Object.entries(config.ratchet.usd)) if (n in usdByNode) budgetByNode[n] = { spent: usdByNode[n] ?? 0, cap }
  const valueHours = valueHoursFor(slug, change.tier, config.value.hours)
  const events = readEvents(slug)
  const lanes = new Map<string, number>()
  const intervals: [number, number][] = []
  const stamps: number[] = []
  for (const e of events) {
    const t = Date.parse(e.at)
    if (!Number.isFinite(t)) continue
    if (e.kind === 'lane' && e.id && e.verdict === 'start') lanes.set(e.id, t)
    else if (e.kind === 'lane' && e.id && e.verdict === 'stop' && lanes.has(e.id)) { intervals.push([lanes.get(e.id) ?? t, t]); lanes.delete(e.id) }
    else stamps.push(t)
  }
  for (const t of lanes.values()) stamps.push(t)
  for (const row of readRuns(slug)) {
    const end = Date.parse(row.at)
    if (Number.isFinite(end) && Number.isFinite(row.ms)) intervals.push([end - Math.max(0, row.ms), end])
  }
  const tm = timing(intervals, stamps, config.idleGapMs)
  const r = readRatchet(slug)
  const node = s.node as RatchetNode | null
  return {
    slug, node: s.node, verdict: s.verdict, round: s.round, cap: node && node in config.ratchet.rounds ? config.ratchet.rounds[node] : 0,
    tokens: rows.reduce((n, x) => n + tokensOf(x), 0), tokensByNode, budgetByNode, usd: Number(Object.values(usdByNode).reduce((a, b) => a + b, 0).toFixed(4)), usdByNode, valueHours, valueUsd: Math.round(valueHours * config.value.rate),
    autoApproved: events.filter(e => e.kind === 'auto-approve').length, escalations: events.filter(e => e.verdict === 'blocked').length,
    levels: frontmatter(read(path.join(CHANGES, slug, 'verification.md'))).data.levels ?? '',
    sensors: r.nodes.sensors?.status === 'done' ? 'pass' : r.nodes.sensors ? 'open' : 'not run',
    points: pointsOf(slug).points, pointsSource: pointsOf(slug).source,
    workMs: tm.workMs, spanMs: tm.spanMs, idleMs: tm.idleMs, lastActivity: tm.lastAt === null ? null : new Date(tm.lastAt).toISOString(),
  }
}

const dur = (ms: number): string => { const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m` }
const money = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`

export function renderScorecard(slug: string): string {
  const s = story(slug)
  const { config } = loadConfig()
  const r = readRatchet(slug)
  const rounds = Object.entries(r.nodes).map(([n, st]) => `${n} ${st?.rounds ?? 0}`).join(', ') || 'none'
  const slices = Object.entries(r.slices).map(([id, st]) => `#${id} ${st.rounds}`).join(', ') || 'none'
  return [
    '## Scorecard', '',
    '| Measure | Value |', '|---|---|',
    `| Fix rounds per node | ${rounds} |`,
    `| Fix rounds per slice | ${slices} |`,
    `| Test levels | ${s.levels || 'none recorded'} |`,
    `| Sensors | ${s.sensors} |`,
    `| Story points | ${s.points} (${s.pointsSource}) |`,
    `| Time | work ${dur(s.workMs)} · span ${dur(s.spanMs)} · idle ${dur(s.idleMs)} |`,
    `| Auto-approved tool calls | ${s.autoApproved} |`,
    `| Budget | ${Object.entries(s.budgetByNode).map(([n, b]) => `${n} ${money(b.spent)}/$${b.cap}`).join(', ') || 'none'} |`,
    `| Escalations | ${s.escalations} |`,
    `| Tokens | ${s.tokens.toLocaleString('en-US')} |`,
    `| Cost | ${money(s.usd)} (${Object.entries(s.usdByNode).map(([n, u]) => `${n} ${money(u)}`).join(', ') || 'no turns logged'}) |`,
    `| Value (estimate) | ${money(s.valueUsd)} (${s.valueHours} h × $${config.value.rate}/h) |`,
    '', `Artifacts: \`.sdlc/changes/${slug}/\``, '',
  ].join('\n')
}

export function cmdScorecard(args: Args): void {
  const slug = args.pos[0]
  if (!slug) fail('usage: scorecard <slug> [--json]')
  checkSlug(slug)
  out(args.opt.json ? JSON.stringify(story(slug)) : renderScorecard(slug))
}
