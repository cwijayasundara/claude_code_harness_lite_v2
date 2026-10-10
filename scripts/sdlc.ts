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
  exists, read, lines, now, toPosix, out, fail, git, planPath, planName, approvalFile, frontmatter, parseArgs, optString, listChanges, defaultBase, isShipped, scopeDrift, scanSecrets, planProblems, checkSlug, SLUG_RE,
  WAIVERS, readJsonl, type Waiver, ensureGitignore, clearState, PLUGIN_ROOT, IS_VENDORED, skillRef, setActive, createChange, sanctionWrites, type Args, type Approval, type Change, type GatedStage, type UsageRow,
} from './core.ts'
import { PATHS, isChangeType, isTier, activeSlug, loadChange, nextCommand, step, tierDrift } from './graph.ts'
import { formatFindings, openQuestions, unresolvedConcerns, SENSOR_NAMES, type Finding } from './model.ts'
import { readBaseline, branchDiff, turnDiff, type Snapshot } from './diffs.ts'
import { cmdHook, readGate } from './hooks.ts'
import { cmdCheck, cmdCheckFile, cmdImpactStatus, loadConfig } from './check.ts'
import { runCommand, recordRun } from './runs.ts'
import { cmdMetrics } from './metrics.ts'
import { cmdEvals, lastRun } from './evals.ts'
import { cmdInbox, pendingIntents } from './inbox.ts'
import { cmdWatch, watchWarnings } from './watch.ts'
import { cmdPoints, parsePoints, pointsOf } from './points.ts'
import { cmdScorecard, story } from './scorecard.ts'
import { flowOf, flowLine } from './flow.ts'
import { cmdVendor, installStandalone } from './vendor.ts'
import { cmdVerify, cmdVerifyReport } from './verify.ts'
import { cmdHooks, cmdCheckPush } from './githooks.ts'
import { safeBudgetView, pressureOf, cmdSpend, publishQuietly, type BudgetView, type Pressure } from './spend.ts'
import { cmdPr, cmdPrChecks, otherChangeBranch } from './pr.ts'
import { cmdRatchet, readRatchet, writeRatchet, rawSpendUsd, unblock, appendEvent } from './ratchet.ts'
import { cmdQuality } from './quality.ts'
import { cmdShards } from './shards.ts'
import { treeStamp } from './stamp.ts'
import { stalenessAll, openItems, sliceWarnings, repoStale } from './stale.ts'
import { cmdPreflight } from './preflight.ts'
import { contextWarnings, enabledPlugins } from './context.ts'

// ---------- commands ----------

const STACK_MARKERS: [string, string][] = [['package.json', 'node'], ['go.mod', 'go'], ['pom.xml', 'java-maven'], ['pyproject.toml', 'python'], ['requirements.txt', 'python']]

// `init --stack [name]`: declares sensors.json `levels` from the plugin's own templates/stacks.json, the one path that may do it
// without a person's yes, because it takes commands only from that shipped template and never from arguments. The write guard
// asks a person before a model adds a level (declared commands run unprompted). Onboarding only: it declares only while `levels`
// is empty, no change exists yet and sensors.json is not committed, so it cannot launder an edit to a reviewed config.
// acceptance and api are not in the template: both default to the unit command, so a change never blocks on an undeclared level.
function declareStackLevels(opt: string | true): string {
  const stacks = JSON.parse(read(path.join(PLUGIN_ROOT, 'templates', 'stacks.json'))) as Record<string, { levels: Record<string, string> }>
  const name = typeof opt === 'string' ? opt : STACK_MARKERS.find(([f]) => exists(path.join(ROOT, f)))?.[1]
  const stack = name ? stacks[name] : undefined
  if (!name || !stack) return `no stack template for ${name ?? 'this directory'} (known: ${Object.keys(stacks).join(', ')}); declare levels in .rig/sensors.json yourself`
  const file = path.join(SDLC, 'sensors.json')
  if ((git(['ls-tree', '-r', '--name-only', 'HEAD']) ?? '').split('\n').includes('.rig/sensors.json')) return '.rig/sensors.json is committed; changing it is a reviewed harness edit, not onboarding'
  if (listChanges().length) return 'a change already exists; --stack is for onboarding only'
  let cfg: Record<string, unknown> = {}
  if (exists(file)) {
    try { cfg = JSON.parse(read(file)) as Record<string, unknown> } catch { return '.rig/sensors.json does not parse; not touching it' }
  }
  if (cfg.levels && Object.keys(cfg.levels as object).length) return 'levels already declared; left as they are'
  const unit = stack.levels.unit ?? ''
  cfg.levels = { ...stack.levels, acceptance: unit, api: unit }
  if (!cfg.fast && !cfg.full && unit) { cfg.fast = { test: unit }; cfg.full = { test: unit } }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  sanctionWrites(['.rig/sensors.json'])
  return `declared levels for ${name}: ${Object.entries(cfg.levels as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(', ')} (acceptance and api default to the unit command; point them at a real e2e or HTTP test when you have one)`
}

function cmdInit(args: Args): void {
  // Ship and the PR gate read git, so a directory outside any repo gets one.
  const newRepo = git(['rev-parse', '--is-inside-work-tree']) !== 'true' && git(['init', '-q', '-b', 'main']) !== null
  fs.mkdirSync(CHANGES, { recursive: true })
  fs.mkdirSync(path.join(SDLC, 'incidents'), { recursive: true })
  ensureGitignore()
  if (!exists(STATE)) fs.writeFileSync(STATE, '---\nchange:\n---\n# State\n\nNo active change.\n')
  const guides = path.join(SDLC, 'guides')
  if (!exists(guides) && exists(path.join(PLUGIN_ROOT, 'guides'))) {
    fs.cpSync(path.join(PLUGIN_ROOT, 'guides'), guides, { recursive: true })
    sanctionWrites(fs.readdirSync(guides).map(f => `.rig/guides/${f}`))
  }
  out(`initialised ${toPosix(path.relative(ROOT, SDLC)) || SDLC}${newRepo ? ' (ran git init: no repository was here)' : ''}`)
  if (args.opt.stack) out(declareStackLevels(args.opt.stack))
  if (args.opt.full) out(installStandalone(Boolean(args.opt.workflows)))
}

function cmdNew(args: Args): void {
  const slug = args.pos[0]
  if (!slug || !SLUG_RE.test(slug)) fail('usage: new <kebab-slug> --type <type> --tier S|M|L [--title "..."] [--points N] [--source .rig/intent/<file>.md]')
  const type = optString(args, 'type') ?? 'feature'
  const tier = optString(args, 'tier') ?? 'M'
  if (!isChangeType(type)) fail(`unknown type "${type}"; one of ${Object.keys(PATHS).join(', ')}`)
  if (!isTier(tier)) fail('tier must be S, M or L')
  // An inbox file only: a plain kebab .md name under .rig/intent/ that exists (no `..`, no other directory).
  const source = optString(args, 'source')
  if (source !== undefined && (!/^\.rig\/intent\/[a-z0-9][a-z0-9-]{0,60}\.md$/.test(source) || !exists(path.join(ROOT, source)))) fail(`--source must name an existing .rig/intent/<kebab-name>.md file, not "${source}"`)
  const dir = path.join(CHANGES, slug)
  if (exists(dir)) fail(`change ${slug} already exists`)
  if (!exists(SDLC)) cmdInit({ pos: [], opt: {} })
  const explicit = args.opt.points !== undefined ? parsePoints(args.opt.points) : null
  const defaults = loadConfig().config.points
  createChange(slug, type, tier, optString(args, 'title') ?? slug, { value: explicit ?? defaults[tier], set: explicit !== null }, source)
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
  if (s.routeWarnings.length) process.stderr.write(s.routeWarnings.join('\n') + '\n')
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
  // --band, the mod's every-turn read: the active change only, without the warnings and staleness that walk every change and stamp the tree.
  const budgetOf = (st: { budget: BudgetView } | null): BudgetView => st?.budget ?? safeBudgetView(loadConfig().config.budget, null)
  // Team pressure with no active change rides at the top level; with one, step.pressure (which honours full-route) wins.
  const pressureTop = (st: { pressure: Pressure } | null): Pressure => st?.pressure ?? pressureOf(budgetOf(null), loadConfig().config.budget, false)
  const lean = json && args.opt.band ? (active ? loadChange(active) : null) : undefined
  if (lean !== undefined) {
    const st = active ? step(active) : null
    return out(JSON.stringify({ initialised: true, active, changes: lean ? [{ slug: lean.slug, next: lean.next }] : [], sensors: sensorStatus(), story: active ? story(active) : null, step: st, budget: budgetOf(st), pressure: pressureTop(st), flow: flowOf(true, lean) }))
  }
  const changes = listChanges().map(loadChange)
  const warnings: string[] = []
  for (const c of changes) {
    const plan = planPath(c.slug)
    if (exists(plan)) {
      for (const p of planProblems(plan)) warnings.push(`${c.slug}: ${p}`)
      warnings.push(...sliceWarnings(c.slug, read(plan)))
    }
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
  for (const e of pendingIntents()) warnings.push(`intent ${e.file} is accepted and has no change: ${skillRef('start')} .rig/intent/${e.file}`)
  warnings.push(...watchWarnings())
  const stale = [...repoStale(ROOT), ...stalenessAll(changes.map(c => c.slug))]
  const open = changes.flatMap(c => openItems(c.slug))
  if (json) {
    const summary = changes.map(c => ({ slug: c.slug, type: c.type, tier: c.tier, points: pointsOf(c.slug).points, next: c.next, command: nextCommand(c) }))
    const st = active ? step(active) : null
    return out(JSON.stringify({ initialised: true, active, changes: summary, warnings, stale, open, sensors: sensorStatus(), story: active ? story(active) : null, step: st, budget: budgetOf(st), pressure: pressureTop(st), flow: flowOf(true, active ? loadChange(active) : null) }))
  }
  if (!changes.length) return out([`no changes yet: run ${skillRef('start')} "<what you want>"`, ...warnings.map(w => `warn: ${w}`)].join('\n'))
  const label = (c: Change): string => (c.next ? (c.next.kind === 'approve' && c.next.gate === 'impact' ? 'impact' : c.next.stage) + (c.next.kind === 'approve' ? ' (awaiting approval)' : '') : 'done')
  const rows = changes
    .sort((a, b) => (a.slug === active ? -1 : b.slug === active ? 1 : 0))
    .map(c => `${c.slug === active ? '▶' : ' '} ${c.slug.padEnd(28)} ${c.type.padEnd(10)} ${c.tier}  ${label(c)}  ${pointsOf(c.slug).points}pt`)
  const act = active ? loadChange(active) : null
  const st = active ? step(active) : null
  const where = act ? `${act.slug} is at ${act.next ? (act.next.kind === 'approve' ? act.next.gate : act.next.stage) : 'done'}` : 'no active change'
  const ev = lastRun()
  const evalLine = ev ? `evals: ${ev.passed}/${ev.total} pass (${ev.rate.toFixed(2)}) → ${ev.verdict}, last run ${ev.run.slice(0, 10)}` : ''
  out([...rows, '', `flow: ${flowLine(flowOf(true, act))}`, `where: ${where}`, `stale: ${stale.length ? stale.join('; ') : 'nothing'}`, evalLine, st?.verdict === 'blocked' ? `blocked: ${st.reason}` : st?.verdict === 'human' ? `next: ${st.command}` : act ? `next: ${nextCommand(act)}` : '', ...warnings.map(w => `warn: ${w}`), ...open.map(o => `open: ${o}`)].filter(Boolean).join('\n'))
}

// A standalone repo's /rig:approve and /rig:waive skills pass '$ARGUMENTS' as one quoted string, so the shell never globs it.
const words = (args: Args): string[] => (args.pos.length === 1 ? (args.pos[0] ?? '').trim().split(/\s+/) : args.pos)

// What the person can type when their /rig-<cmd> slash command is not listed (a session started before the harness was vendored).
const humanFallback = (cmd: string, usage: string): string => `! SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning ${path.relative(process.cwd(), process.argv[1] ?? 'sdlc.ts')} ${cmd} ${usage}`

function cmdApprove(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail(`approvals are human-only: the person runs /rig:approve <slug> <stage>. If that command is not listed, restart Claude Code, or the person types: ${humanFallback('approve', '<slug> <stage>')}`, 3)
  const [slug, stage] = words(args)
  if (!slug || !stage) fail('usage: approve <slug> <stage>')
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
  if (stage === 'full-route') {
    const r = readRatchet(slug)
    r.fullRoute = true
    writeRatchet(slug, r)
    appendEvent(slug, { node: 'any', verdict: 'approved', kind: 'full-route', reason: 'a person turned budget downshift off for this change' })
    return out(`approved ${slug} full-route: budget downshift is off for this change; budget warnings still show`)
  }
  if (stage === 'tier') {
    // The person states the target; it is recorded only if intent.md says exactly that right now, so an edit made after
    // the person read it cannot be approved by accident. The recorded values are the person's arguments, never re-read.
    const [tier, type] = words(args).slice(2)
    if (!isTier(tier) || (type !== undefined && !isChangeType(type))) fail('usage: approve <slug> tier <S|M|L> [<type>]')
    const intent = frontmatter(read(path.join(CHANGES, slug, 'intent.md'))).data
    const says = { tier: isTier(intent.tier) ? intent.tier : 'M', type: isChangeType(intent.type) ? intent.type : 'feature' }
    if (says.tier !== tier || (type !== undefined && says.type !== type)) fail(`not approving: ${slug}/intent.md now says tier ${says.tier}, type ${says.type}; you approved ${tier}${type ? ` ${type}` : ''}. Read it again and run /rig:approve ${slug} tier <tier> [<type>]`)
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
  const open = ['intent', 'spec', 'plan', 'design'].includes(stage)
    ? [...openQuestions(read(file)).map(q => `${artifact}: ${q}`), ...(stage === 'design' ? openQuestions(read(path.join(CHANGES, slug, 'intent.md'))).map(q => `intent.md: ${q}`) : [])]
    : []
  if (open.length) {
    const list = open.map(q => `  - ${q}`).join('\n')
    fail(`resolve the open question(s) in ${open.some(q => q.startsWith('intent.md:')) ? `${slug}/intent.md` : `${slug}/${artifact}`} before approving: answer each, or record the default under ## Decisions, and leave "## Open questions" as none:\n${list}`)
  }
  const concerns = ['spec', 'plan', 'design'].includes(stage) ? unresolvedConcerns(read(file)) : []
  if (concerns.length) {
    // A policy skill copied from the template still has `owner: <the team or person ...>`; naming that as who to ask sends the person nowhere.
    const ghost = concerns.some(c => /→ owner: <[^>]*>/.test(c))
    const hint = ghost ? `\nThe policy's owner is not set (.claude/skills/policy-*/SKILL.md still has the template placeholder). If you own the policy, you can resolve it yourself: edit ${slug}/${artifact}, append " → resolved: <decision> (<your name>)" to each bullet, then run /rig:approve ${slug} ${stage} again. Set owner: in the policy skill so later concerns name a real person.` : ''
    fail(`resolve the concern(s) in ${slug}/${artifact} with their policy owners before approving: add " → resolved: <decision> (<owner>)" to each:\n${concerns.map(c => `  - ${c}`).join('\n')}${hint}`)
  }
  const by = optString(args, 'by') || git(['config', 'user.name']) || process.env.USER || process.env.USERNAME || 'unknown'
  if (stage === 'impact' && !exists(path.join(CHANGES, slug, 'impact.json'))) fail(`nothing to approve: ${slug}/impact.json does not exist (run check --at plan first)`)
  const row: Approval = { slug, stage, by, at: now(), digest: approvalDigest(slug, stage as GatedStage) }
  // The prompt hook and the /rig:approve skill can both run for one typed command: the second finds the row and adds nothing.
  if (exists(APPROVALS) && read(APPROVALS).split('\n').some(l => l.includes(`"slug":"${slug}","stage":"${stage}"`) && l.includes(`"digest":"${row.digest}"`))) return out(`${slug} ${stage} is already approved (digest ${row.digest}). Next: ${nextCommand(loadChange(slug))}`)
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
  if (badUsd || badKind || (row.kind === 'event' && row.event === 'budget-raised')) fail('log-usage refuses a bad usd or kind and budget-raised rows: only /rig:approve <slug> budget raises a budget', 3)
  const current = frontmatter(read(STATE)).data.change || null
  const change = row.change ?? current
  const stage = row.change ? row.stage ?? null : current ? 'intent' : null
  fs.appendFileSync(USAGE, JSON.stringify({ at: now(), ...row, change, stage }) + '\n')
  // The context sensor: one line per warning, which the mod shows as a toast and the band's log keeps.
  const warnings = contextWarnings(row, row.first ? enabledPlugins(undefined, ROOT) : [])
  if (warnings.length) out(warnings.join('\n'))
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
  const before = treeStamp()
  const row = runCommand(cmd)
  const tree = treeStamp() === before ? before : null
  const stamped = tree ? { ...row, tree } : row
  recordRun(slug, expectFail ? { ...stamped, expectFail: true } : stamped)
  if (row.tail) out(row.tail)
  out(`sdlc run: exit ${row.exit}${row.timedOut ? ' (timed out)' : ''} in ${row.ms} ms, recorded in ${slug}/runs.jsonl`)
  process.exitCode = expectFail ? (row.exit !== 0 ? 0 : 1) : row.exit
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
  if (process.env.SDLC_HUMAN !== '1') fail(`waivers are human-only: the person runs /rig:waive <sensor> <file|*> <reason>. If that command is not listed, restart Claude Code, or the person types: ${humanFallback('waive', "<sensor> <file|*> '<reason>'")}`, 3)
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

// A starting policy skill for design and review to apply; only the person-run init writes it, and never over an existing one.
function scaffoldPolicy(): string {
  const rel = '.claude/skills/policy-security/SKILL.md'
  const src = path.join(PLUGIN_ROOT, 'templates', 'policy-security.md')
  if (exists(path.join(ROOT, rel)) || !exists(src)) return ''
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true })
  fs.copyFileSync(src, path.join(ROOT, rel))
  sanctionWrites([rel])
  return `wrote ${rel}: set its owner and source`
}

const COMMANDS: Record<string, (args: Args) => void> = {
  stamp: () => out(treeStamp() ?? 'none'),
  init: args => { cmdInit(args); if (args.opt.full) { const note = scaffoldPolicy(); if (note) out(note) } },
  new: cmdNew,
  points: cmdPoints,
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
  verify: cmdVerify,
  'verify-report': cmdVerifyReport,
  secrets: cmdSecrets,
  'log-usage': cmdLogUsage,
  hook: cmdHook,
  metrics: cmdMetrics,
  evals: cmdEvals,
  inbox: cmdInbox,
  watch: cmdWatch,
  scorecard: cmdScorecard,
  spend: args => cmdSpend(args, () => {
    const slug = typeof args.opt.change === 'string' ? checkSlug(args.opt.change) : activeSlug()
    const c = slug ? loadChange(slug) : null
    return { cfg: loadConfig().config.budget, change: c ? { slug: c.slug, tier: c.tier, type: c.type } : null }
  }),
  diff: cmdDiff,
  quality: cmdQuality,
  shards: cmdShards,
  preflight: cmdPreflight,
  check: args => (args.opt.at === 'push' ? (cmdCheckPush(args), process.exitCode ? undefined : publishQuietly()) : cmdCheck(args)),
  'check-file': cmdCheckFile,
  vendor: cmdVendor,
  hooks: cmdHooks,
  ratchet: cmdRatchet,
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
  else if (command === 'check' && /^(?:commit|push)$/.test(String(parseArgs(rest).opt.at))) {
    // Inside a git hook (spec §2): a broken checker must not wedge the repo; CI judges the result.
    process.stderr.write(`rig: the checker crashed (${message}); allowing — CI still checks\n`)
    process.exitCode = 0
  } else if (command === 'check') fail(`sdlc check crashed (fails closed): ${message}`)
  else fail(err instanceof Error ? err.stack ?? message : message)
}
