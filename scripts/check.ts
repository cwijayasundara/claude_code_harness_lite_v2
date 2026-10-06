// Orchestrates sensors at a firing point (stop, ship, ci): one set of checks everywhere, so local == CI.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, WAIVERS, planFiles, isPlanned, exists, read, out, fail, git, gitIn, approvalOf, planApproved, planPath, readImpact, needsImpact, toPosix, optString, readJsonl, defaultBase, checkSlug,
  type Args, type Waiver, type ImpactHit,
} from './core.ts'
import { parseConfig, parseRules, formatFindings, warnLines, matchesAny, isTest, isSource, type FileDiff, type Finding, type Rule, type SensorConfig } from './model.ts'
import { withoutFixtures, testTamper, suppressions, layering, size, secretsInDiff, rulesSensor, retiredIdentifiers, contractsFromPlan, harnessTamper, behaviourIds, behaviourText, missingBehaviours, tierFromDiff } from './sensors.ts'
import { readBaseline, snapshot, turnDiff, fileDiff, branchDiff, showAt, fileLines, stagedDiff, showStaged } from './diffs.ts'
import { runCommand, recordRun } from './runs.ts'
import { withBaseTree } from './basetree.ts'
import { loadChange, activeSlug } from './graph.ts'

export type Point = 'stop' | 'commit' | 'ship' | 'ci'
export type CheckInput = {
  point: Point
  diffs: FileDiff[]
  config: SensorConfig
  rules: Rule[]
  slugs: string[]
  commands: 'fast' | 'full' | 'none'
  budgetMs: number
  before: (file: string) => string
  toolEdited?: Set<string>
  base: string | null
  ratchet?: boolean
  after?: (file: string) => string // the text being judged; defaults to the working tree (commit passes the index)
}
export type CheckResult = { findings: Finding[]; blocks: Finding[]; warns: Finding[]; waived: number }

const SENSORS_JSON = '.sdlc/sensors.json'
const TAIL_IN_FINDING = 15

// With a ref (CI), config comes from the base branch, so a PR cannot loosen the rules it is judged by.
export function loadConfig(ref: string | null = null): { config: SensorConfig; rules: Rule[]; errors: string[] } {
  if (ref && git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null) return { config: parseConfig('').config, rules: [], errors: [`config ref ${ref} does not exist`] }
  const text = (rel: string): string => (ref ? git(['show', `${ref}:${rel}`]) ?? '' : read(path.join(ROOT, rel)))
  const c = parseConfig(text(SENSORS_JSON))
  const r = parseRules(text('.sdlc/rules.json'))
  return { config: c.config, rules: r.rules, errors: [...c.errors, ...r.errors.map(e => `rules.json: ${e}`)] }
}

// Once a known-red command passes, it blocks from then on: the only automatic edit to sensors.json, and it only tightens.
function ratchet(cleared: string[]): void {
  const file = path.join(ROOT, SENSORS_JSON)
  if (!exists(file)) return
  let raw: { knownRed?: string[] }
  try { raw = JSON.parse(read(file)) as { knownRed?: string[] } } catch { return }
  raw.knownRed = (raw.knownRed ?? []).filter(k => !cleared.includes(k))
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
}

export function runDeclared(prefix: 'fast' | 'full', config: SensorConfig, slug: string | null, budgetMs: number, allowRatchet = false): Finding[] {
  const findings: Finding[] = []
  const cleared: string[] = []
  let left = budgetMs
  for (const [name, cmd] of Object.entries(config[prefix])) {
    const key = `${prefix}.${name}`
    const known = config.knownRed.includes(key)
    if (left <= 0) {
      findings.push({ sensor: 'commands', severity: 'block', message: `${key} not run: the ${Math.round(budgetMs / 1000)} s budget ran out`, fix: `make the ${prefix} commands in .sdlc/sensors.json faster` })
      continue
    }
    const row = runCommand(cmd, { timeoutMs: left })
    left -= row.ms
    if (slug) recordRun(slug, { ...row, source: prefix === 'fast' ? 'gate' : 'ship' })
    if (row.exit === 0) {
      if (known) cleared.push(key)
      continue
    }
    const tail = row.tail.split('\n').slice(-TAIL_IN_FINDING).map(t => '      ' + t).join('\n')
    findings.push({
      sensor: 'commands',
      severity: known && !row.timedOut ? 'warn' : 'block',
      message: `${key} failed (exit ${row.exit}${row.timedOut ? ', timed out' : ''}): ${cmd}\n${tail}`,
      fix: known && !row.timedOut ? 'known red before this change: fix it when you can' : `run \`${cmd}\` and fix what it reports`,
    })
  }
  if (cleared.length && allowRatchet) ratchet(cleared)
  return findings
}

// A "fire" is one rule matching in one check run (deduplicated by rule id); only stop and ship runs count, never ci.
function logRuleFires(findings: Finding[], point: Point): void {
  if (point === 'ci' || !exists(SDLC)) return
  const ids = [...new Set(findings.filter(f => f.sensor === 'rules').map(f => f.labels?.[0]))]
  const rows = ids.map(rule => JSON.stringify({ at: new Date().toISOString(), kind: 'event', event: 'rule-fired', rule }))
  try {
    if (rows.length) fs.appendFileSync(path.join(SDLC, 'usage.jsonl'), rows.join('\n') + '\n')
  } catch {
    // telemetry must never fail a check
  }
}

// At CI only a change the PR adds (its folder is absent in the base) can waive, and only inside its plan's files or its own folder:
// an older change's wildcard waiver must not cover what a later PR does.
function ciScope(slug: string, base: string | null | undefined): ((file: string | undefined) => boolean) | null {
  if (!base || showAt(base, `.sdlc/changes/${slug}/intent.md`) !== null) return null
  const patterns = exists(planPath(slug)) ? planFiles(slug) : []
  const folder = `.sdlc/changes/${slug}/`
  return file => Boolean(file) && (String(file).startsWith(folder) || patterns.some(p => isPlanned(String(file), [p]) && !String(file).startsWith('.sdlc/')))
}

// The PR supplies its own waivers.jsonl rows, so at CI a harness-tamper finding is never waivable: harness changes land on the trunk first.
function applyWaivers(findings: Finding[], slugs: string[], ci?: { base: string | null | undefined }): CheckResult {
  const scopes = new Map(slugs.map(s => [s, ci ? ciScope(s, ci.base) : () => true] as const))
  const waivers = readJsonl<Waiver>(WAIVERS).filter(w => slugs.includes(w.slug) && scopes.get(w.slug) !== null)
  const waived = (f: Finding): boolean => waivers.some(w => w.sensor === f.sensor && (w.file === '*' || w.file === f.file) && !(ci && f.sensor === 'harness-tamper') && (scopes.get(w.slug) as (file: string | undefined) => boolean)(f.file))
  const kept = findings.filter(f => !waived(f))
  return { findings: kept, blocks: kept.filter(f => f.severity === 'block'), warns: kept.filter(f => f.severity === 'warn'), waived: findings.length - kept.length }
}

const escapeRe = (id: string): string => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One git grep per consumer (untracked files count); a directory that is not a work tree cannot be verified.
export function consumerHits(ids: string[], cfg: SensorConfig): { hits: ImpactHit[]; missing: string[] } {
  const hits: ImpactHit[] = []
  const missing: string[] = []
  for (const c of cfg.consumers) {
    const dir = path.resolve(ROOT, c.path)
    if (!exists(dir) || gitIn(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      missing.push(c.name)
      continue
    }
    if (!ids.length) continue
    const rows = (gitIn(dir, ['grep', '--untracked', '-n', '-w', '-F', ...ids.flatMap(id => ['-e', id])]) ?? '').split('\n').filter(Boolean)
    for (const row of rows) {
      const m = /^(.*?):(\d+):(.*)$/.exec(row)
      if (!m) continue
      for (const id of ids) if (new RegExp(`\\b${escapeRe(id)}\\b`).test(m[3] ?? '')) hits.push({ consumer: c.name, file: m[1] ?? '', line: Number(m[2]), id })
    }
  }
  return { hits, missing }
}

// The current contract: contract files outside migration directories, whose history never stops naming old columns.
const MIGRATIONS = /(^|\/)migrations?\//

function producerContractText(cfg: SensorConfig): string {
  const files = (git(['ls-files']) ?? '').split('\n').filter(f => matchesAny(f, cfg.contracts) && !MIGRATIONS.test(f))
  return files.map(f => read(path.join(ROOT, f))).join('\n')
}

export function contractFindings(i: CheckInput): Finding[] {
  if (!i.config.consumers.length || !i.diffs.some(d => matchesAny(d.file, i.config.contracts))) return []
  const ids = retiredIdentifiers(i.diffs, i.config, producerContractText(i.config))
  if (!ids.length) return []
  const { hits, missing } = consumerHits(ids, i.config)
  const approvedIds = new Set(i.slugs.filter(s => approvalOf(s, 'impact') === 'approved').flatMap(s => readImpact(s)?.ids ?? []))
  const atStop = i.point === 'stop'
  return [
    ...hits.map((h): Finding => ({
      sensor: 'contract-impact',
      severity: atStop && approvedIds.has(h.id) ? 'warn' : 'block',
      message: `${h.consumer}: ${h.file}:${h.line} still uses ${h.id}`,
      fix: approvedIds.has(h.id) ? `update ${h.consumer} as part of this change (it is in the approved impact)` : 'cross-repo contract change: this needs a gated change: run /rig:start, then plan it with ## Contracts so the person approves the impact',
    })),
    ...missing.map((name): Finding => ({
      sensor: 'contract-impact',
      severity: atStop ? 'warn' : 'block',
      message: `consumer ${name} is not checked out, so ${ids.length} retired identifier(s) cannot be verified`,
      fix: `check out ${name} at its declared path as a git repo (CI: set the SDLC_CONSUMERS_TOKEN secret)`,
    })),
  ]
}

function setTierL(slug: string): boolean {
  const file = path.join(CHANGES, slug, 'intent.md')
  const text = read(file)
  const next = text.replace(/^tier:\s*["']?[SM]["']?\s*$/m, 'tier: L')
  if (next === text) return /^tier:\s*["']?L["']?\s*$/m.test(text)
  fs.writeFileSync(file, next)
  return true
}

export function cmdCheckPlan(args: Args): void {
  const given = optString(args, 'slug')
  const slug = given ? checkSlug(given) : activeSlug()
  if (!slug) fail('check --at plan needs an active change or --slug')
  const { config } = loadConfig()
  const ids = contractsFromPlan(read(planPath(slug)))
  const found = consumerHits(ids, config)
  const hits = found.hits
  const missing = ids.length ? found.missing : []
  fs.writeFileSync(path.join(CHANGES, slug, 'impact.json'), JSON.stringify({ at: new Date().toISOString(), ids, hits, missing }, null, 2) + '\n')
  if (!hits.length && !missing.length) return out(`impact: ${ids.length} contract identifier(s), no consumer references`)
  const tier = setTierL(slug) ? '' : `\nwarning: no "tier:" line found in ${slug}/intent.md, so the tier was not raised to L; set it by hand.`
  const rows = hits.slice(0, 20).map(h => `  ${h.consumer}: ${h.file}:${h.line} uses ${h.id}`)
  const unverified = missing.length ? [`Not checked out, so the impact cannot be verified until they are: ${missing.join(', ')}`] : []
  out([`impact: ${hits.length} consumer reference${hits.length === 1 ? '' : 's'} across ${new Set(hits.map(h => h.consumer)).size} repo(s). The change is now tier L and needs /rig-approve ${slug} impact.${tier}`, ...rows, ...unverified, 'Add the consumer files to plan ## Files (as ../<repo>/... globs) and each consumer test to ## Verification.'].join('\n'))
}

// Only the tests this branch adds or changes can show a behaviour is covered: an old test naming B1 proves nothing new.
function testCorpus(config: SensorConfig, diffs: FileDiff[]): string {
  return diffs.filter(d => d.status !== 'D' && !d.binary && isTest(d.file, config)).map(d => read(path.join(ROOT, d.file))).join('\n')
}

// Proof against the base, recomputed (no log entry can fake it): the branch's changed tests run on top of the base code.
// 'red' (feature, bugfix, incident, greenfield): they must FAIL there, so they prove the change.
// 'green' (refactor): they must PASS there, so they pin the old behaviour the refactor preserves.
function proofOnBase(slug: string, config: SensorConfig, diffs: FileDiff[], base: string, mode: 'red' | 'green', budgetMs: number): Finding[] {
  const block = (message: string, fix: string): Finding[] => [{ sensor: 'red-proof', severity: 'block', message, fix }]
  const cmd = config.full.test ?? config.fast.test
  const tests = diffs.filter(d => d.status !== 'D' && !d.binary && isTest(d.file, config)).map(d => d.file)
  // Support files (fixtures, testdata) travel with the tests, or a test that needs them would fail on the base for the wrong reason.
  const overlay = diffs.filter(d => d.status !== 'D' && !d.binary && (isTest(d.file, config) || matchesAny(d.file, config.testSupport))).map(d => d.file)
  const t0 = Date.now()
  const left = (): number => Math.max(1000, budgetMs - (Date.now() - t0))
  if (!tests.length) return mode === 'red' ? block('no test file changed, so nothing proves this change', 'write the failing test first') : []
  if (!cmd) return block('no test command declared (full.test or fast.test in .sdlc/sensors.json)', 'declare it so red can be proven')
  const tree = withBaseTree(base, tmp => {
    const sanity = runCommand(cmd, { cwd: tmp, timeoutMs: left() })
    recordRun(slug, { ...sanity, source: 'ship' })
    if (sanity.exit !== 0 || sanity.timedOut) return block("can't establish red: the tests fail on the base even without the new tests", 'make the test command pass from a clean checkout of the base (dependencies, fixtures), or the person waives red-proof')
    for (const t of overlay) {
      fs.mkdirSync(path.dirname(path.join(tmp, t)), { recursive: true })
      fs.copyFileSync(path.join(ROOT, t), path.join(tmp, t))
    }
    const run = runCommand(cmd, { cwd: tmp, timeoutMs: left() })
    if (run.timedOut) return block('proof timed out: the tests did not finish on the base within the budget', 'make the test command faster, or the person waives red-proof')
    recordRun(slug, mode === 'red' ? { ...run, expectFail: true, source: 'ship' } : { ...run, source: 'ship' })
    if (mode === 'red' && run.exit === 0) return block('the new tests already pass on the base: they prove nothing about this change', 'write a test that fails without the change, then make it pass')
    if (mode === 'green' && run.exit !== 0) return block("the refactor's tests fail on the base: they do not describe the behaviour being preserved", 'write characterization tests that pass on the old code first, then refactor under them')
    return []
  }, { prefix: 'rig-red-' })
  return tree.ok ? tree.value : block(tree.error, 'run `git worktree prune` and retry, check permissions for symlinks, or the person waives red-proof')
}

export function shipVerdicts(slug: string, config: SensorConfig, diffs: FileDiff[], base: string | null, budgetMs = 1_800_000): Finding[] {
  if (!exists(path.join(CHANGES, slug))) return [{ sensor: 'traceability', severity: 'block', message: `unknown change ${slug}`, fix: 'pass a slug that exists under .sdlc/changes/' }]
  const change = loadChange(slug)
  const findings: Finding[] = []
  const hasPlan = exists(planPath(slug))
  // An ad-hoc change is tiered on its first Stop; vibe coding keeps growing it, so re-tier it from the branch diff.
  const RANK = { S: 0, M: 1, L: 2 } as const
  const fromDiff = tierFromDiff(diffs, config)
  const tier = slug.startsWith('adhoc-') && RANK[fromDiff] > RANK[change.tier] ? fromDiff : change.tier
  if (slug.startsWith('adhoc-') && tier !== 'S' && !hasPlan) {
    findings.push({ sensor: 'adhoc', severity: 'block', message: `ad-hoc change is now tier ${tier} with no plan`, fix: `run /rig:start ${slug} to adopt it: it writes the plan and applies the tier's gates; the code stays` })
  }
  const spec = read(path.join(change.dir, 'spec.md'))
  const plan = read(planPath(slug))
  let [source, heading] = [spec, 'Behaviours']
  let ids = behaviourIds(spec, heading)
  if (!ids.length) { [source, heading] = [plan, 'Slices']; ids = behaviourIds(plan, heading) }
  const corpus = ids.length ? testCorpus(config, diffs) : ''
  for (const id of missingBehaviours(ids, corpus)) {
    const what = behaviourText(source, heading, id)
    findings.push({ sensor: 'traceability', severity: 'block', message: `${id}${what ? ` (${what})` : ''} has no test that names it`, fix: `add a test whose name or comment says ${id} and proves it` })
  }
  // Per change type: red for new behaviour, green-on-base for refactors, nothing extra for chore and migration
  // (their full suite already runs as the ship gate's commands).
  const always = change.type === 'bugfix' || change.type === 'incident'
  const mode = ['feature', 'bugfix', 'incident', 'greenfield'].includes(change.type) && (tier !== 'S' || always) ? 'red' : change.type === 'refactor' && tier !== 'S' ? 'green' : null
  if (mode && !base) findings.push({ sensor: 'red-proof', severity: 'warn', message: 'no base branch found; proof against the base skipped', fix: 'pass --base <branch>' })
  else if (mode && base) findings.push(...proofOnBase(slug, config, diffs, base, mode, budgetMs))
  return findings
}

// Spec 6.2 in CI: a PR with source changes and no committed change folder is an ad-hoc change; at M or L it needs a plan.
function unrecorded(diffs: FileDiff[], config: SensorConfig): Finding[] {
  const tier = tierFromDiff(diffs, config)
  if (tier === 'S') return []
  return [{ sensor: 'adhoc', severity: 'block', message: `no sdlc change record for a tier ${tier} diff (${diffs.filter(d => isSource(d.file, config)).length} source file(s))`, fix: 'commit the change folder with the PR (git add .sdlc), or run /rig:start to adopt the work: it writes the plan and applies the tier\'s gates' }]
}

// Tier S and M skip the human gates, so a diff that reaches contracts or risky paths must be tier L.
const RISKY = ['**/auth/**', '**/auth.*', '**/security/**', '**/payments/**', '**/billing/**', '**/migrations/**']
function tierFindings(slugs: string[], diffs: FileDiff[], config: SensorConfig): Finding[] {
  const low = slugs.filter(s => loadChange(s).tier !== 'L')
  const hits = diffs.filter(d => matchesAny(d.file, [...config.contracts, ...RISKY]))
  return low.flatMap(slug => hits.map(d => ({
    sensor: 'tier', severity: 'block' as const, file: d.file,
    message: `${slug} is tier ${loadChange(slug).tier} but changes a contract or risky path`,
    fix: `set tier: L in ${slug}/intent.md (spec and plan gates), or the person waives with /rig-waive tier <file> <reason>`,
  })))
}

export function runChecks(i: CheckInput): CheckResult {
  const { diffs, config } = i
  // A commit judges a partial diff, like Stop: same severities, same sensors. Only its text source differs.
  const point = i.point === 'commit' ? 'stop' : i.point
  const after = i.after ?? ((f: string) => read(path.join(ROOT, f)))
  const pattern = withoutFixtures(diffs, config)
  const findings: Finding[] = [
    ...testTamper(pattern, config),
    ...suppressions(pattern, config),
    ...layering(pattern, config),
    ...size(diffs, config, fileLines(diffs.filter(d => d.status !== 'D').map(d => d.file), after), point),
    ...secretsInDiff(pattern),
    ...rulesSensor(pattern, i.rules),
    ...contractFindings({ ...i, point }),
    ...harnessTamper(diffs, { point, toolEdited: i.toolEdited, before: i.before, after }),
  ]
  // A diff whose plan the person approved is big by design: the diff-size limit warns instead of blocking.
  if (i.slugs.length && i.slugs.every(planApproved)) {
    for (const f of findings) if (f.sensor === 'size' && !f.file) f.severity = 'warn'
  }
  if (point !== 'stop') for (const slug of i.slugs) findings.push(...shipVerdicts(slug, config, diffs, i.base, i.budgetMs))
  if (i.point === 'ci' && !i.slugs.length) findings.push(...unrecorded(diffs, config))
  if (point !== 'stop') findings.push(...tierFindings(i.slugs, diffs, config))
  if (i.commands !== 'none') findings.push(...runDeclared(i.commands, config, i.point === 'ci' ? null : i.slugs[0] ?? null, i.budgetMs, Boolean(i.ratchet) && i.point !== 'ci'))
  const result = applyWaivers(findings, i.slugs, i.point === 'ci' ? { base: i.base } : undefined)
  logRuleFires(result.findings, i.point)
  return result
}

// The cheap per-file subset, for PostToolUse and the mod's per-edit notices.
export function editFindings(rel: string): Finding[] {
  const snap = readBaseline()
  if (!snap) return []
  const { config, rules } = loadConfig()
  const diffs = fileDiff(snap, rel)
  const pattern = withoutFixtures(diffs, config)
  const slug = activeSlug()
  return applyWaivers([...testTamper(pattern, config), ...suppressions(pattern, config), ...size(diffs, config, fileLines([rel]), 'edit'), ...secretsInDiff(pattern), ...rulesSensor(pattern, rules)], slug ? [slug] : []).findings
}

const slugsIn = (diffs: FileDiff[]): string[] => [...new Set(diffs.map(d => /^\.sdlc\/changes\/([^/]+)\//.exec(d.file)?.[1]).filter((s): s is string => Boolean(s)))]

// Waivers and approvals are trusted, not recomputed, so CI shows each row a PR adds for a person to review.
const HUMAN_FILES = [['.sdlc/waivers.jsonl', 'waiver'], ['.sdlc/approvals.jsonl', 'approval']] as const
// PR-controlled text: one line, no backticks or angle brackets (it cannot close the summary fence or start a
// `::` workflow command, since every row is printed after "  - "), and capped.
const clean = (v: unknown): string => String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/`/g, "'").replace(/[<>]/g, '_').replace(/"/g, "'").slice(0, 200)
export function humanRowsAdded(base: string): string[] {
  const rows: string[] = []
  for (const [rel, kind] of HUMAN_FILES) {
    const before = new Set((showAt(base, rel) ?? '').replace(/\r\n/g, '\n').split('\n').filter(Boolean))
    for (const line of read(path.join(ROOT, rel)).split('\n').filter(l => l && !before.has(l))) {
      let r: Record<string, unknown> = {}
      try { r = JSON.parse(line) as Record<string, unknown> } catch { /* shown raw below */ }
      const s = (k: string): string => clean(r[k] ?? '?')
      rows.push(!Object.keys(r).length ? `${kind} (unparseable): ${clean(line)}` : kind === 'waiver' ? `waiver ${s('slug')}: ${s('sensor')} ${s('file')} "${s('reason')}" by ${s('by')}` : `approval ${s('slug')} ${s('stage')} by ${s('by')}`)
    }
  }
  return rows
}

// A PR file cannot prove who wrote an approval row (the model commits as the developer): CI asks GitHub for an approving review of the head commit by someone other than the author.
export function independentApproval(): string | null {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return 'cannot verify a reviewer outside a GitHub pull_request run'
  let pr: { number?: number; user?: { login?: string }; head?: { sha?: string } } = {}, repo = ''
  try { const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as { pull_request?: typeof pr; repository?: { full_name?: string } }; pr = ev.pull_request ?? {}; repo = ev.repository?.full_name ?? '' } catch { return 'the pull_request event payload is unreadable' }
  if (!pr.number || !repo || !pr.head?.sha) return 'the pull_request event has no number, repository or head commit'
  let reviews: { user?: { login?: string }; state?: string; commit_id?: string; author_association?: string }[]
  try { reviews = (JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr.number}/reviews?per_page=100`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })) as unknown[]).flat() as typeof reviews } catch { return 'could not read the PR reviews (the job needs pull-requests: read and GH_TOKEN)' }
  // a pull_request checkout is a merge commit (head is its 2nd parent); a workflow re-run reuses an old event
  if (![git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD^2'])].includes(pr.head.sha)) return `the event's head ${pr.head.sha.slice(0, 7)} is not the checked-out commit (a re-run on a stale event?)`
  const latest = new Map<string, (typeof reviews)[number]>()
  for (const r of reviews) if (r.user?.login && r.state !== 'COMMENTED') latest.set(r.user.login, r)
  const ok = [...latest].some(([login, r]) => login !== pr.user?.login && r.state === 'APPROVED' && r.commit_id === pr.head?.sha && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(r.author_association ?? ''))
  return ok ? null : `no approving review of ${pr.head.sha.slice(0, 7)} from someone other than ${pr.user?.login ?? 'the author'}`
}

function report(point: string, result: CheckResult, count: number, json: boolean, humanRows: string[] = []): void {
  if (json) return out(JSON.stringify({ ...result, humanRows }))
  const text = [formatFindings(result.findings), ...(point === 'commit' ? warnLines(result.findings) : [])].filter(Boolean).join('\n')
  const human = humanRows.length ? `needs human review: ${humanRows.length} waiver/approval row(s) added by this PR\n${humanRows.map(r => `  - ${r}`).join('\n')}` : ''
  out([text || `sdlc check ${point}: pass (${count} file(s) checked${result.waived ? `, ${result.waived} waived` : ''})`, human].filter(Boolean).join('\n'))
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) fs.appendFileSync(summary, `## sdlc check (${point})\n\n${text ? '```\n' + text + '\n```' : 'pass'}\n${human ? '\n```\n' + human + '\n```\n' : ''}`)
}

export function cmdCheck(args: Args): void {
  if (optString(args, 'at') === 'plan') return cmdCheckPlan(args)
  const at = optString(args, 'at')
  if (at !== 'stop' && at !== 'commit' && at !== 'ship' && at !== 'ci') fail('usage: check --at stop|commit|ship|ci|plan [--base <ref>] [--config-from <ref>] [--slug <s>] [--budget-ms <n>] [--json]')
  const { config, rules, errors } = loadConfig(optString(args, 'config-from') ?? null)
  const baseRef = optString(args, 'base')
  const base = baseRef ? git(['merge-base', 'HEAD', baseRef]) : defaultBase()
  if (at === 'ci' && !base) fail('check --at ci needs --base <ref> with a merge-base (fetch with fetch-depth: 0)')
  const partial = at === 'stop' || at === 'commit'
  let diffs: FileDiff[]
  let before: (f: string) => string
  let after: ((f: string) => string) | undefined
  let replaying = false
  if (at === 'commit') {
    diffs = stagedDiff()
    if (!diffs.length) return out('sdlc check commit: nothing staged')
    // A merge or rebase replays commits: the sensors still judge them, but the fast commands are left to CI.
    // Read from git state only (an environment variable is the model's to set).
    const marker = (p: string): boolean => { const f = git(['rev-parse', '--git-path', p]); return f !== null && exists(path.resolve(ROOT, f)) }
    replaying = marker('rebase-merge/head-name') || marker('rebase-apply/rebasing') || git(['rev-parse', '-q', '--verify', 'MERGE_HEAD^{commit}']) !== null
    if (replaying) out('sdlc check commit: merge/rebase in progress, fast commands skipped; CI judges the result')
    before = f => showAt('HEAD', f) ?? ''
    after = f => showStaged(f) ?? ''
    if (git(['diff', '--name-only'])) process.stderr.write('rig: the fast commands run against your working tree, which has unstaged changes\n')
  } else if (at === 'stop') {
    const snap = readBaseline() ?? snapshot()
    if (!snap) return out('sdlc check stop: nothing to compare against (no commits yet)')
    diffs = turnDiff(snap)
    before = f => showAt(snap.sha, f) ?? ''
  } else {
    diffs = branchDiff(base ?? 'HEAD')
    before = f => showAt(base ?? 'HEAD', f) ?? ''
  }
  const slugArg = optString(args, 'slug')
  if (slugArg) checkSlug(slugArg)
  const slugs = slugArg ? [slugArg] : at === 'ci' ? slugsIn(diffs) : [activeSlug()].filter((s): s is string => Boolean(s))
  const budgetMs = Number(optString(args, 'budget-ms') ?? (partial ? 60_000 : 1_800_000))
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) fail('--budget-ms must be a positive number')
  const humanRows = at === 'ci' && base ? humanRowsAdded(base) : []
  const why = humanRows.length ? independentApproval() : null // before runChecks: the PR's test commands could rewrite the event file or shadow gh
  const result = runChecks({ point: at, diffs, config, rules, slugs, commands: replaying ? 'none' : partial ? 'fast' : 'full', budgetMs, before, after, base, ratchet: !optString(args, 'config-from') && at !== 'commit' })
  const configFindings: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: SENSORS_JSON, message: e, fix: 'fix the file; see the sdlc README for its format' }))
  const humanFindings: Finding[] = why ? [{ sensor: 'human-approval', severity: 'block', message: `this PR adds ${humanRows.length} approval/waiver row(s): ${why}`, fix: 'a code owner other than the PR author reviews the rows below and approves the current head commit; pushing again needs a fresh approval' }] : []
  const all = { ...result, findings: [...humanFindings, ...configFindings, ...result.findings], blocks: [...humanFindings, ...configFindings, ...result.blocks] }
  report(at, all, diffs.length, Boolean(args.opt.json), humanRows)
  process.exitCode = all.blocks.length ? 1 : 0
}

export function cmdCheckFile(args: Args): void {
  const arg = args.pos[0]
  if (!arg || !exists(SDLC)) fail('usage: check-file <path> [--json]  (in an sdlc repo)')
  const rel = toPosix(path.relative(ROOT, path.resolve(ROOT, arg)))
  const findings = editFindings(rel)
  if (args.opt.json) return out(JSON.stringify(findings))
  out(formatFindings(findings) || `${rel}: ok`)
}

// A declared consumer is recognised at any depth (../../org/checkout), whether declared relative or absolute.
export function consumerFor(rel: string): { name: string } | undefined {
  const norm = (p: string): string => toPosix(path.normalize(path.isAbsolute(p) ? path.relative(ROOT, p) : p)).replace(/\/$/, '')
  return loadConfig().config.consumers.find(c => rel.startsWith(norm(c.path) + '/'))
}

export function cmdImpactStatus(args: Args): void {
  const file = args.pos[0] ?? ''
  const slug = activeSlug()
  const { config } = loadConfig()
  const rel = toPosix(path.relative(ROOT, path.resolve(ROOT, file)))
  const impact = slug ? readImpact(slug) : null
  const touchesContract = Boolean(consumerFor(rel)) || matchesAny(rel, config.contracts)
  const hold = Boolean(slug && needsImpact(impact) && touchesContract && approvalOf(slug, 'impact') !== 'approved')
  out(JSON.stringify({ hold, slug, consumers: [...new Set((impact?.hits ?? []).map(h => h.consumer))], hits: impact?.hits.length ?? 0 }))
}
