// rig learn, the I/O half: load the evidence and the diff corpus of shipped changes, write proposals.json.
import fs from 'node:fs'
import path from 'node:path'
import { CHANGES, SDLC, ROOT, WAIVERS, sha, read, exists, listChanges, isShipped, readJsonl, git, toPosix, out, fail, optString, ensureGitignore, sanctionWrites, type Args, type Waiver } from './core.ts'
import { parseUnifiedDiff, parseRules, type FileDiff } from './model.ts'
import { readEvents, parseReviewFindings, type ReviewFinding } from './ratchet.ts'
import { diagnose, formatReport, LEARN, type ChangeEvidence, type LearnReport } from './learn.ts'

export const RULES = path.join(SDLC, 'rules.json')
export const PROPOSALS = path.join(SDLC, 'learn', 'proposals.json')
const AUTO = path.join(SDLC, 'learn', 'auto.json')

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

// review.md is written after the ship commit in the CI-reviewed tiers, so the reviewer's own per-slice and PR files (committed with the change) count too.
function reviewFindings(slug: string): ReviewFinding[] {
  const dir = path.join(CHANGES, slug)
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { /* no change folder: no findings */ }
  const files = ['review.md', ...names.filter(n => /^review-slice-[\w-]+\.md$/.test(n)).sort(), 'review-pr.md']
  const seen = new Set<string>()
  return files.flatMap(f => parseReviewFindings(read(path.join(dir, f)))).filter(f => {
    const key = `${f.category}\0${f.text}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
}

function loadChange(slug: string, waivers: Waiver[]): ChangeEvidence {
  const diffs = rebuildDiff(slug)
  const events = (() => { try { return readEvents(slug) } catch { return [] } })()
  return {
    slug,
    findings: reviewFindings(slug),
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

// What learn reads: the shipped changes, the waivers and the rules already promoted. If none moved, a rerun would print the same report.
const evidenceKey = (): string => sha([...listChanges().filter(isShipped).sort(), read(WAIVERS), read(RULES)].join('\0'))

// --auto is for the mod: silent when nothing new was shipped since the last run, one line when there is something to look at.
function autoLearn(): void {
  const key = evidenceKey()
  try { if ((JSON.parse(read(AUTO)) as { key?: unknown }).key === key) return } catch { /* first run, or a garbled marker: run */ }
  const report = diagnose(loadEvidence(), knownRuleIds())
  ensureGitignore()
  fs.mkdirSync(path.dirname(PROPOSALS), { recursive: true })
  fs.writeFileSync(PROPOSALS, JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(AUTO, JSON.stringify({ key }) + '\n')
  const ready = report.proposals.filter(p => p.kind === 'rule-add' && p.replay.status === 'pass').map(p => p.id)
  if (report.proposals.length) out(`learn: ${report.proposals.length} proposal(s), ${ready.length ? `promotable: ${ready.join(', ')}. Review them with /rig:learn, then /rig-approve <id> learn` : 'none promotable yet'}`)
}

export function cmdLearn(args: Args): void {
  if (!exists(SDLC)) fail('sdlc not initialised here')
  if (args.opt.auto) return autoLearn()
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

// Promotion re-derives the proposal from today's evidence: the stored file only names the id, so editing it changes nothing.
export function approveLearn(id: string): void {
  const stored = readProposals()?.proposals.find(p => p.id === id)
  if (!stored) fail(`no proposal ${id}: run learn first`)
  if (stored.kind !== 'rule-add') fail(`${id} is advisory (${stored.kind}): edit .sdlc/sensors.json by hand if the evidence convinces you`)
  const fresh = diagnose(loadEvidence(), knownRuleIds(), LEARN.minChanges).proposals.find(p => p.id === id)
  if (!fresh || fresh.kind !== 'rule-add') fail(`not promoting ${id}: it no longer recurs, or the rule already exists`)
  if (fresh.replay.status !== 'pass') fail(`not promoting ${id}: replay is ${fresh.replay.status}${fresh.replay.reason ? ` (${fresh.replay.reason})` : ''}`)
  const current = parseRules(read(RULES))
  if (current.errors.length) fail(`.sdlc/rules.json has errors, fix them first: ${current.errors.join('; ')}`)
  fs.writeFileSync(RULES, JSON.stringify([...current.rules, fresh.edit], null, 2) + '\n')
  sanctionWrites(['.sdlc/rules.json'])
  out(`promoted ${id} into .sdlc/rules.json as a warn rule (pattern ${fresh.edit.pattern}). Review it, then commit it through PR review.`)
}
