// The PR node: ship's gates, then pr.md, one commit, push of sdlc/<slug> only, and gh pr create. Plus follow-ups and CI checks.
// The model writes only the commit message; commit, push and PR are deterministic.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ROOT, CHANGES, SDLC, exists, read, git, gitIn, out, fail, now, optString, toPosix, defaultBase, scopeDrift, ensureGitignore, checkSlug,
  planFiles, isPlanned, type Args,
} from './core.ts'
import { loadChange, nextCommand, activeSlug, prRecorded, prDone } from './graph.ts'
import { loadConfig, runChecks } from './check.ts'
import { branchDiff, showAt } from './diffs.ts'
import { runCommand, recordRun } from './runs.ts'
import { formatFindings, SENSOR_NAMES, type SensorConfig } from './model.ts'
import { appendEvent, block, unblock, readRatchet } from './ratchet.ts'
import { renderScorecard } from './scorecard.ts'

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

// Another change's branch with commits of its own: a change started or shipped here would carry them into its PR.
export function otherChangeBranch(slug: string): string | null {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const base = defaultBase()
  if (!head?.startsWith('sdlc/') || head === `sdlc/${slug}` || !base || git(['rev-parse', 'HEAD']) === base) return null
  return `HEAD is on ${head}, which has commits not on the trunk; ${slug} would be stacked on them. `
    + `Move this change onto the trunk first: git stash -u && git checkout -b sdlc/${slug} ${base.slice(0, 12)} && git stash pop`
}

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

// Ships a change to its PR deterministically: preconditions, scope gate, branch, pr.md, one commit, push and gh pr create.
// --followup commits review fixes on the same branch instead. The model only writes the message.
export function cmdPr(args: Args): void {
  const slug = args.pos[0] ?? activeSlug()
  const message = optString(args, 'message')
  if (!slug) fail('usage: pr <slug> --message "<conventional commit message>" [--followup]')
  checkSlug(slug)
  if (!message) fail('pr needs --message "<type(scope): summary>"')
  if (args.opt.followup) return followup(slug, message)
  const change = loadChange(slug)
  const pending = change.stages.filter(s => s !== 'pr' && !(change.next && change.stages.indexOf(s) < change.stages.indexOf(change.next.stage)))
  if (change.next && change.next.stage !== 'pr') fail(`not ready to ship (pr): next is ${nextCommand(change)} (pending: ${pending.join(', ')})`)
  if (!change.next) return out(`${slug} is already shipped`)

  if (prRecorded(slug)) return resume(slug, message)
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const stacked = otherChangeBranch(slug)
  if (stacked) fail(`not shipping: ${stacked}`)
  const base = defaultBase() ?? (head && ['main', 'master'].includes(head) ? git(['rev-parse', 'HEAD']) : null)
  const r = scopeDrift(slug, base)
  if (r.drift.length) fail(`scope drift, not shipping. Out-of-plan files:\n${r.drift.map(f => '  ' + f).join('\n')}\nAdd them to plan.md ## Files (and re-approve if gated) or revert them.`)
  const { config, rules, errors } = loadConfig()
  const sensorsBefore = read(path.join(SDLC, 'sensors.json'))
  const gate = runChecks({ point: 'ship', diffs: branchDiff(base ?? 'HEAD'), config, rules, slugs: [slug], commands: 'full', budgetMs: 1_800_000, before: f => showAt(base ?? 'HEAD', f) ?? '', base, ratchet: true })
  const ratcheted = read(path.join(SDLC, 'sensors.json')) !== sensorsBefore
  if (errors.length || gate.blocks.length) {
    const configFindings = errors.map(e => `[config] ${e}`)
    const waives = [...new Set(gate.blocks.filter(f => SENSOR_NAMES.includes(f.sensor)).map(f => `/sdlc-waive ${f.sensor} ${f.file ?? '*'} <reason>`))]
    const summary = [...configFindings, ...gate.blocks.map(f => `${f.sensor}${f.file ? ` ${f.file}` : ''}: ${f.message}`)].join('; ').replace(/\s+/g, ' ').slice(0, 400)
    block(slug, 'pr', waives.length && !errors.length ? `the ship gate refused; a person waives with ${waives.join(' ; ')}, or fix: ${summary}` : `fix: ${summary}`)
    fail(`not shipping: the ship gate found problems\n${[...configFindings, formatFindings(gate.findings)].filter(Boolean).join('\n')}\nFix them (one implementer round), or the person waives with /sdlc-waive <sensor> <file|*> <reason>.`)
  }

  if (readRatchet(slug).blocked?.node === 'pr' && /^(?:the ship gate refused|fix: )/.test(readRatchet(slug).blocked?.reason ?? '')) unblock(slug, 'ship gate passed')
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
  const branch = `sdlc/${slug}`
  const remote = git(['remote', 'get-url', 'origin']) !== null
  if (remote && git(['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) fail(`not shipping: only ${branch} is pushed and HEAD is ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}; nothing was committed`)
  const title = (message.split('\n')[0] ?? slug).slice(0, 200)
  // pr.md is evidence (written only here) and lands in the same commit as ship.json: a committed ship.json alone reads as a v0.1 change, done.
  fs.writeFileSync(path.join(CHANGES, slug, 'pr.md'), `---\nstate: ${remote ? 'open' : 'local-only'}\nbranch: ${branch}\n---\n${title}\n\n${renderScorecard(slug)}`)
  // Without a remote the event is complete now, so it lands in the commit; with one it needs the PR url, after the push.
  if (!remote) appendEvent(slug, { node: 'pr', verdict: 'done', kind: 'pr', target: 'local-only' })
  record()
  ensureGitignore()
  const changeDir = toPosix(path.relative(ROOT, path.join(CHANGES, slug)))
  const extras = ['.sdlc/approvals.jsonl', '.sdlc/waivers.jsonl', '.sdlc/.gitignore', '.sdlc/STATE.md', '.sdlc/guides', ...(ratcheted ? ['.sdlc/sensors.json'] : [])].filter(f => exists(path.join(ROOT, f)))
  const code = r.changed.filter(f => !f.startsWith('.sdlc/'))
  if (git(['add', '--', changeDir, ...extras, ...code]) === null) fail('git add failed')
  if (git(['commit', '-q', '-m', message]) === null) fail('git commit failed (nothing staged, or a commit hook refused it)')
  let target = 'local-only'
  if (remote) {
    // Only sdlc/<slug> is ever pushed: never the trunk, never forced.
    if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) { block(slug, 'pr', `HEAD is not ${branch}; not pushing`); fail(`not pushing: HEAD is not ${branch} (blocked)`) }
    if (git(['push', '-u', 'origin', branch]) === null) { block(slug, 'pr', 'git push failed'); fail('pushed nothing: git push failed (blocked)') }
    target = openPr(slug, title)
  }
  out(`pr ${slug} on ${git(['rev-parse', '--abbrev-ref', 'HEAD'])} at ${git(['rev-parse', '--short', 'HEAD'])}: ${code.length} code file(s) + artifacts; ${remote ? `PR ${target}` : 'no origin remote, local only'}. The change stays active for pr-review.`)
}

const ghLast = (text: string): string => text.trim().split('\n').at(-1) ?? ''
const URL_RE = /^https?:\/\//

// gh pr create; records the pr event only for a real URL. Anything else blocks with the manual command.
function openPr(slug: string, title: string): string {
  const file = toPosix(path.relative(ROOT, path.join(CHANGES, slug, 'pr.md')))
  const body = path.join(CHANGES, slug, 'pr.md')
  let url = ''
  try { url = ghLast(execFileSync('gh', ['pr', 'create', '--title', title, '--body-file', body], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) } catch (e) {
    const x = e as { stdout?: unknown; stderr?: unknown }
    // The PR already exists (a rerun, or opened by hand): record its url instead of blocking.
    if (/already exists/i.test(`${String(x.stdout ?? '')}${String(x.stderr ?? '')}`)) url = ghLast(ghRun(['pr', 'view', `sdlc/${slug}`, '--json', 'url', '-q', '.url']) ?? '')
  }
  if (!URL_RE.test(url)) {
    block(slug, 'pr', `the branch is pushed but gh pr create printed no PR url; run: gh pr create --title ${JSON.stringify(title)} --body-file ${file}, or rerun sdlc.ts pr ${slug} --message ...`)
    fail('the branch is pushed but gh pr create failed (blocked)')
  }
  appendEvent(slug, { node: 'pr', verdict: 'done', kind: 'pr', target: url })
  return url
}

// pr.md is committed but no PR was recorded (gh failed after the push): finish the push and the PR, never a second commit.
function resume(slug: string, message: string): void {
  const branch = `sdlc/${slug}`
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== branch) fail(`resuming ${slug} needs HEAD on ${branch}`)
  if (git(['remote', 'get-url', 'origin']) === null) fail(`cannot resume ${slug}: no origin remote`)
  if (git(['push', '-u', 'origin', branch]) === null) { block(slug, 'pr', 'git push failed'); fail('git push failed (blocked)') }
  const url = openPr(slug, (message.split('\n')[0] ?? slug).slice(0, 200))
  unblock(slug, 'pr created')
  out(`resumed ${slug}: PR ${url}`)
}

function ghRun(argv: string[], keepStdoutOnFailure = false): string | null {
  try { return execFileSync('gh', argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) {
    // gh pr checks exits non-zero for failing or pending checks but still prints the JSON.
    const stdout = (e as { stdout?: unknown }).stdout
    return keepStdoutOnFailure && typeof stdout === 'string' && stdout.trim() ? stdout : null
  }
}

function followup(slug: string, message: string): void {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!prDone(slug)) fail(`no follow-up yet: the pr node of ${slug} is not done (run pr ${slug} --message ... first)`)
  if (head !== `sdlc/${slug}`) fail(`follow-ups go on sdlc/${slug}; HEAD is ${head}`)
  const r = scopeDrift(slug, defaultBase())
  if (r.drift.length) fail(`scope drift, not committing: ${r.drift.join(', ')}`)
  const code = r.changed.filter(f => !f.startsWith('.sdlc/'))
  if (git(['add', '--', toPosix(path.relative(ROOT, path.join(CHANGES, slug))), ...code]) === null) fail('git add failed')
  if (git(['commit', '-q', '-m', message]) === null) fail('git commit failed (nothing staged, or a commit hook refused it)')
  if (git(['remote', 'get-url', 'origin']) !== null && git(['push', 'origin', `sdlc/${slug}`]) === null) { block(slug, 'pr-review', 'git push of the follow-up failed'); fail('push failed (blocked)') }
  out(`follow-up committed on sdlc/${slug} at ${git(['rev-parse', '--short', 'HEAD'])}`)
}

// Fails closed: only known-good states pass; unknown states, no checks or unparseable output never read as pass.
const OK = /^(SUCCESS|SKIPPED|NEUTRAL)$/i
const PENDING = /^(PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING|REQUESTED)$/i
export const checksVerdict = (states: string[] | null): string =>
  states === null || states.length === 0 ? 'unknown' : states.some(s => PENDING.test(s)) ? 'pending' : states.every(s => OK.test(s)) ? 'pass' : 'fail'

export function cmdPrChecks(args: Args): void {
  const slug = args.pos[0]
  if (!slug) fail('usage: pr-checks <slug>')
  checkSlug(slug)
  if (git(['remote', 'get-url', 'origin']) === null) { appendEvent(slug, { node: 'pr-review', verdict: 'local-only', kind: 'checks' }); return out('checks: local-only (no origin remote)') }
  const raw = ghRun(['pr', 'checks', `sdlc/${slug}`, '--json', 'state'], true)
  let states: string[] | null = null
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (Array.isArray(parsed)) states = parsed.map(s => String((s as { state?: unknown } | null)?.state ?? ''))
  } catch { /* unparseable output stays unknown */ }
  const workflows = exists(path.join(ROOT, '.github/workflows')) && fs.readdirSync(path.join(ROOT, '.github/workflows')).some(f => /\.ya?ml$/.test(f))
  const verdict = states?.length === 0 ? (workflows ? 'pending' : 'no-ci') : checksVerdict(states)
  appendEvent(slug, { node: 'pr-review', verdict, kind: 'checks' })
  out(`checks: ${verdict}`)
  if (verdict === 'fail') process.exitCode = 2
}
