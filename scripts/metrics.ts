// sdlc metrics: the AI-native SDLC playbook metrics plus cost, from git, gh, artifacts and usage.jsonl.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseRules } from './model.ts'
import {
  ROOT, SDLC, APPROVALS, USAGE, MIN_SAMPLE, exists, read, frontmatter, readJsonl, git, fail, out, optString, toPosix,
  listChanges, loadChange, type Args, type Approval, type Change, type UsageRow,
} from './core.ts'

type Metric = { value: number | null; n: number; note?: string; [extra: string]: unknown }
type PullRequest = {
  number: number
  createdAt: string
  mergedAt: string | null
  body?: string
  reviews?: { submittedAt?: string }[]
  statusCheckRollup?: { conclusion?: string | null; state?: string | null }[]
}

const hours = (a?: string | null, b?: string | null): number | null => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : null)

function median(xs: (number | null)[]): Metric {
  const v = xs.filter((x): x is number => x !== null && !Number.isNaN(x)).sort((a, b) => a - b)
  if (v.length < MIN_SAMPLE) return { value: null, n: v.length }
  const mid = Math.floor(v.length / 2)
  const value = v.length % 2 ? v[mid] ?? null : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2
  return { value, n: v.length }
}

const share = (hits: number, n: number): Metric => (n < MIN_SAMPLE ? { value: null, n } : { value: hits / n, n })

function firstCommitTime(file: string): string | null {
  const t = git(['log', '--diff-filter=A', '--follow', '--format=%aI', '--', file])
  return t ? t.split('\n').at(-1) ?? null : null
}

function commitTimes(file: string): string[] {
  const t = git(['log', '--format=%aI', '--', file])
  return t ? t.split('\n').filter(Boolean) : []
}

function ghPrs(): PullRequest[] | null {
  try {
    const fields = 'number,createdAt,mergedAt,body,reviews,statusCheckRollup'
    const raw = execFileSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '200', '--json', fields], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(raw) as PullRequest[]
  } catch {
    return null
  }
}

function sumBy(rows: UsageRow[], key: (r: UsageRow) => string, value: (r: UsageRow) => number): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const r of rows) totals[key(r)] = (totals[key(r)] ?? 0) + value(r)
  return totals
}

export function cmdMetrics(args: Args): void {
  if (!exists(SDLC)) fail('sdlc not initialised here')
  const days = Number(optString(args, 'days') ?? 30)
  const since = Date.now() - days * 86_400_000
  const changes = listChanges().map(loadChange).filter(c => fs.statSync(c.dir).mtimeMs >= since)
  const rel = (c: Change, f: string): string => toPosix(path.relative(ROOT, path.join(c.dir, f)))
  const approvals = readJsonl<Approval>(APPROVALS)
  const prs = ghPrs()
  const prFor = (c: Change): PullRequest | undefined => prs?.find(p => p.body?.includes(`.sdlc/changes/${c.slug}`))
  const needsGh: Metric = { value: null, n: 0, note: 'needs gh' }
  const m: Record<string, Metric> = {}

  // Plan
  m.plan_lead_hours = median(changes.map(c => hours(c.intent.created, firstCommitTime(rel(c, 'intent.md')))))
  const decided = changes.filter(c => !c.next || c.stages.indexOf(c.next.stage) !== 0)
  m.intent_survival = share(decided.filter(c => exists(path.join(c.dir, 'plan.md')) || exists(path.join(c.dir, 'spec.md')) || c.type === 'bugfix').length, decided.length)
  // Design
  m.intent_to_spec_hours = median(changes.map(c => hours(firstCommitTime(rel(c, 'intent.md')), firstCommitTime(rel(c, 'spec.md')))))
  m.spec_churn_after_plan = median(
    changes
      .filter(c => exists(path.join(c.dir, 'spec.md')) && exists(path.join(c.dir, 'plan.md')))
      .map(c => {
        const firstPlan = firstCommitTime(rel(c, 'plan.md'))
        return firstPlan ? commitTimes(rel(c, 'spec.md')).filter(t => t > firstPlan).length : null
      }),
  )
  // Build
  const reviewed = changes.filter(c => c.review.rounds)
  m.first_pass_share = share(reviewed.filter(c => Number(c.review.rounds) <= 1).length, reviewed.length)
  m.rework_cycles = median(reviewed.map(c => Math.max(0, Number(c.review.rounds) - 1)))
  const shipped = changes.flatMap(c => {
    const file = path.join(c.dir, 'ship.json')
    return exists(file) ? [JSON.parse(read(file)) as { drift?: string[] }] : []
  })
  m.diff_matches_plan = share(shipped.filter(s => !s.drift?.length).length, shipped.length)
  m.plan_approval_to_merge_hours = prs
    ? median(changes.map(c => hours(approvals.filter(a => a.slug === c.slug && a.stage === 'plan').at(-1)?.at, prFor(c)?.mergedAt)))
    : needsGh
  // Test & Deploy (from GitHub)
  if (prs) {
    const ours = changes.map(prFor).filter((p): p is PullRequest => Boolean(p))
    const green = (p: PullRequest): boolean => (p.statusCheckRollup ?? []).every(s => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s.conclusion ?? s.state ?? 'SUCCESS'))
    m.first_pass_ci = share(ours.filter(green).length, ours.length)
    m.review_time_hours = median(ours.map(p => hours(p.createdAt, p.mergedAt)))
    m.time_to_first_review_hours = median(ours.map(p => hours(p.createdAt, p.reviews?.[0]?.submittedAt)))
  } else {
    m.first_pass_ci = needsGh
    m.review_time_hours = needsGh
    m.time_to_first_review_hours = needsGh
  }
  const incidentDir = path.join(SDLC, 'incidents')
  const incidents = exists(incidentDir)
    ? fs.readdirSync(incidentDir).filter(f => f.endsWith('.md')).map(f => frontmatter(read(path.join(incidentDir, f))).data)
    : []
  const caught = changes.reduce((n, c) => n + Number(c.review.caught ?? 0), 0)
  const escaped = incidents.filter(i => i.escaped === 'true').length
  m.defects_caught_vs_escaped = caught + escaped < MIN_SAMPLE ? { value: null, n: caught + escaped } : { value: caught / (caught + escaped), n: caught + escaped, caught, escaped }
  // Maintain
  m.breach_to_intent_hours = median(incidents.map(i => hours(i.detected, i.intent_at)))
  const classes = incidents.map(i => i.class).filter((c): c is string => Boolean(c))
  m.repeat_incident_share = share(classes.length - new Set(classes).size, classes.length)

  // Cost, from the mod's usage log
  const usage = readJsonl<UsageRow>(USAGE).filter(r => Date.parse(r.at) >= since)
  const main = usage.filter(r => r.kind === 'main')
  const agents = usage.filter(r => r.kind === 'agent')
  const tokensOf = (r: UsageRow): number => (r.in ?? 0) + (r.out ?? 0) + (r.cr ?? 0) + (r.cw ?? 0)
  const input = usage.reduce((s, r) => s + (r.in ?? 0) + (r.cr ?? 0) + (r.cw ?? 0), 0)
  const written = usage.reduce((s, r) => s + (r.out ?? 0) + (r.cw ?? 0), 0)
  const opusWritten = usage.filter(r => /opus/.test(r.model ?? '')).reduce((s, r) => s + (r.out ?? 0) + (r.cw ?? 0), 0)
  const cost = {
    usd_total: Number(main.reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(2)),
    usd_by_change: sumBy(main, r => r.change ?? '(none)', r => r.usd ?? 0),
    usd_by_stage: sumBy(main, r => r.stage ?? '(none)', r => r.usd ?? 0),
    tokens_by_agent_type: sumBy(agents, r => r.agentType ?? 'unknown', tokensOf),
    cache_hit_share: input ? Number((usage.reduce((s, r) => s + (r.cr ?? 0), 0) / input).toFixed(3)) : null,
    peak_context: main.reduce((p, r) => Math.max(p, r.ctx ?? 0), 0),
    turns_over_150k: main.filter(r => (r.ctx ?? 0) > 150_000).length,
    opus_token_share: written ? Number((opusWritten / written).toFixed(3)) : null,
  }

  const events = readJsonl<UsageRow>(USAGE).filter(r => r.kind === 'event')
  const fired = events.filter(e => e.event === 'rule-fired')
  const ruleIds = parseRules(read(path.join(SDLC, 'rules.json'))).rules.map(r => r.id)
  const ninetyDays = Date.now() - 90 * 86_400_000
  const introduced = (id: string): number | null => {
    const t = git(['log', '--format=%aI', `-S"${id}"`, '--', '.sdlc/rules.json'])?.split('\n').filter(Boolean).at(-1)
    return t ? Date.parse(t) : null
  }
  const recent = new Set(fired.filter(e => Date.parse(e.at) >= ninetyDays).map(e => e.rule))
  const findingsOf = (text: string): string => text.split(/^## /m).filter(sec => /^Findings\b/.test(sec)).join('\n')
  const categories = changes.flatMap(c => [...findingsOf(read(path.join(c.dir, 'review.md'))).matchAll(/^\s*-\s*\[severity:[^\]]*\]\s*\[category:\s*([\w-]+)/gim)].map(m => (m[1] ?? '').toLowerCase()))
  const byCategory = categories.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {})
  const harness = {
    rule_fires: sumBy(fired.filter(e => Date.parse(e.at) >= since), r => r.rule ?? 'unknown', () => 1),
    prune_candidates: ruleIds.filter(id => !recent.has(id) && (introduced(id) ?? Infinity) < ninetyDays),
    rule_suggestions: Object.entries(byCategory).filter(([, n]) => n >= 3).map(([c, n]) => `${c} (${n} findings): consider /sdlc:rule`),
    skill_load_failures: events.filter(e => e.event === 'skill-load-failed' && Date.parse(e.at) >= since).length,
    unresolved: (() => {
      try {
        return (JSON.parse(read(path.join(SDLC, 'unresolved.json'))) as { findings: unknown[] }).findings.length
      } catch {
        return 0
      }
    })(),
  }

  if (args.opt.json) return out(JSON.stringify({ days, changes: changes.length, metrics: { ...m, cost, harness } }, null, 2))
  const fmt = (v: Metric): string => (v.value === null ? `unmeasured (n=${v.n}${v.note ? ', ' + v.note : ''})` : `${Number(v.value.toFixed(2))} (n=${v.n})`)
  const rows = Object.entries(m).map(([k, v]) => `${k.padEnd(30)} ${fmt(v)}`)
  out([`sdlc metrics, last ${days} days, ${changes.length} change(s)`, ...rows, '', 'cost', JSON.stringify(cost, null, 2), 'harness (fire counts come from this machine\'s usage.jsonl; treat prune candidates as suggestions to confirm)', JSON.stringify(harness, null, 2)].join('\n'))
}
