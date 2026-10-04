// rig learn, the I/O half: load the evidence and the diff corpus of shipped changes, write proposals.json.
import fs from 'node:fs'
import path from 'node:path'
import { CHANGES, SDLC, ROOT, WAIVERS, read, exists, listChanges, isShipped, readJsonl, git, toPosix, out, fail, optString, ensureGitignore, type Args, type Waiver } from './core.ts'
import { parseUnifiedDiff, type FileDiff } from './model.ts'
import { readEvents, parseReviewFindings } from './ratchet.ts'
import { diagnose, formatReport, LEARN, type ChangeEvidence, type LearnReport } from './learn.ts'

export const RULES = path.join(SDLC, 'rules.json')
export const PROPOSALS = path.join(SDLC, 'learn', 'proposals.json')

// The change's diff is base..head, where head is the first commit that added ship.json.
function rebuildDiff(slug: string): FileDiff[] | null {
  let base: unknown
  try { base = (JSON.parse(read(path.join(CHANGES, slug, 'ship.json'))) as { base?: unknown }).base } catch { return null }
  if (typeof base !== 'string' || !/^[0-9a-f]{7,40}$/.test(base)) return null
  const rel = toPosix(path.relative(ROOT, path.join(CHANGES, slug, 'ship.json')))
  const head = (git(['log', '--diff-filter=A', '--format=%H', '--', rel]) ?? '').split('\n').filter(Boolean).at(-1)
  if (!head) return null
  const raw = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', base, head])
  return raw === null ? null : parseUnifiedDiff(raw)
}

function loadChange(slug: string, waivers: Waiver[]): ChangeEvidence {
  const diffs = rebuildDiff(slug)
  const events = (() => { try { return readEvents(slug) } catch { return [] } })()
  return {
    slug,
    findings: parseReviewFindings(read(path.join(CHANGES, slug, 'review.md'))),
    waivers: waivers.filter(w => w.slug === slug).map(w => ({ sensor: w.sensor, file: w.file, reason: w.reason })),
    blockedReasons: events.filter(e => e.verdict === 'blocked' && e.reason).map(e => e.reason as string),
    diffs: diffs ?? [],
    rebuilt: diffs !== null,
  }
}

export function loadEvidence(): ChangeEvidence[] {
  const waivers = readJsonl<Waiver>(WAIVERS)
  return listChanges().filter(isShipped).sort().map(slug => loadChange(slug, waivers))
}

export const knownRuleIds = (): string[] => {
  try { return (JSON.parse(read(RULES) || '[]') as { id?: unknown }[]).map(r => String(r.id)) } catch { return [] }
}

export function readProposals(): LearnReport | null {
  try { return JSON.parse(read(PROPOSALS)) as LearnReport } catch { return null }
}

export function cmdLearn(args: Args): void {
  if (!exists(SDLC)) fail('sdlc not initialised here')
  if (args.pos[0] === 'show') {
    const stored = readProposals()
    return out(stored ? formatReport(stored) : 'no proposals yet: run learn')
  }
  const given = optString(args, 'min-changes')
  const min = given === undefined ? LEARN.minChanges : Number(given)
  if (!Number.isInteger(min) || min < 1) fail('usage: learn [--min-changes <n>] | learn show')
  const report = diagnose(loadEvidence(), knownRuleIds(), min)
  ensureGitignore()
  fs.mkdirSync(path.dirname(PROPOSALS), { recursive: true })
  fs.writeFileSync(PROPOSALS, JSON.stringify(report, null, 2) + '\n')
  out(formatReport(report))
}
