#!/usr/bin/env node
// sdlc: the deterministic core of the sdlc plugin. Zero dependencies.
// Runs directly with Node >= 22.18 (built-in TypeScript type stripping) on macOS, Linux and Windows:
//   node --disable-warning=ExperimentalWarning scripts/sdlc.ts <command>
// Everything the model must not judge for itself lives in these scripts: change state, approvals,
// scope drift, sensors, hook decisions and metrics. This file is the CLI.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, APPROVALS, STATE, USAGE, LIMITS, SOFT_HOOK_FAILURE, PATHS, ARTIFACTS,
  exists, read, lines, sha, now, toPosix, out, fail, git, frontmatter, parseArgs, optString, isChangeType, isTier,
  listChanges, activeSlug, loadChange, nextCommand, defaultBase, scopeDrift, scanSecrets, planProblems,
  ensureGitignore, clearState, PLUGIN_ROOT, setActive, intentTemplate, type Args, type Approval, type Change, type Stage, type UsageRow,
} from './core.ts'
import { cmdHook } from './hooks.ts'
import { cmdMetrics } from './metrics.ts'

// ---------- commands ----------

function cmdInit(): void {
  fs.mkdirSync(CHANGES, { recursive: true })
  fs.mkdirSync(path.join(SDLC, 'incidents'), { recursive: true })
  ensureGitignore()
  if (!exists(STATE)) fs.writeFileSync(STATE, '---\nchange:\n---\n# State\n\nNo active change.\n')
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
  ensureGitignore()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'intent.md'), intentTemplate(slug, type, tier, optString(args, 'title') ?? slug))
  setActive(slug)
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
    return out(JSON.stringify({ initialised: true, active, changes: summary, warnings }))
  }
  if (!changes.length) return out('no changes yet: run /sdlc:start "<what you want>"')
  const label = (c: Change): string => (c.next ? c.next.stage + (c.next.kind === 'approve' ? ' (awaiting approval)' : '') : 'done')
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
  const artifact = ARTIFACTS[stage as Stage]
  const file = path.join(CHANGES, slug, artifact ?? '')
  if (!artifact || !exists(file)) fail(`nothing to approve: ${slug}/${artifact ?? stage} does not exist`)
  const by = optString(args, 'by') || git(['config', 'user.name']) || process.env.USER || process.env.USERNAME || 'unknown'
  const row: Approval = { slug, stage, by, at: now(), digest: sha(read(file)) }
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

  if (head === 'main' || head === 'master') {
    if (git(['checkout', '-b', `sdlc/${slug}`]) === null) fail(`could not create branch sdlc/${slug}`)
  }
  const shipFile = path.join(CHANGES, slug, 'ship.json')
  fs.writeFileSync(shipFile, JSON.stringify({ at: now(), base, changed: r.changed.length, drift: [], matchRatio: 1 }, null, 2) + '\n')
  ensureGitignore()
  const changeDir = toPosix(path.relative(ROOT, path.join(CHANGES, slug)))
  clearState(slug)
  const extras = ['.sdlc/approvals.jsonl', '.sdlc/.gitignore', '.sdlc/STATE.md'].filter(f => exists(path.join(ROOT, f)))
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

const COMMANDS: Record<string, (args: Args) => void> = {
  init: cmdInit,
  new: cmdNew,
  activate: cmdActivate,
  status: cmdStatus,
  approve: cmdApprove,
  'scope-drift': cmdScopeDrift,
  ship: cmdShip,
  skill: cmdSkill,
  secrets: cmdSecrets,
  'log-usage': cmdLogUsage,
  hook: cmdHook,
  metrics: cmdMetrics,
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
  else fail(err instanceof Error ? err.stack ?? message : message)
}
