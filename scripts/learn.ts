// rig learn: pure diagnosis, proposals and the replay gate over evidence read from past shipped changes.
// No fs, git or process access: learncli.ts loads the evidence and writes the result.
import { rulesSensor } from './sensors.ts'
import type { FileDiff, Rule } from './model.ts'

export const LEARN = { minChanges: 10, minClusterChanges: 2 }

export type Finding = { severity: string; category: string; text: string }
export type WaiverRow = { sensor: string; file: string; reason: string }
export type ChangeEvidence = { slug: string; findings: Finding[]; waivers: WaiverRow[]; blockedReasons: string[]; diffs: FileDiff[]; rebuilt: boolean }
export type Replay = { status: 'pass' | 'fail' | 'insufficient-holdout' | 'not-applicable'; firedOn: string[]; falsePositives: string[]; reason?: string }
export type TuneEdit = { sensor: string; files: string; suggestion: string }
type Base = { id: string; evidence: string[]; expectedEffect: string; risk: 'low' | 'medium' | 'high'; replay: Replay }
export type Proposal =
  | (Base & { kind: 'rule-add'; surface: '.sdlc/rules.json'; edit: Rule })
  | (Base & { kind: 'sensor-tune'; surface: '.sdlc/sensors.json'; edit: TuneEdit })
export type LearnReport = { changes: number; rebuilt: number; skipped: string[]; notes: string[]; proposals: Proposal[] }

const TOKEN = /`([^`\n]{2,40})`/g
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
const ruleId = (category: string): string => `learned-${slugify(category) || 'finding'}`
const byId = (a: Proposal, b: Proposal): number => b.evidence.length - a.evidence.length || a.id.localeCompare(b.id)

// A category recurs when one backticked token shows up in its findings in at least minClusterChanges changes.
// Exact-token matching only; the person can edit the pattern before promoting it.
function ruleCandidates(corpus: ChangeEvidence[], known: Set<string>): { category: string; token: string; slugs: string[] }[] {
  const seen = new Map<string, Map<string, Set<string>>>()
  for (const c of corpus) {
    for (const f of c.findings) {
      for (const m of f.text.matchAll(TOKEN)) {
        const token = m[1] ?? ''
        const byToken = seen.get(f.category) ?? new Map<string, Set<string>>()
        const slugs = byToken.get(token) ?? new Set<string>()
        slugs.add(c.slug)
        byToken.set(token, slugs)
        seen.set(f.category, byToken)
      }
    }
  }
  const found: { category: string; token: string; slugs: string[] }[] = []
  for (const [category, byToken] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
    const best = [...byToken].filter(([, s]) => s.size >= LEARN.minClusterChanges).sort(([ta, sa], [tb, sb]) => sb.size - sa.size || ta.localeCompare(tb))[0]
    if (best && !known.has(ruleId(category))) found.push({ category, token: best[0], slugs: [...best[1]].sort() })
  }
  return found
}

// The rule must fire on the stored diff of a change whose findings it came from, and on no shipped change without such a finding.
export function replayRule(rule: Rule, category: string, corpus: ChangeEvidence[], minChanges: number): Replay {
  const usable = corpus.filter(c => c.rebuilt)
  if (usable.length < minChanges) return { status: 'insufficient-holdout', firedOn: [], falsePositives: [], reason: `${usable.length} of ${minChanges} shipped changes have a rebuilt diff` }
  const firedOn = usable.filter(c => rulesSensor(c.diffs, [rule]).length > 0)
  const has = (c: ChangeEvidence): boolean => c.findings.some(f => f.category === category)
  const falsePositives = firedOn.filter(c => !has(c)).map(c => c.slug)
  const names = firedOn.map(c => c.slug)
  if (!firedOn.some(has)) return { status: 'fail', firedOn: names, falsePositives, reason: 'the pattern fires on none of the changes whose findings it came from' }
  if (falsePositives.length) return { status: 'fail', firedOn: names, falsePositives, reason: `it also fires on shipped changes with no ${category} finding` }
  return { status: 'pass', firedOn: names, falsePositives: [] }
}

const globOf = (file: string): string => {
  if (file === '*') return '*'
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  return dir ? `${dir}/**` : '**'
}

function tuneProposals(corpus: ChangeEvidence[]): Proposal[] {
  const groups = new Map<string, { sensor: string; files: string; slugs: Set<string> }>()
  for (const c of corpus) {
    for (const w of c.waivers) {
      const files = globOf(w.file)
      const key = `${w.sensor}|${files}`
      const g = groups.get(key) ?? { sensor: w.sensor, files, slugs: new Set<string>() }
      g.slugs.add(c.slug)
      groups.set(key, g)
    }
  }
  return [...groups.values()]
    .filter(g => g.slugs.size >= LEARN.minClusterChanges)
    .map((g): Proposal => ({
      id: `tune-${slugify(g.sensor)}-${slugify(g.files) || 'all'}`,
      kind: 'sensor-tune',
      surface: '.sdlc/sensors.json',
      edit: { sensor: g.sensor, files: g.files, suggestion: `${g.sensor} was waived in ${g.slugs.size} changes for ${g.files}: check whether it is too strict there, and edit .sdlc/sensors.json by hand if so` },
      evidence: [...g.slugs].sort(),
      expectedEffect: `fewer ${g.sensor} waivers for ${g.files}`,
      risk: 'medium',
      replay: { status: 'not-applicable', firedOn: [], falsePositives: [] },
    }))
}

export function diagnose(input: ChangeEvidence[], knownRuleIds: string[], minChanges = LEARN.minChanges): LearnReport {
  const corpus = [...input].sort((a, b) => a.slug.localeCompare(b.slug))
  const rules = ruleCandidates(corpus, new Set(knownRuleIds)).map(({ category, token, slugs }): Proposal => {
    const rule: Rule = { id: ruleId(category), pattern: escapeRegExp(token), message: `${category}: do not use ${token}`, why: `recurring ${category} review finding in ${slugs.join(', ')}`, action: 'warn' }
    return { id: rule.id, kind: 'rule-add', surface: '.sdlc/rules.json', edit: rule, evidence: slugs, expectedEffect: `stops ${token} coming back as a ${category} review finding`, risk: 'low', replay: replayRule(rule, category, corpus, minChanges) }
  })
  const stalled = corpus.filter(c => c.blockedReasons.some(r => /^(cap|stall):/.test(r))).map(c => c.slug)
  return {
    changes: corpus.length,
    rebuilt: corpus.filter(c => c.rebuilt).length,
    skipped: corpus.filter(c => !c.rebuilt).map(c => c.slug),
    notes: stalled.length >= LEARN.minClusterChanges ? [`${stalled.length} change(s) hit a cap or stall: ${stalled.join(', ')}. Look at their review rounds; no edit is proposed.`] : [],
    proposals: [...rules, ...tuneProposals(corpus)].sort(byId),
  }
}

export function formatReport(r: LearnReport): string {
  const head = `learn: ${r.changes} shipped change(s), ${r.rebuilt} with a rebuilt diff${r.skipped.length ? `; skipped: ${r.skipped.join(', ')}` : ''}`
  const body = r.proposals.map(p => `- ${p.id} [${p.kind}, risk ${p.risk}] replay ${p.replay.status}${p.replay.reason ? ` (${p.replay.reason})` : ''}\n    evidence: ${p.evidence.join(', ')}\n    ${p.expectedEffect}`)
  const tail = r.proposals.some(p => p.replay.status === 'pass') ? 'Promote a passing rule-add with /rig-approve <id> learn.' : r.proposals.length ? 'Nothing is promotable yet.' : 'No proposals.'
  return [head, ...r.notes, ...body, tail].join('\n')
}
