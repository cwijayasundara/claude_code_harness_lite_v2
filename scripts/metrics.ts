// sdlc metrics: the AI-native SDLC playbook metrics plus cost, from git, gh, artifacts and usage.jsonl.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseRules } from './model.ts'
import { inboxEntries } from './inbox.ts'
import {
  ROOT, SDLC, APPROVALS, MANAGED_DIR, managedSettings, managedFiles, USAGE, MIN_SAMPLE, exists, read, frontmatter, readJsonl, git, fail, out, optString, toPosix,
  listChanges, type Args, type Approval, type Change, type UsageRow,
} from './core.ts'
import { loadChange } from './graph.ts'
import { loadConfig } from './check.ts'
import { valueHoursFor } from './scorecard.ts'
import { pointsMetrics } from './points.ts'
import { EVALS, RESULTS, type EvalResult } from './evals.ts'
import { controlsInForce } from './preflight.ts'
import { roleOf } from './routing.ts'
import { safeBudgetView, fetchRef, readRef, peekId, changeSpent } from './spend.ts'
import { backgroundSessions, FIRST_CALL_LIMIT } from './context.ts'

type Ev = { verdict: string; kind?: string; node: string; round?: number }
const readJsonlSafe = (p: string): Ev[] => readJsonl<Ev>(p)
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
    const raw = execFileSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '200', '--json', fields], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 })
    return JSON.parse(raw) as PullRequest[]
  } catch {
    return null
  }
}

// gh JSON for the DORA, triage and rehearsal metrics: null when gh is missing, unauthenticated, has no remote or the call fails.
function ghJson<T>(args: string[]): T[] | null {
  try {
    const v: unknown = JSON.parse(execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }))
    return Array.isArray(v) ? v as T[] : null
  } catch {
    return null
  }
}

function sumBy(rows: UsageRow[], key: (r: UsageRow) => string, value: (r: UsageRow) => number): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const r of rows) totals[key(r)] = (totals[key(r)] ?? 0) + value(r)
  return totals
}

const roundAll = (totals: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v.toFixed(4))]))

export function cmdMetrics(args: Args): void {
  if (!exists(SDLC)) fail('sdlc not initialised here')
  const days = Number(optString(args, 'days') ?? 30)
  const since = Date.now() - days * 86_400_000
  const changes = listChanges().map(loadChange).filter(c => fs.statSync(c.dir).mtimeMs >= since)
  const rel = (c: Change, f: string): string => toPosix(path.relative(ROOT, path.join(c.dir, f)))
  const approvals = readJsonl<Approval>(APPROVALS)
  const prs = ghPrs()
  const prFor = (c: Change): PullRequest | undefined => prs?.find(p => p.body?.includes(`.rig/changes/${c.slug}`))
  const needsGh: Metric = { value: null, n: 0, note: 'needs gh' }
  const m: Record<string, Metric> = {}

  // Plan
  m.plan_lead_hours = median(changes.map(c => hours(c.intent.created, firstCommitTime(rel(c, 'intent.md')))))
  const decided = changes.filter(c => !c.next || c.stages.indexOf(c.next.stage) !== 0)
  m.intent_survival = share(decided.filter(c => exists(path.join(c.dir, 'plan.md')) || exists(path.join(c.dir, 'design.md')) || exists(path.join(c.dir, 'spec.md')) || c.type === 'bugfix').length, decided.length)
  // intent_survival counts changes that got past intent; inbox_survival counts inbox ideas the product owner accepted
  // (accepted or shipped) out of every decided one (closed included); drafts and unknown statuses are undecided.
  const decidedInbox = inboxEntries().filter(e => e.status !== 'draft' && e.status !== 'unknown')
  m.inbox_survival = share(decidedInbox.filter(e => e.status !== 'closed').length, decidedInbox.length)
  // Maintain (p.51): rig-watch's breach intents (.rig/intent/breach-<band>-<date>.md) a person decided: how many shipped as a fix,
  // and how many were dismissed (closed), overall and per band. Dismissals also widen the band (watch.ts).
  const breaches = decidedInbox.filter(e => /^breach-[a-z0-9-]+-\d{8}\.md$/.test(e.file))
  const bandOf = (f: string): string => f.replace(/^breach-/, '').replace(/-\d{8}\.md$/, '')
  m.findings_merged_share = share(breaches.filter(e => e.status === 'shipped').length, breaches.length)
  const byBand = Object.fromEntries([...new Set(breaches.map(e => bandOf(e.file)))].map(b => {
    const mine = breaches.filter(e => bandOf(e.file) === b)
    return [b, Number((mine.filter(e => e.status === 'closed').length / mine.length).toFixed(3))]
  }))
  m.dismissal_rate = { ...share(breaches.filter(e => e.status === 'closed').length, breaches.length), by_band: byBand }
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
  // Commits to intent.md after the first design or spec commit: the "what" moving after the "how" began.
  m.intent_churn_after_design = median(changes.map(c => {
    const first = firstCommitTime(rel(c, 'design.md')) ?? firstCommitTime(rel(c, 'spec.md'))
    return first ? commitTimes(rel(c, 'intent.md')).filter(t => t > first).length : null
  }))
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
  const incidents: Array<Record<string, string>> = exists(incidentDir)
    ? fs.readdirSync(incidentDir).filter(f => f.endsWith('.md')).map(f => ({ ...frontmatter(read(path.join(incidentDir, f))).data, file: f }))
    : []
  const caught = changes.reduce((n, c) => n + Number(c.review.caught ?? 0), 0)
  const escaped = incidents.filter(i => i.escaped === 'true').length
  m.defects_caught_vs_escaped = caught + escaped < MIN_SAMPLE ? { value: null, n: caught + escaped } : { value: caught / (caught + escaped), n: caught + escaped, caught, escaped }
  // Maintain
  m.breach_to_intent_hours = median(incidents.map(i => hours(i.detected, i.intent_at)))
  const classes = incidents.map(i => i.class).filter((c): c is string => Boolean(c))
  m.repeat_incident_share = share(classes.length - new Set(classes).size, classes.length)
  // Test: the last manual eval run, and how long an incident takes to become a permanent eval (its `source` names the incident).
  const evalRows = readJsonl<EvalResult>(RESULTS)
  const lastEvalRun = evalRows.filter(r => r.run === evalRows.at(-1)?.run)
  m.eval_pass_rate = share(lastEvalRun.filter(r => r.pass).length, lastEvalRun.length)
  const evalSources = exists(EVALS) ? fs.readdirSync(EVALS).filter(f => f.endsWith('.json')).map(f => {
    try { return { rel: toPosix(path.relative(ROOT, path.join(EVALS, f))), source: String((JSON.parse(read(path.join(EVALS, f)) || '{}') as { source?: unknown }).source ?? '') } } catch { return { rel: '', source: '' } }
  }) : []
  // An incident with no eval yet has no time: never pass '' to firstCommitTime, which would date the whole repo.
  m.incident_to_eval_hours = median(incidents.map(i => {
    const ev = evalSources.find(e => e.source === `incident:${i.file}`)
    return ev ? hours(i.detected, firstCommitTime(ev.rel)) : null
  }))
  // Govern: the production gate's log (.rig/gates.jsonl, written only by the managed hook) and the managed settings on this machine.
  const waits: (number | null)[] = []
  const open = new Map<string, string>()
  for (const g of readJsonl<{ at?: string; decision?: string; session?: string }>(path.join(SDLC, 'gates.jsonl'))) {
    if (!g.session || !g.at) continue
    if (g.decision === 'block' && !open.has(g.session)) open.set(g.session, g.at)
    if (g.decision === 'allow' && open.has(g.session)) { waits.push(hours(open.get(g.session), g.at)); open.delete(g.session) }
  }
  m.gate_wait_hours = median(waits)
  m.gate_violations_escaped = { value: incidents.filter(i => i.class === 'gate').length, n: incidents.length }
  m.managed_controls_in_force = managedFiles(MANAGED_DIR).length ? { value: controlsInForce(managedSettings(MANAGED_DIR)).length, n: 16 } : { value: null, n: 16, note: 'no managed settings file on this machine' }
  // Deploy (DORA, p.46): deploys are GitHub deployments to the production environment (RIG_PRODUCTION_ENV, default production);
  // lead time runs from a PR's opening to the first deploy at or after its merge. Restore time is from incident files.
  const inWindow = (t?: string | null): t is string => Boolean(t) && Date.parse(t as string) >= since
  const weeks = days / 7
  const deploys = ghJson<{ created_at?: string }>(['api', '-X', 'GET', 'repos/{owner}/{repo}/deployments', '-f', `environment=${process.env.RIG_PRODUCTION_ENV || 'production'}`, '-f', 'per_page=100'])
  const dTimes = (deploys ?? []).map(d => d.created_at).filter(inWindow).sort((a, b) => Date.parse(a) - Date.parse(b))
  const perDeploy = (value: number): Metric => (dTimes.length < MIN_SAMPLE ? { value: null, n: dTimes.length } : { value, n: dTimes.length })
  m.deployment_frequency_per_week = deploys ? perDeploy(Number((dTimes.length / weeks).toFixed(2))) : needsGh
  m.lead_time_hours = deploys && prs
    ? median(prs.filter(p => inWindow(p.mergedAt)).map(p => hours(p.createdAt, dTimes.find(t => Date.parse(t) >= Date.parse(p.mergedAt ?? '')))))
    : needsGh
  m.change_failure_rate = deploys ? perDeploy(Math.min(1, incidents.filter(i => i.escaped === 'true' && inWindow(i.detected)).length / Math.max(1, dTimes.length))) : needsGh
  m.time_to_restore_hours = median(incidents.map(i => { const h = hours(i.detected, i.restored); return h !== null && h >= 0 ? h : null }))
  // Leading (p.46): failed runs a triage answered, and the staging rollback rehearsal's record.
  const failedRuns = ghJson<{ workflowName?: string; createdAt?: string }>(['run', 'list', '--status', 'failure', '--limit', '200', '--json', 'workflowName,createdAt'])
  const triaged = ghJson<{ createdAt?: string }>(['run', 'list', '--workflow', 'rig-triage.yml', '--status', 'success', '--limit', '200', '--json', 'createdAt'])
  // The denominator is failures of the workflows rig-triage.yml watches (its `workflows: [...]`), read from the installed file.
  const watched = /workflows:\s*\[([^\]]*)\]/.exec(read(path.join(ROOT, '.github', 'workflows', 'rig-triage.yml')))?.[1]?.split(',').map(w => w.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  const failedN = (failedRuns ?? []).filter(r => inWindow(r.createdAt) && watched?.includes(r.workflowName ?? '')).length
  m.failures_triaged_without_paging = !watched ? { value: null, n: 0, note: 'rig-triage.yml is not installed' }
    : failedRuns && triaged ? share(Math.min(failedN, triaged.filter(r => inWindow(r.createdAt)).length), failedN) : needsGh
  const rehearsals = ghJson<{ conclusion?: string; createdAt?: string }>(['run', 'list', '--workflow', 'rig-rehearse.yml', '--limit', '100', '--json', 'conclusion,createdAt'])
  const rehearsed = (rehearsals ?? []).filter(r => inWindow(r.createdAt) && r.conclusion)
  m.rollback_rehearsal_success = rehearsals ? { ...share(rehearsed.filter(r => r.conclusion === 'success').length, rehearsed.length), per_week: Number((rehearsed.length / weeks).toFixed(2)) } : needsGh

  // Cost, from the mod's usage log
  const usage = readJsonl<UsageRow>(USAGE).filter(r => Date.parse(r.at) >= since)
  // A negative delta is a session ledger that reset under the mod (an old /clear); its real cost is unknown, so it counts 0.
  const main = usage.filter(r => r.kind === 'main').map(r => ({ ...r, usd: Math.max(0, r.usd ?? 0) }))
  const agents = usage.filter(r => r.kind === 'agent')
  const tokensOf = (r: UsageRow): number => (r.in ?? 0) + (r.out ?? 0) + (r.cr ?? 0) + (r.cw ?? 0)
  const input = usage.reduce((s, r) => s + (r.in ?? 0) + (r.cr ?? 0) + (r.cw ?? 0), 0)
  const written = usage.reduce((s, r) => s + (r.out ?? 0) + (r.cw ?? 0), 0)
  const opusWritten = usage.filter(r => /opus/.test(r.model ?? '')).reduce((s, r) => s + (r.out ?? 0) + (r.cw ?? 0), 0)
  const cost = {
    usd_total: Number(main.reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(2)),
    usd_by_change: roundAll(sumBy(main, r => r.change ?? '(none)', r => r.usd ?? 0)),
    usd_by_stage: roundAll(sumBy(main, r => r.stage ?? '(none)', r => r.usd ?? 0)),
    tokens_by_agent_type: sumBy(agents, r => (r.agentType ?? 'unknown').replace(/^rig-/, 'rig:'), tokensOf),
    tokens_by_role: sumBy(agents, r => roleOf(r.agentType, r.stage), tokensOf),
    model_by_role: Object.fromEntries([...new Set(agents.map(r => roleOf(r.agentType, r.stage)))].map(role =>
      [role, sumBy(agents.filter(r => roleOf(r.agentType, r.stage) === role), r => r.model ?? 'unknown', tokensOf)])),
    cache_hit_share: input ? Number((usage.reduce((s, r) => s + (r.cr ?? 0), 0) / input).toFixed(3)) : null,
    peak_context: main.reduce((p, r) => Math.max(p, r.ctx ?? 0), 0),
    turns_over_150k: main.filter(r => (r.ctx ?? 0) > 150_000).length,
    // The context sensor: the heaviest first call of a session (system prompt plus prompt) and how many sessions started over the limit.
    first_call_context: main.filter(r => r.first).reduce((p, r) => Math.max(p, r.ctx ?? 0), 0),
    heavy_session_starts: main.filter(r => r.first && (r.ctx ?? 0) > FIRST_CALL_LIMIT).length,
    opus_token_share: written ? Number((opusWritten / written).toFixed(3)) : null,
  }

  // Background sessions (proposal 2026-10-08 §3.3.3): model sessions a hook or plugin spawned in this project (sdk-py and the like),
  // which no usage row records. Per change: the sessions that started while the change was open (intent created to ship, or now).
  const bg = backgroundSessions(ROOT, since)
  const spanOf = (c: Change): [number, number] => {
    const start = Date.parse(String(c.intent.created ?? '')) || 0
    const ship = path.join(c.dir, 'ship.json')
    let end = Date.now()
    try { end = Date.parse(String((JSON.parse(read(ship)) as { at?: string }).at ?? '')) || fs.statSync(ship).mtimeMs } catch { /* open change */ }
    return [start, end]
  }
  const bgPerChange: Record<string, number> = {}
  for (const c of changes) {
    const [a, b] = spanOf(c)
    const n = bg.sessions.filter(s => { const t = Date.parse(s.at); return t >= a && t <= b }).length
    if (n) bgPerChange[c.slug] = n
  }
  const background = { sessions: bg.total, by_entrypoint: bg.by_entrypoint, per_change: bgPerChange, note: bg.total ? 'model sessions spawned by hooks or plugins (not in usd_total); one explicit review per change is the target' : undefined }

  const evs = changes.map(c => ({ c, e: readJsonlSafe(path.join(c.dir, 'events.jsonl')) }))
  const perChange = (f: (e: Ev[]) => number): Metric => median(evs.map(x => f(x.e)))
  const autonomy = {
    auto_approved_per_change: perChange(e => e.filter(x => x.kind === 'auto-approve').length),
    escalations_per_change: perChange(e => e.filter(x => x.verdict === 'blocked').length),
    ready_without_escalation: share(evs.filter(x => !x.e.some(y => y.verdict === 'blocked') && !x.c.next).length, evs.filter(x => !x.c.next).length),
  }
  const slicesFirstPass = evs.flatMap(x => x.e.filter(y => y.node.startsWith('build#') && y.verdict === 'done'))
  const ratchetM = {
    slices_first_pass: share(slicesFirstPass.filter(y => (y.round ?? 0) === 0).length, slicesFirstPass.length),
    fix_rounds_per_change: perChange(e => e.filter(x => x.verdict === 'continue').length),
  }
  const { config } = loadConfig()
  // Budget (spend governance spec §6): the team month across every clone that published, and changes in the window over their budget.
  fetchRef()
  const bv = safeBudgetView(config.budget, null)
  const ref = readRef()
  const ledgerRows = readJsonl<UsageRow>(USAGE)
  const selfId = peekId()
  const changeBudgetHits = changes.filter(c => {
    const b = config.budget.changeUsd[c.type === 'greenfield' ? 'L' : c.tier]
    return b !== undefined && changeSpent(ref.files, selfId, ledgerRows, c.slug) >= b
  }).length
  const budget = { month: bv.month, spentUsd: bv.spentUsd, projectedUsd: bv.projectedUsd, budgetUsd: bv.budgetUsd, level: bv.level, sources: bv.sources.length + 1, changeBudgetHits }
  const slugs = new Set(changes.map(c => c.slug))
  const windowUsd = main.filter(r => slugs.has(r.change ?? '')).reduce((n, r) => n + (r.usd ?? 0), 0)
  const valueUsd = changes.reduce((n, c) => n + valueHoursFor(c.slug, c.tier, config.value.hours) * config.value.rate, 0)
  const enough = changes.length >= MIN_SAMPLE
  const economics = {
    usd_by_node: cost.usd_by_stage,
    tokens_by_node: sumBy(usage, r => r.stage ?? '(none)', tokensOf),
    usd_per_change: enough ? Number((windowUsd / changes.length).toFixed(2)) : null,
    value_over_cost: enough && windowUsd > 0 ? Number((valueUsd / windowUsd).toFixed(1)) : null,
    n: changes.length,
    value_is_estimate: true,
  }
  const pointsM = pointsMetrics(changes.map(c => c.slug), days)

  const events = readJsonl<UsageRow>(USAGE).filter(r => r.kind === 'event')
  const fired = events.filter(e => e.event === 'rule-fired')
  const ruleIds = parseRules(read(path.join(SDLC, 'rules.json'))).rules.map(r => r.id)
  const ninetyDays = Date.now() - 90 * 86_400_000
  const introduced = (id: string): number | null => {
    const t = git(['log', '--format=%aI', `-S"${id}"`, '--', '.rig/rules.json'])?.split('\n').filter(Boolean).at(-1)
    return t ? Date.parse(t) : null
  }
  const recent = new Set(fired.filter(e => Date.parse(e.at) >= ninetyDays).map(e => e.rule))
  const findingsOf = (text: string): string => text.split(/^## /m).filter(sec => /^Findings\b/.test(sec)).join('\n')
  const CATEGORY = /^\s*-\s*\[severity:[^\]]*\]\s*\[category:\s*([\w-]+)/gim
  const categoriesOf = (c: Change): string[] => [...findingsOf(read(path.join(c.dir, 'review.md'))).matchAll(CATEGORY)].map(m => (m[1] ?? '').toLowerCase())
  // Distinct changes per category: three findings in one change are one occurrence of the "twice" rule, not three.
  const changesByCategory: Record<string, number> = {}
  for (const c of changes) for (const cat of new Set(categoriesOf(c))) changesByCategory[cat] = (changesByCategory[cat] ?? 0) + 1
  // A category seen on an earlier change again: the signal the "twice" rule (/rig:rule) exists for. Only changes with findings count.
  const seen = new Set<string>()
  let repeats = 0
  const withFindings = [...changes].sort((a, b) => String(a.intent.created).localeCompare(String(b.intent.created)) || a.slug.localeCompare(b.slug)).map(c => new Set(categoriesOf(c))).filter(s => s.size)
  for (const cats of withFindings) {
    if ([...cats].some(c => seen.has(c))) repeats++
    for (const c of cats) seen.add(c)
  }
  m.repeat_findings = share(repeats, withFindings.length)
  const harness = {
    rule_fires: sumBy(fired.filter(e => Date.parse(e.at) >= since), r => r.rule ?? 'unknown', () => 1),
    prune_candidates: ruleIds.filter(id => !recent.has(id) && (introduced(id) ?? Infinity) < ninetyDays),
    rule_suggestions: Object.entries(changesByCategory).filter(([, n]) => n >= 2).map(([c, n]) => `${c} (${n} changes): consider /rig:rule`),
    skill_load_failures: events.filter(e => e.event === 'skill-load-failed' && Date.parse(e.at) >= since).length,
    unresolved: (() => {
      try {
        return (JSON.parse(read(path.join(SDLC, 'unresolved.json'))) as { findings: unknown[] }).findings.length
      } catch {
        return 0
      }
    })(),
  }

  if (args.opt.json) return out(JSON.stringify({ days, changes: changes.length, metrics: { ...m, cost, background, budget, harness, autonomy, ratchet: ratchetM, economics, points: pointsM } }, null, 2))
  const fmt = (v: Metric): string => (v.value === null ? `unmeasured (n=${v.n}${v.note ? ', ' + v.note : ''})` : `${Number(v.value.toFixed(2))} (n=${v.n})`)
  const rows = Object.entries(m).map(([k, v]) => `${k.padEnd(30)} ${fmt(v)}`)
  out([`sdlc metrics, last ${days} days, ${changes.length} change(s)`, ...rows, '', 'cost', JSON.stringify(cost, null, 2), '', 'background sessions (hook- or plugin-spawned model sessions in ~/.claude/projects; not in usd_total)', JSON.stringify(background, null, 2), '', 'budget (soft; every clone that published plus this one)', JSON.stringify(budget, null, 2), '', 'harness (fire counts come from this machine\'s usage.jsonl; treat prune candidates as suggestions to confirm)', JSON.stringify(harness, null, 2), '', 'autonomy', JSON.stringify(autonomy, null, 2), '', 'ratchet', JSON.stringify(ratchetM, null, 2), '', 'economics (value is an estimate: tier hours x rate)', JSON.stringify(economics, null, 2), '', 'points (shipped in the window; unmeasured below 5 shipped changes)', JSON.stringify(pointsM, null, 2)].join('\n'))
}
