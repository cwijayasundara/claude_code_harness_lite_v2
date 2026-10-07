// The stage graph: which nodes a change walks (type × tier), which are gated (sensors.json "gates"),
// when each node is done (its artifacts on disk), and the active change. Pure over files and git.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, CHANGES, planPath, STATE, now, createChange, exists, read, sha, git, toPosix, frontmatter, reportFields, approvalOf, needsImpact, readImpact, listChanges, isShipped, SLUG_RE, skillRef,
  APPROVAL_ARTIFACTS, type ChangeType, type Tier, type Stage, type GatedStage, type ApprovalState, type Next, type Change,
} from './core.ts'
import { loadConfig } from './check.ts'
import { readRatchet, spendUsd, block, readEvents } from './ratchet.ts'
import type { SensorConfig, RatchetNode } from './model.ts'

export const PATHS: Record<ChangeType, Stage[]> = {
  greenfield: ['intent', 'design', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  feature: ['intent', 'design', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  bugfix: ['intent', 'plan', 'diagnose', 'test', 'sensors', 'pr', 'pr-review'],
  incident: ['intent', 'plan', 'diagnose', 'test', 'sensors', 'pr', 'pr-review'],
  refactor: ['intent', 'plan', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  migration: ['intent', 'plan', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  chore: ['intent', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  spike: ['intent', 'notes'],
}
const ARTIFACTS: Partial<Record<Stage, string>> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', design: 'design.md', notes: 'notes.md' }
const TIERS: Tier[] = ['S', 'M', 'L']
export const isChangeType = (v: string | undefined): v is ChangeType => v !== undefined && v in PATHS
export const isTier = (v: string | undefined): v is Tier => v !== undefined && (TIERS as string[]).includes(v)

// Tier S and M PR review runs in CI (templates/rig-review.yml) only where one can: workflow installed, origin remote set.
export const prReviewAvailable = (): boolean => (exists(path.join(ROOT, '.github/workflows/rig-review.yml')) || exists(path.join(ROOT, '.github/workflows/sdlc-review.yml'))) && git(['remote', 'get-url', 'origin']) !== null
export const gatesFor = (type: ChangeType, tier: Tier, config: SensorConfig): GatedStage[] => config.gates[type === 'greenfield' ? 'greenfield' : tier]

const committed = (slug: string, file: string): boolean => Boolean(git(['log', '-1', '--format=%H', '--', toPosix(path.relative(ROOT, path.join(CHANGES, slug, file)))]))
export const prRecorded = (slug: string): boolean => committed(slug, 'pr.md')
// The pr node is done once pr.md is committed AND either the change is local-only and still has no origin, or a real PR url was recorded
// (a pushed branch whose gh pr create failed is not done; `pr` resumes it).
export const prDone = (slug: string): boolean =>
  prRecorded(slug) && ((/^state: local-only$/m.test(read(path.join(CHANGES, slug, 'pr.md'))) && !git(['remote', 'get-url', 'origin'])) || readEvents(slug).some(e => e.kind === 'pr' && /^https?:\/\//.test(e.target ?? '')))
export const isLegacyShipped = (slug: string): boolean => isShipped(slug) && !exists(path.join(CHANGES, slug, 'pr.md'))

const RANK: Record<Tier, number> = { S: 0, M: 1, L: 2 }

// intent.md is model-writable, so the recorded tier and type (ratchet.json, written by sdlc) bound it from below: the stricter wins.
// No recorded tier (a legacy or hand-made change folder) fails closed to L. Greenfield, once either side says it, stays greenfield;
// any other recorded type holds, and with none recorded the type is feature, so intent.md never picks a shorter path.
export function effective(slug: string, intent: Record<string, string>): { type: ChangeType; tier: Tier } {
  const r = readRatchet(slug)
  const iType: ChangeType = isChangeType(intent.type) ? intent.type : 'feature'
  const iTier: Tier = isTier(intent.tier) ? intent.tier : 'M'
  const rTier: Tier = isTier(r.tier) ? r.tier : 'L'
  const type: ChangeType = iType === 'greenfield' ? iType : isChangeType(r.type) ? r.type : 'feature'
  return { type, tier: RANK[iTier] > RANK[rTier] ? iTier : rTier }
}

// Warns when intent.md names another tier or type than the one in force; the message carries the exact command that accepts it.
export function tierDrift(slug: string): string | null {
  if (isLegacyShipped(slug)) return null
  const r = readRatchet(slug)
  const intent = frontmatter(read(path.join(CHANGES, slug, 'intent.md'))).data
  const iType: ChangeType = isChangeType(intent.type) ? intent.type : 'feature'
  const iTier: Tier = isTier(intent.tier) ? intent.tier : 'M'
  const now = effective(slug, intent)
  const accept = `/rig-approve ${slug} tier ${iTier} ${iType} to accept`
  if (!isTier(r.tier)) return `no recorded tier, so gated as L: ${accept}`
  const changed: [string, string][] = []
  if (iTier !== r.tier) changed.push(['tier', `${r.tier} → ${iTier}`])
  if (iType !== now.type) changed.push(['type', `${now.type} → ${iType}`])
  return changed.length ? `${changed.map(c => c[0]).join(' and ')} changed in intent.md (${changed.map(c => c[1]).join(', ')}): ${accept}` : null
}

export function loadChange(slug: string): Change {
  const dir = path.join(CHANGES, slug)
  const intent = frontmatter(read(path.join(dir, 'intent.md'))).data
  const { type, tier } = effective(slug, intent)
  const { config } = loadConfig()
  const verification = reportFields(read(path.join(dir, 'verification.md')), ['result'])
  const review = reportFields(read(path.join(dir, 'review.md')), ['result', 'rounds', 'caught'])
  let stages = PATHS[type]
  if (tier === 'S' && type !== 'greenfield') stages = stages.filter(s => s !== 'spec')
  if ((type === 'bugfix' || type === 'incident') && tier !== 'L') stages = stages.filter(s => s !== 'plan')
  if (tier === 'M' && type !== 'greenfield') stages = stages.filter(s => s !== 'spec')
  if ((tier === 'S' || tier === 'M') && type !== 'greenfield' && prReviewAvailable()) stages = stages.filter(s => s !== 'pr-review')
  const gates = gatesFor(type, tier, config)
  const isDone = (stage: Stage): boolean => {
    switch (stage) {
      case 'build': return readRatchet(slug).nodes.build?.status === 'done'
      case 'diagnose': return exists(path.join(dir, 'verification.md'))
      case 'test': {
        const v = frontmatter(read(path.join(dir, 'verification.md'))).data
        const runs = read(path.join(dir, 'runs.jsonl')).split('\n').slice(0, Number(v.runs)).join('\n')
        return Number(v.runs) >= 1 && v.generated === 'sdlc' && v.result === 'pass' && sha(runs) === v.digest
      }
      case 'sensors': return readRatchet(slug).nodes.sensors?.status === 'done'
      case 'pr': return prDone(slug)
      case 'pr-review': return (review.result === 'pass' || review.result === 'accepted') && readRatchet(slug).nodes['pr-review']?.status !== 'open'
          && (!git(['remote', 'get-url', 'origin']) || /^(pass|no-ci)$/.test(readEvents(slug).filter(e => e.kind === 'checks').at(-1)?.verdict ?? ''))
      case 'design': return exists(path.join(dir, 'design.md')) || exists(path.join(dir, 'plan.md'))
      default: return exists(path.join(dir, ARTIFACTS[stage] ?? ''))
    }
  }
  // A change planned before design existed (plan.md, no design.md) keeps its plan gate.
  const gateOf = (stage: Stage): GatedStage => (stage === 'design' && !exists(path.join(dir, 'design.md')) ? 'plan' : (stage as GatedStage))
  const approvalState = (gate: GatedStage): ApprovalState => approvalOf(slug, gate)
  let next: Next | null = null
  for (const stage of isLegacyShipped(slug) ? [] : stages) {
    if (!isDone(stage)) { next = { stage, kind: 'work' }; break }
    if ((gates as Stage[]).includes(stage) && approvalState(gateOf(stage)) !== 'approved') {
      next = { stage, kind: 'approve', state: approvalState(gateOf(stage)), gate: gateOf(stage) }
      break
    }
    if ((stage === 'plan' || stage === 'design') && needsImpact(readImpact(slug)) && approvalState('impact') !== 'approved') {
      next = { stage, kind: 'approve', state: approvalState('impact'), gate: 'impact' }
      break
    }
  }
  return { slug, dir, type, tier, stages, gates, next, intent, verification, review }
}

export function nextCommand(change: Change): string {
  const next = change.next
  if (!next) return 'done: nothing left for this change'
  if (next.kind === 'approve') {
    const why = next.state === 'stale' ? ' (approval is stale: the artifact changed after it was approved)' : ''
    const what = next.gate === 'impact' ? `the cross-repo impact in ${change.slug}/impact.json and ${path.basename(planPath(change.slug))}` : `${change.slug}/${APPROVAL_ARTIFACTS[next.gate]}`
    return `human gate: review ${next.gate === 'design' ? `${change.slug}/intent.md and ${change.slug}/design.md` : what}, then run /rig-approve ${change.slug} ${next.gate}${why}`
  }
  if (next.stage === 'intent') return `${skillRef('start')} ${change.slug}`
  if (next.stage === 'notes') return `${skillRef('start')} ${change.slug} (spike: answer in notes.md)`
  if (next.stage === 'plan' && (change.type === 'bugfix' || change.type === 'incident')) return `${skillRef('diagnose')} ${change.slug}`
  return `${skillRef(next.stage)} ${change.slug}`
}

// STATE.md decides when it names a change. A change is active until its graph has no next node, so it stays
// active after its PR (pr-review follows). A missing STATE.md falls back to the newest unfinished change.
export function activeSlug(): string | null {
  const { data } = frontmatter(read(STATE))
  if ('change' in data) return data.change && SLUG_RE.test(data.change) && exists(path.join(CHANGES, data.change)) && loadChange(data.change).next !== null ? data.change : null
  const byMtime = listChanges()
    .filter(slug => loadChange(slug).next !== null)
    .map(slug => ({ slug, t: fs.statSync(path.join(CHANGES, slug)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return byMtime[0]?.slug ?? null
}

export type Verdict = 'continue' | 'human' | 'blocked' | 'ready'
export type Step = { slug: string; node: Stage | null; verdict: Verdict; reason: string; command: string; round: number; progress: number }
export const AUTONOMOUS: ReadonlySet<Stage> = new Set<Stage>(['build', 'diagnose', 'test', 'sensors', 'pr', 'pr-review'])
const BUDGETED = new Set(['build', 'test', 'sensors', 'pr-review'])

// The transition function: never asks a model. /rig-next (skill and mod), status and the autonomous run all read it.
export function step(slug: string): Step {
  const change = loadChange(slug)
  const node = change.next?.stage ?? null
  const ratchet = readRatchet(slug)
  const round = node && BUDGETED.has(node) ? (ratchet.nodes[node as RatchetNode]?.rounds ?? 0) : 0
  // Finished build slices: partial progress inside a node that has not changed round.
  const progress = node === 'build' ? Object.values(ratchet.slices).filter(sl => sl.status === 'done').length : 0
  const base = { slug, node, round, progress, command: nextCommand(change) }
  if (!change.next) return { ...base, verdict: 'ready', reason: 'every node is done; a person merges the PR' }
  // R46: a gate or level block is cleared by the node's own code (pr re-runs the gate, verify-report re-derives levels) once a person
  // fixed or waived it, so the node resumes; cap, stall, budget and other need /rig-approve <slug> budget.
  const blocked = ratchet.blocked
  const pending = blocked && (blocked.kind === 'gate' || blocked.kind === 'level') ? ` (pending block: ${blocked.node}: ${blocked.reason})` : ''
  if (blocked && !pending) return { ...base, verdict: 'blocked', reason: `${blocked.node}: ${blocked.reason}` }
  if (change.next.kind === 'approve') return { ...base, verdict: 'human', reason: base.command + pending }
  if (node && BUDGETED.has(node)) {
    const cap = loadConfig().config.ratchet.usd[node as RatchetNode]
    const spent = spendUsd(slug, node)
    if (spent > cap) {
      const reason = `budget: ${node} spent $${spent.toFixed(2)} of $${cap}`
      block(slug, node, reason, 'budget')
      return { ...base, verdict: 'blocked', reason: `${node}: ${reason}` }
    }
  }
  return { ...base, verdict: 'continue', reason: `next node: ${node}${pending}` }
}

// Work done without /rig:start is recorded as an ad-hoc chore so the ship gate and CI still triage it.
export function createAdhoc(tier: Tier): string {
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12)
  let slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}`
  for (let n = 2; exists(path.join(CHANGES, slug)); n++) slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}-${n}`
  createChange(slug, 'chore', tier, 'Ad-hoc change made without /rig:start', { value: loadConfig().config.points[tier], set: false })
  return slug
}
