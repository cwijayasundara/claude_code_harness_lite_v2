// The stage graph: which nodes a change walks (type × tier), which are gated (sensors.json "gates"),
// when each node is done (its artifacts on disk), and the active change. Pure over files and git.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, CHANGES, STATE, exists, read, sha, git, toPosix, frontmatter, reportFields, approvalOf, needsImpact, readImpact, listChanges, isShipped, skillRef,
  APPROVAL_ARTIFACTS, type ChangeType, type Tier, type Stage, type GatedStage, type ApprovalState, type Next, type Change,
} from './core.ts'
import { loadConfig } from './check.ts'
import { readRatchet, spendUsd, block, readEvents } from './ratchet.ts'
import type { SensorConfig, RatchetNode } from './model.ts'

export const PATHS: Record<ChangeType, Stage[]> = {
  greenfield: ['intent', 'spec', 'plan', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  feature: ['intent', 'spec', 'plan', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  bugfix: ['intent', 'plan', 'diagnose', 'test', 'sensors', 'pr', 'pr-review'],
  incident: ['intent', 'plan', 'diagnose', 'test', 'sensors', 'pr', 'pr-review'],
  refactor: ['intent', 'plan', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  migration: ['intent', 'plan', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  chore: ['intent', 'build', 'test', 'sensors', 'pr', 'pr-review'],
  spike: ['intent', 'notes'],
}
const ARTIFACTS: Partial<Record<Stage, string>> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', notes: 'notes.md' }
const TIERS: Tier[] = ['S', 'M', 'L']
export const isChangeType = (v: string | undefined): v is ChangeType => v !== undefined && v in PATHS
export const isTier = (v: string | undefined): v is Tier => v !== undefined && (TIERS as string[]).includes(v)

// Tier S and M PR review runs in CI (templates/sdlc-review.yml) only where one can: workflow installed, origin remote set.
export const prReviewAvailable = (): boolean => exists(path.join(ROOT, '.github/workflows/sdlc-review.yml')) && git(['remote', 'get-url', 'origin']) !== null
export const gatesFor = (type: ChangeType, tier: Tier, config: SensorConfig): GatedStage[] => config.gates[type === 'greenfield' ? 'greenfield' : tier]

const committed = (slug: string, file: string): boolean => Boolean(git(['log', '-1', '--format=%H', '--', toPosix(path.relative(ROOT, path.join(CHANGES, slug, file)))]))
export const prRecorded = (slug: string): boolean => committed(slug, 'pr.md')
// The pr node is done once pr.md is committed AND either the change is local-only or a real PR url was recorded
// (a pushed branch whose gh pr create failed is not done; `pr` resumes it).
export const prDone = (slug: string): boolean =>
  prRecorded(slug) && (/^state: local-only$/m.test(read(path.join(CHANGES, slug, 'pr.md'))) || readEvents(slug).some(e => e.kind === 'pr' && /^https?:\/\//.test(e.target ?? '')))
export const isLegacyShipped = (slug: string): boolean => isShipped(slug) && !exists(path.join(CHANGES, slug, 'pr.md'))

export function loadChange(slug: string): Change {
  const dir = path.join(CHANGES, slug)
  const intent = frontmatter(read(path.join(dir, 'intent.md'))).data
  const type: ChangeType = isChangeType(intent.type) ? intent.type : 'feature'
  const tier: Tier = isTier(intent.tier) ? intent.tier : 'M'
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
      default: return exists(path.join(dir, ARTIFACTS[stage] ?? ''))
    }
  }
  const approvalState = (gate: GatedStage): ApprovalState => approvalOf(slug, gate)
  let next: Next | null = null
  for (const stage of isLegacyShipped(slug) ? [] : stages) {
    if (!isDone(stage)) { next = { stage, kind: 'work' }; break }
    if ((gates as Stage[]).includes(stage) && approvalState(stage as GatedStage) !== 'approved') {
      next = { stage, kind: 'approve', state: approvalState(stage as GatedStage), gate: stage as GatedStage }
      break
    }
    if (stage === 'plan' && needsImpact(readImpact(slug)) && approvalState('impact') !== 'approved') {
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
    const what = next.gate === 'impact' ? `the cross-repo impact in ${change.slug}/impact.json and plan.md` : `${change.slug}/${APPROVAL_ARTIFACTS[next.gate]}`
    return `human gate: review ${what}, then run /sdlc-approve ${change.slug} ${next.gate}${why}`
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
  if ('change' in data) return data.change && exists(path.join(CHANGES, data.change)) && loadChange(data.change).next !== null ? data.change : null
  const byMtime = listChanges()
    .filter(slug => loadChange(slug).next !== null)
    .map(slug => ({ slug, t: fs.statSync(path.join(CHANGES, slug)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return byMtime[0]?.slug ?? null
}

export type Verdict = 'continue' | 'human' | 'blocked' | 'ready'
export type Step = { slug: string; node: Stage | null; verdict: Verdict; reason: string; command: string; round: number }
export const AUTONOMOUS: ReadonlySet<Stage> = new Set<Stage>(['build', 'diagnose', 'test', 'sensors', 'pr', 'pr-review'])
const BUDGETED = new Set(['build', 'test', 'sensors', 'pr-review'])

// The transition function: never asks a model. /sdlc-next (skill and mod), status and auto-approval all read it.
export function step(slug: string): Step {
  const change = loadChange(slug)
  const node = change.next?.stage ?? null
  const ratchet = readRatchet(slug)
  const round = node && BUDGETED.has(node) ? (ratchet.nodes[node as RatchetNode]?.rounds ?? 0) : 0
  const base = { slug, node, round, command: nextCommand(change) }
  if (!change.next) return { ...base, verdict: 'ready', reason: 'every node is done; a person merges the PR' }
  if (ratchet.blocked) return { ...base, verdict: 'blocked', reason: `${ratchet.blocked.node}: ${ratchet.blocked.reason}` }
  if (change.next.kind === 'approve') return { ...base, verdict: 'human', reason: base.command }
  if (node && BUDGETED.has(node)) {
    const cap = loadConfig().config.ratchet.usd[node as RatchetNode]
    const spent = spendUsd(slug, node)
    if (spent > cap) {
      const reason = `budget: ${node} spent $${spent.toFixed(2)} of $${cap}`
      block(slug, node, reason)
      return { ...base, verdict: 'blocked', reason: `${node}: ${reason}` }
    }
  }
  return { ...base, verdict: 'continue', reason: `next node: ${node}` }
}
