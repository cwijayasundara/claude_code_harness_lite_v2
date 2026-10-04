#!/usr/bin/env node
// rig: the deterministic core of the sdlc plugin. Zero dependencies.
// Runs directly with Node >= 22.18 (built-in TypeScript type stripping) on macOS, Linux and Windows:
//   node --disable-warning=ExperimentalWarning scripts/sdlc.ts <command>
// Everything the model must not judge for itself lives in these scripts: change state, approvals,
// scope drift, sensors, hook decisions and metrics. This file is the CLI.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, APPROVALS, STATE, USAGE, LIMITS, SOFT_HOOK_FAILURE, APPROVAL_ARTIFACTS, approvalDigest,
  exists, read, lines, sha, now, toPosix, out, fail, git, gitIn, planFiles, planPath, planName, approvalFile, isPlanned, frontmatter, parseArgs, optString,
  listChanges, defaultBase, isShipped, scopeDrift, scanSecrets, planProblems, checkSlug, SLUG_RE,
  WAIVERS, readJsonl, type Waiver, ensureGitignore, clearState, planVerificationBullets, PLUGIN_ROOT, IS_VENDORED, skillRef, setActive, createChange, sanctionWrites, type Args, type Approval, type Change, type GatedStage, type Stage, type UsageRow,
} from './core.ts'
import { PATHS, isChangeType, isTier, activeSlug, loadChange, nextCommand, step, tierDrift } from './graph.ts'
import { formatFindings, openQuestions, SENSOR_NAMES, type Finding, type SensorConfig } from './model.ts'
import { readBaseline, branchDiff, turnDiff, showAt, type Snapshot } from './diffs.ts'
import { cmdHook, readGate } from './hooks.ts'
import { cmdCheck, cmdCheckFile, cmdImpactStatus, loadConfig, runChecks } from './check.ts'
import { runCommand, recordRun, readRuns, renderVerification, runsDigest } from './runs.ts'
import { cmdMetrics } from './metrics.ts'
import { cmdScorecard, story } from './scorecard.ts'
import { flowOf, flowLine } from './flow.ts'
import { cmdVendor } from './vendor.ts'
import { cmdPr, cmdPrChecks, otherChangeBranch } from './pr.ts'
import { cmdLearn, approveLearn } from './learncli.ts'
import { cmdRatchet, recordRound, readRatchet, writeRatchet, rawSpendUsd, unblock, block, appendEvent } from './ratchet.ts'
import { cmdWiki } from './wiki.ts'
import { cmdQuality } from './quality.ts'
import { requiredLevels, levelResults } from './levels.ts'
import { normCmd } from './shell.ts'

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
  if (!slug || !SLUG_RE.test(slug)) fail('usage: new <kebab-slug> --type <type> --tier S|M|L [--title "..."]')
  const type = optString(args, 'type') ?? 'feature'
  const tier = optString(args, 'tier') ?? 'M'
  if (!isChangeType(type)) fail(`unknown type "${type}"; one of ${Object.keys(PATHS).join(', ')}`)
  if (!isTier(tier)) fail('tier must be S, M or L')
  const dir = path.join(CHANGES, slug)
  if (exists(dir)) fail(`change ${slug} already exists`)
  if (!exists(SDLC)) cmdInit()
  createChange(slug, type, tier, optString(args, 'title') ?? slug)
  const other = otherChangeBranch(slug)
  out(`created ${toPosix(path.relative(ROOT, dir))}/intent.md (type ${type}, tier ${tier})${other ? `\nwarning: ${other}` : ''}`)
}

function cmdActivate(args: Args): void {
  const slug = checkSlug(args.pos[0] ?? '')
  setActive(slug)
  out(`active change: ${slug}`)
}

function cmdNext(args: Args): void {
  const slug = args.pos[0] ? checkSlug(args.pos[0]) : activeSlug()
  if (!slug) return out(args.opt.json ? JSON.stringify({ slug: null, node: null, verdict: 'ready', reason: 'no active change', command: `${skillRef('start')} "<what you want>"`, round: 0 }) : 'no active change')
  const s = step(slug)
  if (s.verdict === 'ready') clearReady(slug)
  out(args.opt.json ? JSON.stringify(s) : `${s.verdict}: ${s.verdict === 'continue' || s.verdict === 'human' ? s.command : s.reason}`)
}

// A finished change (every node done, the PR left to a person) stops being the one STATE.md names.
function clearReady(slug: string): void {
  if (frontmatter(read(STATE)).data.change === slug) clearState(slug)
}

function cmdStatus(args: Args): void {
  const json = Boolean(args.opt.json)
  if (!exists(SDLC)) return out(json ? JSON.stringify({ initialised: false, flow: flowOf(false, null) }) : `sdlc not initialised here: run ${skillRef('start')}`)
  const named = frontmatter(read(STATE)).data.change
  if (named && exists(path.join(CHANGES, named)) && step(named).verdict === 'ready') clearReady(named)
  const active = activeSlug()
  const changes = listChanges().map(loadChange)
  const warnings: string[] = []
  for (const c of changes) {
    const plan = planPath(c.slug)
    if (exists(plan)) for (const p of planProblems(plan)) warnings.push(`${c.slug}: ${p}`)
    const drift = tierDrift(c.slug)
    if (drift) warnings.push(`${c.slug}: ${drift}`)
    if (lines(read(path.join(c.dir, 'intent.md'))) > LIMITS.intentLines + 10) warnings.push(`${c.slug}: intent.md is long; keep it under ${LIMITS.intentLines} lines`)
  }
  if (lines(frontmatter(read(STATE)).body) > LIMITS.stateLines) warnings.push(`STATE.md over ${LIMITS.stateLines} lines; trim it`)
  if (active && !isShipped(active)) {
    const stacked = otherChangeBranch(active)
    if (stacked) warnings.push(stacked)
    if (git(['remote', 'get-url', 'origin']) === null) warnings.push('no origin remote: ship commits locally, but no PR, PR review or gh metrics until one is added (git remote add origin <url>)')
  }
  if (json) {
    const summary = changes.map(c => ({ slug: c.slug, type: c.type, tier: c.tier, next: c.next, command: nextCommand(c) }))
    return out(JSON.stringify({ initialised: true, active, changes: summary, warnings, sensors: sensorStatus(), story: active ? story(active) : null, step: active ? step(active) : null, flow: flowOf(true, active ? loadChange(active) : null) }))
  }
  if (!changes.length) return out(`no changes yet: run ${skillRef('start')} "<what you want>"`)
  const label = (c: Change): string => (c.next ? (c.next.kind === 'approve' && c.next.gate === 'impact' ? 'impact' : c.next.stage) + (c.next.kind === 'approve' ? ' (awaiting approval)' : '') : 'done')
  const rows = changes
    .sort((a, b) => (a.slug === active ? -1 : b.slug === active ? 1 : 0))
    .map(c => `${c.slug === active ? '▶' : ' '} ${c.slug.padEnd(28)} ${c.type.padEnd(10)} ${c.tier}  ${label(c)}`)
  const act = active ? loadChange(active) : null
  const st = active ? step(active) : null
  out([...rows, '', `flow: ${flowLine(flowOf(true, act))}`, st?.verdict === 'blocked' ? `blocked: ${st.reason}` : act ? `next: ${nextCommand(act)}` : '', ...warnings.map(w => `warn: ${w}`)].filter(Boolean).join('\n'))
}

// A standalone repo's /rig-approve and /rig-waive skills pass '$ARGUMENTS' as one quoted string, so the shell never globs it.
const words = (args: Args): string[] => (args.pos.length === 1 ? (args.pos[0] ?? '').trim().split(/\s+/) : args.pos)

function cmdApprove(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail('approvals are human-only: the person runs /rig-approve <slug> <stage>', 3)
  const [slug, stage] = words(args)
  if (!slug || !stage) fail('usage: approve <slug> <stage>')
  if (stage === 'learn') return approveLearn(slug) // the id names a proposal, not a change
  checkSlug(slug)
  if (stage === 'budget') {
    const node = readRatchet(slug).blocked?.node.replace(/#.*/, '') ?? step(slug).node ?? 'build'
    const r = readRatchet(slug)
    const spent = rawSpendUsd(slug, node)
    r.credits = { ...r.credits, [node]: spent }
    writeRatchet(slug, r)
    unblock(slug, 'person approved more budget')
    return out(`unblocked ${slug}: ${node} gets a fresh budget ($${spent.toFixed(2)} credited)`)
  }
  if (stage === 'tier') {
    // The person states the target; it is recorded only if intent.md says exactly that right now, so an edit made after
    // the person read it cannot be approved by accident. The recorded values are the person's arguments, never re-read.
    const [tier, type] = words(args).slice(2)
    if (!isTier(tier) || (type !== undefined && !isChangeType(type))) fail('usage: approve <slug> tier <S|M|L> [<type>]')
    const intent = frontmatter(read(path.join(CHANGES, slug, 'intent.md'))).data
    const says = { tier: isTier(intent.tier) ? intent.tier : 'M', type: isChangeType(intent.type) ? intent.type : 'feature' }
    if (says.tier !== tier || (type !== undefined && says.type !== type)) fail(`not approving: ${slug}/intent.md now says tier ${says.tier}, type ${says.type}; you approved ${tier}${type ? ` ${type}` : ''}. Read it again and run /rig-approve ${slug} tier <tier> [<type>]`)
    const r = readRatchet(slug)
    const was = { tier: r.tier ?? 'unrecorded', type: r.type ?? 'unrecorded' }
    r.tier = tier
    r.type = type ?? (isChangeType(r.type) ? r.type : 'feature')
    writeRatchet(slug, r)
    appendEvent(slug, { node: 'any', verdict: 'approved', kind: 'tier', reason: `tier ${was.tier} → ${r.tier}, type ${was.type} → ${r.type}; a person accepted it` })
    return out(`approved ${slug} tier: ${was.tier} → ${r.tier}, type ${was.type} → ${r.type}. Next: ${nextCommand(loadChange(slug))}`)
  }
  const artifact = APPROVAL_ARTIFACTS[stage as GatedStage] && path.basename(approvalFile(slug, stage as GatedStage))
  const file = artifact ? approvalFile(slug, stage as GatedStage) : ''
  if (!artifact || !exists(file)) fail(`nothing to approve: ${slug}/${artifact ?? stage} does not exist`)
  const open = stage === 'spec' || stage === 'plan' || stage === 'design' ? openQuestions(read(file)) : []
  if (open.length) {
    const list = open.map(q => `  - ${q}`).join('\n')
    fail(`resolve the open question(s) in ${slug}/${artifact} before approving: answer each, or record the default under ## Decisions, and leave "## Open questions" as none:\n${list}`)
  }
  const by = optString(args, 'by') || git(['config', 'user.name']) || process.env.USER || process.env.USERNAME || 'unknown'
  if (stage === 'impact' && !exists(path.join(CHANGES, slug, 'impact.json'))) fail(`nothing to approve: ${slug}/impact.json does not exist (run check --at plan first)`)
  const row: Approval = { slug, stage, by, at: now(), digest: approvalDigest(slug, stage as GatedStage) }
  fs.appendFileSync(APPROVALS, JSON.stringify(row) + '\n')
  out(`approved ${slug} ${stage} by ${by} (digest ${row.digest}). Next: ${nextCommand(loadChange(slug))}`)
}

function cmdScopeDrift(args: Args): void {
  const slug = args.pos[0] ? checkSlug(args.pos[0]) : activeSlug()
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
  if (!r.patterns.length) out(`warn: ${slug}/${planName(slug)} has no "## Files" section; every changed file counts as drift`)
  if (!r.drift.length) return out(`scope ok: ${r.changed.length} changed file(s), all in ${slug}'s plan`)
  out(`scope drift: ${r.drift.length} of ${r.changed.length} changed file(s) are not in ${slug}/${planName(slug)} ## Files:\n${r.drift.map(f => '  ' + f).join('\n')}\nAdd them to the plan (and re-approve if gated) or revert them.`)
  process.exitCode = 1
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
  // change and created one (/rig:start) is that change's intent stage.
  const row = JSON.parse(args.pos[0] ?? '{}') as Partial<UsageRow>
  // Money only goes up: a malformed or negative usd, an unknown kind or a budget-raised event would let the model grant itself budget.
  const badUsd = row.usd !== undefined && (typeof row.usd !== 'number' || !Number.isFinite(row.usd) || row.usd < 0)
  const badKind = !(['main', 'agent', 'event'] as unknown[]).includes(row.kind)
  if (badUsd || badKind || (row.kind === 'event' && row.event === 'budget-raised')) fail('log-usage refuses a bad usd or kind and budget-raised rows: only /rig-approve <slug> budget raises a budget', 3)
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
  const skills = IS_VENDORED ? path.join(ROOT, '.claude', 'skills') : path.join(PLUGIN_ROOT, 'skills')
  const file = path.join(skills, IS_VENDORED ? `rig-${name ?? ''}` : name ?? '', 'SKILL.md')
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
  const given = optString(head, 'slug')
  const slug = given ? checkSlug(given) : activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail('no such change: run /rig:start first, or pass an existing --slug')
  const expectFail = Boolean(head.opt['expect-fail'])
  const row = runCommand(cmd)
  recordRun(slug, expectFail ? { ...row, expectFail: true } : row)
  if (row.tail) out(row.tail)
  out(`sdlc run: exit ${row.exit}${row.timedOut ? ' (timed out)' : ''} in ${row.ms} ms, recorded in ${slug}/runs.jsonl`)
  process.exitCode = expectFail ? (row.exit !== 0 ? 0 : 1) : row.exit
}

function cmdVerifyReport(args: Args): void {
  const slug = args.pos[0] ? checkSlug(args.pos[0]) : activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail('usage: verify-report <slug>')
  const rows = readRuns(slug)
  const plan = planVerificationBullets(slug)
  const change = loadChange(slug)
  const { config } = loadConfig()
  const required = change.type === 'spike' ? [] : requiredLevels(change, read(planPath(slug)), config)
  const latest = new Map(rows.filter(r => !r.expectFail && !r.source).map(r => [normCmd(r.cmd), r.exit]))
  // Plan commands stand in for an undeclared unit level; with no plan list, any explicit green run does (the no-plan fallback).
  const planned = plan.commands.map(normCmd)
  const planPassed = planned.length ? planned.every(c => latest.get(c) === 0) : latest.size > 0 && [...latest.values()].every(e => e === 0)
  const levels = levelResults(slug, required, config, planPassed)
  const { text, result } = renderVerification(rows, runsDigest(slug, rows.length), plan.commands, plan.ignored, levels)
  fs.writeFileSync(path.join(CHANGES, slug, 'verification.md'), text)
  // A required level nobody declared is not fixable by code (spec §5.2): block with the exact edit a person makes.
  // The level kind clears first, so a cap reached in this same run is recorded rather than refused behind the old block.
  const undeclared = levels.find(l => l.status === 'undeclared')
  if (!undeclared) unblock(slug, 'levels declared', 'level')
  // A failing report is always a new finding (counter keeps the hash unique), so only the test node's cap applies.
  if (result === 'fail') {
    recordRound(slug, 'test', [{ severity: 'high', category: 'tests', text: `verification failed at ${now()} (${rows.length} runs, round ${readRatchet(slug).nodes.test?.hashes.length ?? 0})` }], { cap: config.ratchet.rounds.test })
  }
  if (undeclared) block(slug, 'test', `level ${undeclared.level} required but not declared: add "${undeclared.level}": "<cmd>" to .sdlc/sensors.json levels: declare it on the trunk first, as a separate harness change to .sdlc/sensors.json reviewed by the code owners; then rebase this change`, 'level')
  out(`verification ${result}: ${rows.length} recorded run(s). Next: ${nextCommand(loadChange(slug))}`)
}

function cmdDiff(args: Args): void {
  const trunk = args.opt.trunk ? defaultBase() ?? 'HEAD' : null
  const base = optString(args, 'base')
  if (!base && !trunk && !args.opt.turn) fail('usage: diff (--turn | --trunk | --base <ref>) [--json]')
  const snap = base || trunk ? null : readBaseline()
  if (!base && !trunk && !snap) return out('no turn baseline yet (run a prompt first)')
  const diffs = trunk ? branchDiff(trunk) : base ? branchDiff(git(['merge-base', 'HEAD', base]) ?? base) : turnDiff(snap as Snapshot)
  if (args.opt.json) return out(JSON.stringify(diffs))
  out(diffs.map(d => `${d.status} ${d.file} (+${d.added.length} -${d.removed.length})`).join('\n') || 'no changes')
}

// Every script the checker imports; testkit and specs stay behind. CI runs this copy, so it never needs the plugin.
function cmdWaive(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail('waivers are human-only: the person runs /rig-waive <sensor> <file|*> <reason>', 3)
  const [sensor, file, ...reason] = words(args)
  const given = optString(args, 'slug')
  const slug = given ? checkSlug(given) : activeSlug()
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
  next: cmdNext,
  approve: cmdApprove,
  'scope-drift': cmdScopeDrift,
  pr: cmdPr,
  ship: cmdPr,
  'pr-checks': cmdPrChecks,
  skill: cmdSkill,
  run: () => cmdRun(),
  'verify-report': cmdVerifyReport,
  secrets: cmdSecrets,
  'log-usage': cmdLogUsage,
  hook: cmdHook,
  metrics: cmdMetrics,
  scorecard: cmdScorecard,
  wiki: cmdWiki,
  diff: cmdDiff,
  quality: cmdQuality,
  check: cmdCheck,
  'check-file': cmdCheckFile,
  vendor: cmdVendor,
  ratchet: cmdRatchet,
  waive: cmdWaive,
  sensors: () => cmdSensors(),
  learn: cmdLearn,
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
