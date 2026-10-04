// One story's numbers (band, pane, PR body): tokens, cost per node, estimated value, rounds and autonomy.
import path from 'node:path'
import { CHANGES, USAGE, read, readJsonl, frontmatter, out, fail, checkSlug, type Args, type UsageRow } from './core.ts'
import { loadChange, step } from './graph.ts'
import { readEvents, readRatchet, rawSpendUsd } from './ratchet.ts'
import { loadConfig } from './check.ts'
import type { RatchetNode } from './model.ts'

export type Story = { slug: string; node: string | null; verdict: string; round: number; cap: number; tokens: number; usd: number; usdByNode: Record<string, number>; valueUsd: number; valueHours: number; autoApproved: number; escalations: number; levels: string; sensors: string }

const tokensOf = (r: UsageRow): number => (r.in ?? 0) + (r.out ?? 0) + (r.cr ?? 0) + (r.cw ?? 0)

export function story(slug: string): Story {
  checkSlug(slug)
  const { config } = loadConfig()
  const change = loadChange(slug)
  const s = step(slug)
  const rows = readJsonl<UsageRow>(USAGE).filter(r => r.change === slug)
  // Money actually spent: main rows only, before any budget credit (credits are for enforcement, not reporting).
  const usdByNode: Record<string, number> = {}
  for (const stage of new Set(rows.filter(r => r.kind === 'main').map(r => r.stage ?? '(none)'))) {
    usdByNode[stage] = Number(rawSpendUsd(slug, stage === '(none)' ? undefined : stage).toFixed(4))
  }
  // A value override needs a reason; "value_hours: 6" alone is ignored.
  const override = /^value_hours:\s*(\d+(?:\.\d+)?)\s+because\s+\S/m.exec(read(path.join(CHANGES, slug, 'plan.md')))
  const valueHours = override ? Number(override[1]) : config.value.hours[change.tier]
  const events = readEvents(slug)
  const r = readRatchet(slug)
  const node = s.node as RatchetNode | null
  return {
    slug, node: s.node, verdict: s.verdict, round: s.round, cap: node && node in config.ratchet.rounds ? config.ratchet.rounds[node] : 0,
    tokens: rows.reduce((n, x) => n + tokensOf(x), 0), usd: Number(rawSpendUsd(slug).toFixed(4)), usdByNode, valueHours, valueUsd: Math.round(valueHours * config.value.rate),
    autoApproved: events.filter(e => e.kind === 'auto-approve').length, escalations: events.filter(e => e.verdict === 'blocked').length,
    levels: frontmatter(read(path.join(CHANGES, slug, 'verification.md'))).data.levels ?? '',
    sensors: r.nodes.sensors?.status === 'done' ? 'pass' : r.nodes.sensors ? 'open' : 'not run',
  }
}

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
    `| Auto-approved tool calls | ${s.autoApproved} |`,
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
