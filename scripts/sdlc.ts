#!/usr/bin/env node
// sdlc: the deterministic core of the sdlc plugin. Zero dependencies.
// Runs directly with Node >= 22.18 (built-in TypeScript type stripping) on macOS, Linux and Windows:
//   node --disable-warning=ExperimentalWarning scripts/sdlc.ts <command>
// Everything the model must not judge for itself lives in these scripts: change state, approvals,
// scope drift, sensors, hook decisions and metrics. This file is the CLI.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, APPROVALS, STATE, USAGE, LIMITS, SOFT_HOOK_FAILURE, PATHS, APPROVAL_ARTIFACTS, approvalDigest,
  exists, read, lines, sha, now, toPosix, out, fail, git, gitIn, planFiles, isPlanned, frontmatter, parseArgs, optString, isChangeType, isTier,
  listChanges, activeSlug, loadChange, nextCommand, defaultBase, scopeDrift, scanSecrets, planProblems,
  WAIVERS, readJsonl, type Waiver, ensureGitignore, clearState, planVerification, PLUGIN_ROOT, setActive, createChange, sanctionWrites, type Args, type Approval, type Change, type GatedStage, type Stage, type UsageRow,
} from './core.ts'
import { formatFindings, type Finding, type SensorConfig } from './model.ts'
import { readBaseline, branchDiff, turnDiff, showAt, type Snapshot } from './diffs.ts'
import { cmdHook, readGate } from './hooks.ts'
import { cmdCheck, cmdCheckFile, cmdImpactStatus, loadConfig, runChecks } from './check.ts'
import { runCommand, recordRun, readRuns, renderVerification, runsDigest } from './runs.ts'
import { cmdMetrics } from './metrics.ts'

// ---------- commands ----------

function cmdInit(): void {
  fs.mkdirSync(CHANGES, { recursive: true })
  fs.mkdirSync(path.join(SDLC, 'incidents'), { recursive: true })
  ensureGitignore()
  if (!exists(STATE)) fs.writeFileSync(STATE, '---\nchange:\n---\n# State\n\nNo active change.\n')
  const guides = path.join(SDLC, 'guides')
  if (!exists(guides) && exists(path.join(PLUGIN_ROOT, 'guides'))) {
    fs.cpSync(path.join(PLUGIN_ROOT, 'guides'), guides, { recursive: true })
    sanctionWrites(fs.readdirSync(guides).map(f => `.sdlc/guides/${f}`))
  }
  out(`initialised ${toPosix(path.relative(ROOT, SDLC)) || SDLC}`)
}

function cmdNew(args: Args): void {
  const slug = args.pos[0]
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) fail('usage: new <kebab-slug> --type <type> --tier S|M|L [--title "..."]')
  const type = optString(args, 'type') ?? 'feature'
  const tier = optString(args, 'tier') ?? 'M'
  if (!isChangeType(type)) fail(`unknown type "${type}"; one of ${Object.keys(PATHS).join(', ')}`)
  if (!isTier(tier)) fail('tier must be S, M or L')
  const dir = path.join(CHANGES, slug)
  if (exists(dir)) fail(`change ${slug} already exists`)
  if (!exists(SDLC)) cmdInit()
  createChange(slug, type, tier, optString(args, 'title') ?? slug)
  out(`created ${toPosix(path.relative(ROOT, dir))}/intent.md (type ${type}, tier ${tier})`)
}

function cmdActivate(args: Args): void {
  const slug = args.pos[0]
  if (!slug || !exists(path.join(CHANGES, slug))) fail(`no change named ${slug}`)
  setActive(slug)
  out(`active change: ${slug}`)
}

function cmdStatus(args: Args): void {
  const json = Boolean(args.opt.json)
  if (!exists(SDLC)) return out(json ? JSON.stringify({ initialised: false }) : 'sdlc not initialised here: run /sdlc:start')
  const active = activeSlug()
  const changes = listChanges().map(loadChange)
  const warnings: string[] = []
  for (const c of changes) {
    const plan = path.join(c.dir, 'plan.md')
    if (exists(plan)) for (const p of planProblems(plan)) warnings.push(`${c.slug}: ${p}`)
    if (lines(read(path.join(c.dir, 'intent.md'))) > LIMITS.intentLines + 10) warnings.push(`${c.slug}: intent.md is long; keep it under ${LIMITS.intentLines} lines`)
  }
  if (lines(frontmatter(read(STATE)).body) > LIMITS.stateLines) warnings.push(`STATE.md over ${LIMITS.stateLines} lines; trim it`)
  if (json) {
    const summary = changes.map(c => ({ slug: c.slug, type: c.type, tier: c.tier, next: c.next, command: nextCommand(c) }))
    return out(JSON.stringify({ initialised: true, active, changes: summary, warnings, sensors: sensorStatus() }))
  }
  if (!changes.length) return out('no changes yet: run /sdlc:start "<what you want>"')
  const label = (c: Change): string => (c.next ? (c.next.kind === 'approve' && c.next.gate === 'impact' ? 'impact' : c.next.stage) + (c.next.kind === 'approve' ? ' (awaiting approval)' : '') : 'done')
  const rows = changes
    .sort((a, b) => (a.slug === active ? -1 : b.slug === active ? 1 : 0))
    .map(c => `${c.slug === active ? '▶' : ' '} ${c.slug.padEnd(28)} ${c.type.padEnd(10)} ${c.tier}  ${label(c)}`)
  const act = active ? loadChange(active) : null
  out([...rows, '', act ? `next: ${nextCommand(act)}` : '', ...warnings.map(w => `warn: ${w}`)].filter(Boolean).join('\n'))
}

function cmdApprove(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail('approvals are human-only: the person runs /sdlc-approve <slug> <stage>', 3)
  const [slug, stage] = args.pos
  if (!slug || !stage) fail('usage: approve <slug> <stage>')
  const artifact = APPROVAL_ARTIFACTS[stage as GatedStage]
  const file = path.join(CHANGES, slug, artifact ?? '')
  if (!artifact || !exists(file)) fail(`nothing to approve: ${slug}/${artifact ?? stage} does not exist`)
  const by = optString(args, 'by') || git(['config', 'user.name']) || process.env.USER || process.env.USERNAME || 'unknown'
  if (stage === 'impact' && !exists(path.join(CHANGES, slug, 'impact.json'))) fail(`nothing to approve: ${slug}/impact.json does not exist (run check --at plan first)`)
  const row: Approval = { slug, stage, by, at: now(), digest: approvalDigest(slug, stage as GatedStage) }
  fs.appendFileSync(APPROVALS, JSON.stringify(row) + '\n')
  out(`approved ${slug} ${stage} by ${by} (digest ${row.digest}). Next: ${nextCommand(loadChange(slug))}`)
}

function cmdScopeDrift(args: Args): void {
  const slug = args.pos[0] ?? activeSlug()
  if (!slug) fail('no change to check')
  const base = optString(args, 'base') ?? defaultBase()
  const r = scopeDrift(slug, base)
  if (args.opt.record) {
    const shipFile = path.join(CHANGES, slug, 'ship.json')
    const prev: object = exists(shipFile) ? JSON.parse(read(shipFile)) : {}
    const record = { ...prev, at: now(), base, changed: r.changed.length, drift: r.drift, matchRatio: Number(r.matchRatio.toFixed(3)) }
    fs.writeFileSync(shipFile, JSON.stringify(record, null, 2) + '\n')
  }
  if (args.opt.json) return out(JSON.stringify(r))
  if (!r.patterns.length) out(`warn: ${slug}/plan.md has no "## Files" section; every changed file counts as drift`)
  if (!r.drift.length) return out(`scope ok: ${r.changed.length} changed file(s), all in ${slug}'s plan`)
  out(`scope drift: ${r.drift.length} of ${r.changed.length} changed file(s) are not in ${slug}/plan.md ## Files:\n${r.drift.map(f => '  ' + f).join('\n')}\nAdd them to the plan (and re-approve if gated) or revert them.`)
  process.exitCode = 1
}

type ShippedRepo = { name: string; branch: string; commit: string }

type Consumer = { name: string; dir: string; test?: string; files: string[]; branch: string | null }

// Changed paths (untracked included) in a checkout, relative to it.
function dirtyPaths(dir: string): string[] {
  const parts = (gitIn(dir, ['status', '--porcelain', '-uall', '-z']) ?? '').split('\0').filter(Boolean)
  const files: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i] ?? ''
    files.push(row.replace(/^[ MADRCUT?!]{1,2} /, '')) // gitIn trims, so the first row may have lost a leading space
    if (/^[RC]/.test(row)) i++ // a rename/copy row is followed by its source path
  }
  return files
}

// Consumers with uncommitted work in this change: every changed file must be planned before anything runs or is committed.
function changedConsumers(slug: string, config: SensorConfig): Consumer[] {
  const planned = planFiles(slug)
  const found: Consumer[] = []
  for (const c of config.consumers) {
    const dir = path.resolve(ROOT, c.path)
    if (!exists(dir)) continue
    const dirty = dirtyPaths(dir)
    if (!dirty.length) continue
    const rel = toPosix(path.normalize(c.path)).replace(/\/+$/, '')
    const stray = dirty.filter(f => !isPlanned(`${rel}/${f}`, planned))
    if (stray.length) fail(`${c.name} has changes outside ${slug}/plan.md ## Files: ${stray.join(', ')}`)
    found.push({ name: c.name, dir, test: c.test, files: dirty, branch: gitIn(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) })
  }
  return found
}

const branchExists = (dir: string, branch: string): boolean => gitIn(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null
const onTrunk = (b: string | null): boolean => b === 'main' || b === 'master'

function commitConsumer(c: Consumer, slug: string, message: string): ShippedRepo {
  const branch = `sdlc/${slug}`
  if (onTrunk(c.branch)) {
    if (gitIn(c.dir, ['checkout', '-b', branch]) === null) fail(`could not create ${branch} in ${c.name}`)
  } else process.stderr.write(`${c.name} is on ${c.branch}, committing there, not ${branch}\n`)
  if (!c.test) process.stderr.write(`${c.name} has no test declared; committed unverified\n`)
  if (gitIn(c.dir, ['add', '--', ...c.files]) === null) fail(`git add failed in ${c.name}`)
  const body = `${message}\n\nPart of ${path.basename(ROOT)}@${branch}`
  // The consumer's own identity first; a checkout with none configured gets a neutral one.
  const ok = gitIn(c.dir, ['commit', '-q', '-m', body]) !== null
    || gitIn(c.dir, ['-c', 'user.name=sdlc', '-c', 'user.email=sdlc@localhost', 'commit', '-q', '-m', body]) !== null
  if (!ok) fail(`commit failed in ${c.name}`)
  return { name: c.name, branch: gitIn(c.dir, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? branch, commit: gitIn(c.dir, ['rev-parse', 'HEAD']) ?? '' }
}

// Ships a change deterministically: preconditions, scope gate, branch, staging and commit. The model only writes the message.
function cmdShip(args: Args): void {
  const slug = args.pos[0] ?? activeSlug()
  const message = optString(args, 'message')
  if (!slug || !exists(path.join(CHANGES, slug))) fail('usage: ship <slug> --message "<conventional commit message>"')
  if (!message) fail('ship needs --message "<type(scope): summary>"')
  const change = loadChange(slug)
  const pending = change.stages.filter(s => s !== 'ship' && !(change.next && change.stages.indexOf(s) < change.stages.indexOf(change.next.stage)))
  if (change.next && change.next.stage !== 'ship') fail(`not ready to ship: next is ${nextCommand(change)} (pending: ${pending.join(', ')})`)
  if (!change.next) return out(`${slug} is already shipped`)

  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const base = defaultBase() ?? (head && ['main', 'master'].includes(head) ? git(['rev-parse', 'HEAD']) : null)
  const r = scopeDrift(slug, base)
  if (r.drift.length) fail(`scope drift, not shipping. Out-of-plan files:\n${r.drift.map(f => '  ' + f).join('\n')}\nAdd them to plan.md ## Files (and re-approve if gated) or revert them.`)
  const { config, rules, errors } = loadConfig()
  const gate = runChecks({ point: 'ship', diffs: branchDiff(base ?? 'HEAD'), config, rules, slugs: [slug], commands: 'full', budgetMs: 1_800_000, before: f => showAt(base ?? 'HEAD', f) ?? '', base })
  if (errors.length || gate.blocks.length) {
    const configFindings = errors.map(e => `[config] ${e}`)
    fail(`not shipping: the ship gate found problems\n${[...configFindings, formatFindings(gate.findings)].filter(Boolean).join('\n')}\nFix them (one implementer round), or the person waives with /sdlc-waive <sensor> <file|*> <reason>.`)
  }

  const consumers = changedConsumers(slug, config)
  const trunk = onTrunk(head)
  if (trunk && branchExists(ROOT, `sdlc/${slug}`)) fail(`not shipping: branch sdlc/${slug} already exists in this repo`)
  for (const c of consumers) {
    if (onTrunk(c.branch) && branchExists(c.dir, `sdlc/${slug}`)) fail(`not shipping: branch sdlc/${slug} already exists in ${c.name}`)
  }
  if (!git(['status', '--porcelain'])) fail('not shipping: nothing to commit in this repo')
  for (const c of consumers) {
    if (!c.test) continue
    const row = runCommand(c.test, { cwd: c.dir })
    recordRun(slug, { ...row, source: 'ship' })
    if (row.exit !== 0) fail(`not shipping: ${c.name} tests failed (exit ${row.exit}):\n${row.tail}`)
  }
  const shipFile = path.join(CHANGES, slug, 'ship.json')
  const repos: ShippedRepo[] = []
  const record = (): void => fs.writeFileSync(shipFile, JSON.stringify({ at: now(), base, changed: r.changed.length, drift: [], matchRatio: 1, repos }, null, 2) + '\n')
  for (const c of consumers) {
    repos.push(commitConsumer(c, slug, message))
    record() // a later failure still leaves what was committed on record
  }

  if (trunk) {
    if (git(['checkout', '-b', `sdlc/${slug}`]) === null) fail(`could not create branch sdlc/${slug}`)
  }
  record()
  ensureGitignore()
  const changeDir = toPosix(path.relative(ROOT, path.join(CHANGES, slug)))
  clearState(slug)
  const extras = ['.sdlc/approvals.jsonl', '.sdlc/waivers.jsonl', '.sdlc/.gitignore', '.sdlc/STATE.md', '.sdlc/guides'].filter(f => exists(path.join(ROOT, f)))
  const code = r.changed.filter(f => !f.startsWith('.sdlc/'))
  if (git(['add', '--', changeDir, ...extras, ...code]) === null) fail('git add failed')
  if (git(['commit', '-q', '-m', message]) === null) fail('git commit failed (nothing staged, or a commit hook refused it)')
  out(`shipped ${slug} on ${git(['rev-parse', '--abbrev-ref', 'HEAD'])} at ${git(['rev-parse', '--short', 'HEAD'])}: ${code.length} code file(s) + artifacts. Push and open a PR only with the person's go-ahead.`)
}

function cmdSecrets(args: Args): void {
  const hits = args.pos.flatMap(scanSecrets)
  if (!hits.length) return out('no secrets found')
  process.stderr.write(hits.join('\n') + '\n')
  process.exitCode = 2
}

function cmdLogUsage(args: Args): void {
  if (!exists(SDLC)) return
  ensureGitignore()
  // The mod passes the change and stage it saw when the turn started. A turn that started with no
  // change and created one (/sdlc:start) is that change's intent stage.
  const row = JSON.parse(args.pos[0] ?? '{}') as Partial<UsageRow>
  const current = frontmatter(read(STATE)).data.change || null
  const change = row.change ?? current
  const stage = row.change ? row.stage ?? null : current ? 'intent' : null
  fs.appendFileSync(USAGE, JSON.stringify({ at: now(), ...row, change, stage }) + '\n')
}

// ---------- main ----------

// Deterministic fallback when the Skill tool fails to load a stage skill (seen in `claude -p`):
// prints the same instructions the skill would have loaded.
function cmdSkill(args: Args): void {
  const [name, ...rest] = args.pos
  const skills = path.join(PLUGIN_ROOT, 'skills')
  const file = path.join(skills, name ?? '', 'SKILL.md')
  if (!name || !exists(file)) fail(`no skill named ${name ?? ''}; one of ${exists(skills) ? fs.readdirSync(skills).join(', ') : '(none here)'}`)
  const body = frontmatter(read(file)).body
  out(body.replaceAll('${CLAUDE_PLUGIN_ROOT}', toPosix(PLUGIN_ROOT)).replaceAll('$ARGUMENTS', rest.join(' ')).replace(/\$0\b/g, rest[0] ?? ''))
}

// `run` takes its command after `--`, as one quoted argument: sdlc.ts run [--slug s] [--expect-fail] -- "npm test"
function cmdRun(): void {
  const argv = process.argv.slice(3)
  const dash = argv.indexOf('--')
  if (dash < 0 || dash === argv.length - 1) fail('usage: run [--slug s] [--expect-fail] -- "<command>"')
  const head = parseArgs(argv.slice(0, dash))
  const cmd = argv.slice(dash + 1).join(' ')
  const slug = optString(head, 'slug') ?? activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail('no such change: run /sdlc:start first, or pass an existing --slug')
  const expectFail = Boolean(head.opt['expect-fail'])
  const row = runCommand(cmd)
  recordRun(slug, expectFail ? { ...row, expectFail: true } : row)
  if (row.tail) out(row.tail)
  out(`sdlc run: exit ${row.exit}${row.timedOut ? ' (timed out)' : ''} in ${row.ms} ms, recorded in ${slug}/runs.jsonl`)
  process.exitCode = expectFail ? (row.exit !== 0 ? 0 : 1) : row.exit
}

function cmdVerifyReport(args: Args): void {
  const slug = args.pos[0] ?? activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail('usage: verify-report <slug>')
  const rows = readRuns(slug)
  const { text, result } = renderVerification(rows, runsDigest(slug, rows.length), planVerification(slug))
  fs.writeFileSync(path.join(CHANGES, slug, 'verification.md'), text)
  out(`verification ${result}: ${rows.length} recorded run(s). Next: ${nextCommand(loadChange(slug))}`)
}

function cmdDiff(args: Args): void {
  const base = optString(args, 'base')
  if (!base && !args.opt.turn) fail('usage: diff (--turn | --base <ref>) [--json]')
  const snap = base ? null : readBaseline()
  if (!base && !snap) return out('no turn baseline yet (run a prompt first)')
  const diffs = base ? branchDiff(git(['merge-base', 'HEAD', base]) ?? base) : turnDiff(snap as Snapshot)
  if (args.opt.json) return out(JSON.stringify(diffs))
  out(diffs.map(d => `${d.status} ${d.file} (+${d.added.length} -${d.removed.length})`).join('\n') || 'no changes')
}

// Every script the checker imports; testkit and specs stay behind. CI runs this copy, so it never needs the plugin.
const VENDORED = ['core', 'model', 'sensors', 'diffs', 'runs', 'check', 'hooks', 'metrics', 'sdlc', 'shell']

function cmdVendor(): void {
  const bin = path.join(SDLC, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of VENDORED) fs.copyFileSync(path.join(PLUGIN_ROOT, 'scripts', `${name}.ts`), path.join(bin, `${name}.ts`))
  const version = (JSON.parse(read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) as { version?: string }).version ?? 'unknown'
  fs.writeFileSync(path.join(bin, 'VERSION'), `${version}\n`)
  sanctionWrites([...VENDORED.map(n => `.sdlc/bin/${n}.ts`), '.sdlc/bin/VERSION'])
  out(`vendored sdlc ${version} into .sdlc/bin (${VENDORED.length} files). Commit it; CI runs the base branch's copy.`)
}

const SENSOR_NAMES = ['test-tamper', 'suppression', 'layering', 'size', 'secrets', 'rules', 'contract-impact', 'harness-tamper', 'traceability', 'red-proof', 'adhoc', 'commands', 'config']

function cmdWaive(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail('waivers are human-only: the person runs /sdlc-waive <sensor> <file|*> <reason>', 3)
  const [sensor, file, ...reason] = args.pos
  const slug = optString(args, 'slug') ?? activeSlug()
  if (!sensor || !file || !reason.length || !slug) fail('usage: waive <sensor> <file|*> <reason...>  (needs an active change)')
  if (!SENSOR_NAMES.includes(sensor)) fail(`unknown sensor "${sensor}"; known: ${SENSOR_NAMES.join(', ')}`)
  const by = git(['config', 'user.name']) || process.env.USER || process.env.USERNAME || 'unknown'
  const row: Waiver = { slug, sensor, file, reason: reason.join(' '), by, at: now() }
  fs.appendFileSync(WAIVERS, JSON.stringify(row) + '\n')
  out(`waived ${sensor} for ${file} in ${slug}: ${row.reason} (by ${by})`)
}

function sensorStatus(): { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number } | null {
  if (!exists(SDLC)) return null
  const last = readGate().last
  const slug = activeSlug()
  let unresolved = 0
  try {
    unresolved = (JSON.parse(read(path.join(SDLC, 'unresolved.json'))) as { findings: unknown[] }).findings.length
  } catch {
    unresolved = 0
  }
  return {
    blocks: last?.blocks ?? 0, warns: last?.warns ?? 0, bySensor: last?.bySensor ?? {}, unresolved,
    knownRed: loadConfig().config.knownRed.length,
    waivers: readJsonl<Waiver>(WAIVERS).filter(w => w.slug === slug).length,
  }
}

function cmdSensors(): void {
  const s = sensorStatus()
  if (!s) return out('sdlc not initialised here')
  const slug = activeSlug()
  let unresolved: Finding[] = []
  try {
    unresolved = (JSON.parse(read(path.join(SDLC, 'unresolved.json'))) as { findings: Finding[] }).findings
  } catch {
    unresolved = []
  }
  const waivers = readJsonl<Waiver>(WAIVERS).filter(w => w.slug === slug)
  out([
    `last gate: ${s.blocks} block(s), ${s.warns} warning(s)${Object.keys(s.bySensor).length ? ' · ' + Object.entries(s.bySensor).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`,
    unresolved.length ? `unresolved:\n${formatFindings(unresolved)}` : 'unresolved: none',
    `known red: ${loadConfig().config.knownRed.join(', ') || 'none'}`,
    `waivers (${slug ?? 'no change'}): ${waivers.map(w => `${w.sensor} ${w.file} ${w.reason}`).join('; ') || 'none'}`,
  ].join('\n'))
}

const COMMANDS: Record<string, (args: Args) => void> = {
  init: cmdInit,
  new: cmdNew,
  activate: cmdActivate,
  status: cmdStatus,
  approve: cmdApprove,
  'scope-drift': cmdScopeDrift,
  ship: cmdShip,
  skill: cmdSkill,
  run: () => cmdRun(),
  'verify-report': cmdVerifyReport,
  secrets: cmdSecrets,
  'log-usage': cmdLogUsage,
  hook: cmdHook,
  metrics: cmdMetrics,
  diff: cmdDiff,
  check: cmdCheck,
  'check-file': cmdCheckFile,
  vendor: () => cmdVendor(),
  waive: cmdWaive,
  sensors: () => cmdSensors(),
  'impact-status': cmdImpactStatus,
}

const [command = '', ...rest] = process.argv.slice(2)
const run = COMMANDS[command]
if (!run) fail(`usage: sdlc.ts <${Object.keys(COMMANDS).join('|')}> ...`)
try {
  run(parseArgs(rest))
} catch (err) {
  // Hooks must never wedge a session: a crashing hook reports and lets the action through.
  const message = err instanceof Error ? err.message : String(err)
  if (command === 'hook') process.stderr.write(`${SOFT_HOOK_FAILURE}: ${message}\n`)
  else if (command === 'check') fail(`sdlc check crashed (fails closed): ${message}`)
  else fail(err instanceof Error ? err.stack ?? message : message)
}
