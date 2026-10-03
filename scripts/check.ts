// Orchestrates sensors at a firing point (stop, ship, ci): one set of checks everywhere, so local == CI.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, WAIVERS, exists, read, out, fail, git, gitIn, approvalOf, readImpact, optString, readJsonl, activeSlug, defaultBase,
  type Args, type Waiver, type ImpactHit,
} from './core.ts'
import { parseConfig, parseRules, formatFindings, matchesAny, type FileDiff, type Finding, type Rule, type SensorConfig } from './model.ts'
import { testTamper, suppressions, layering, size, secretsInDiff, rulesSensor, retiredIdentifiers, contractsFromPlan, harnessTamper } from './sensors.ts'
import { readBaseline, snapshot, turnDiff, fileDiff, branchDiff, showAt, fileLines } from './diffs.ts'
import { runCommand, recordRun } from './runs.ts'

export type Point = 'stop' | 'ship' | 'ci'
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

function applyWaivers(findings: Finding[], slugs: string[]): CheckResult {
  const waivers = readJsonl<Waiver>(WAIVERS).filter(w => slugs.includes(w.slug))
  const waived = (f: Finding): boolean => waivers.some(w => w.sensor === f.sensor && (w.file === '*' || w.file === f.file))
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
      fix: approvedIds.has(h.id) ? `update ${h.consumer} as part of this change (it is in the approved impact)` : 'cross-repo contract change: this needs a gated change: run /sdlc:start, then plan it with ## Contracts so the person approves the impact',
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
  const slug = optString(args, 'slug') ?? activeSlug()
  if (!slug) fail('check --at plan needs an active change or --slug')
  const { config } = loadConfig()
  const ids = contractsFromPlan(read(path.join(CHANGES, slug, 'plan.md')))
  const found = consumerHits(ids, config)
  const hits = found.hits
  const missing = ids.length ? found.missing : []
  fs.writeFileSync(path.join(CHANGES, slug, 'impact.json'), JSON.stringify({ at: new Date().toISOString(), ids, hits, missing }, null, 2) + '\n')
  if (!hits.length && !missing.length) return out(`impact: ${ids.length} contract identifier(s), no consumer references`)
  const tier = setTierL(slug) ? '' : `\nwarning: no "tier:" line found in ${slug}/intent.md, so the tier was not raised to L; set it by hand.`
  const rows = hits.slice(0, 20).map(h => `  ${h.consumer}: ${h.file}:${h.line} uses ${h.id}`)
  const unverified = missing.length ? [`Not checked out, so the impact cannot be verified until they are: ${missing.join(', ')}`] : []
  out([`impact: ${hits.length} consumer reference${hits.length === 1 ? '' : 's'} across ${new Set(hits.map(h => h.consumer)).size} repo(s). The change is now tier L and needs /sdlc-approve ${slug} impact.${tier}`, ...rows, ...unverified, 'Add the consumer files to plan ## Files (as ../<repo>/... globs) and each consumer test to ## Verification.'].join('\n'))
}

export function runChecks(i: CheckInput): CheckResult {
  const { diffs, config } = i
  const findings: Finding[] = [
    ...testTamper(diffs, config),
    ...suppressions(diffs, config),
    ...layering(diffs, config),
    ...size(diffs, config, fileLines(diffs.filter(d => d.status !== 'D').map(d => d.file)), i.point),
    ...secretsInDiff(diffs),
    ...rulesSensor(diffs, i.rules),
    ...contractFindings(i),
    ...harnessTamper(diffs, { point: i.point, toolEdited: i.toolEdited, before: i.before, after: f => read(path.join(ROOT, f)) }),
  ]
  if (i.commands !== 'none') findings.push(...runDeclared(i.commands, config, i.point === 'ci' ? null : i.slugs[0] ?? null, i.budgetMs, Boolean(i.ratchet) && i.point !== 'ci'))
  return applyWaivers(findings, i.slugs)
}

// The cheap per-file subset, for PostToolUse and the mod's per-edit notices.
export function editFindings(rel: string): Finding[] {
  const snap = readBaseline()
  if (!snap) return []
  const { config, rules } = loadConfig()
  const diffs = fileDiff(snap, rel)
  const slug = activeSlug()
  return applyWaivers([...testTamper(diffs, config), ...suppressions(diffs, config), ...size(diffs, config, fileLines([rel]), 'edit'), ...secretsInDiff(diffs), ...rulesSensor(diffs, rules)], slug ? [slug] : []).findings
}

const slugsIn = (diffs: FileDiff[]): string[] => [...new Set(diffs.map(d => /^\.sdlc\/changes\/([^/]+)\//.exec(d.file)?.[1]).filter((s): s is string => Boolean(s)))]

function report(point: string, result: CheckResult, count: number, json: boolean): void {
  if (json) return out(JSON.stringify(result))
  const text = formatFindings(result.findings)
  out(text || `sdlc check ${point}: pass (${count} file(s) checked${result.waived ? `, ${result.waived} waived` : ''})`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) fs.appendFileSync(summary, `## sdlc check (${point})\n\n${text ? '```\n' + text + '\n```' : 'pass'}\n`)
}

export function cmdCheck(args: Args): void {
  if (optString(args, 'at') === 'plan') return cmdCheckPlan(args)
  const at = optString(args, 'at')
  if (at !== 'stop' && at !== 'ship' && at !== 'ci') fail('usage: check --at stop|ship|ci|plan [--base <ref>] [--config-from <ref>] [--slug <s>] [--budget-ms <n>] [--json]')
  const { config, rules, errors } = loadConfig(optString(args, 'config-from') ?? null)
  const baseRef = optString(args, 'base')
  const base = baseRef ? git(['merge-base', 'HEAD', baseRef]) : defaultBase()
  if (at === 'ci' && !base) fail('check --at ci needs --base <ref> with a merge-base (fetch with fetch-depth: 0)')
  let diffs: FileDiff[]
  let before: (f: string) => string
  if (at === 'stop') {
    const snap = readBaseline() ?? snapshot()
    if (!snap) return out('sdlc check stop: nothing to compare against (no commits yet)')
    diffs = turnDiff(snap)
    before = f => showAt(snap.sha, f) ?? ''
  } else {
    diffs = branchDiff(base ?? 'HEAD')
    before = f => showAt(base ?? 'HEAD', f) ?? ''
  }
  const slugArg = optString(args, 'slug')
  const slugs = slugArg ? [slugArg] : at === 'ci' ? slugsIn(diffs) : [activeSlug()].filter((s): s is string => Boolean(s))
  const budgetMs = Number(optString(args, 'budget-ms') ?? (at === 'stop' ? 60_000 : 1_800_000))
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) fail('--budget-ms must be a positive number')
  const result = runChecks({ point: at, diffs, config, rules, slugs, commands: at === 'stop' ? 'fast' : 'full', budgetMs, before, base, ratchet: !optString(args, 'config-from') })
  const configFindings: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: SENSORS_JSON, message: e, fix: 'fix the file; see the sdlc README for its format' }))
  const all = { ...result, findings: [...configFindings, ...result.findings], blocks: [...configFindings, ...result.blocks] }
  report(at, all, diffs.length, Boolean(args.opt.json))
  process.exitCode = all.blocks.length ? 1 : 0
}

export function cmdCheckFile(args: Args): void {
  const rel = args.pos[0]
  if (!rel || !exists(SDLC)) fail('usage: check-file <path> [--json]  (in an sdlc repo)')
  const findings = editFindings(rel)
  if (args.opt.json) return out(JSON.stringify(findings))
  out(formatFindings(findings) || `${rel}: ok`)
}
