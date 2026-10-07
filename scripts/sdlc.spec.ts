// Tests for scripts/sdlc.ts. Run with: npm test (node --test scripts/*.spec.ts)
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { verified, ratcheted, buildDone } from './testkit.ts'

const SCRIPT = path.resolve(import.meta.dirname, 'sdlc.ts')
let repo: string

function run(args: string[], { input, env = {} }: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { cwd: repo, input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo, SDLC_HUMAN: '', ...env } })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

const hook = (name: string, payload: unknown) => run(['hook', name], { input: JSON.stringify(payload) })
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), text)
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })

const PLAN = `# Plan
## Approach
Small.
## Files
- src/app.js
- tests/**
## Slices
1. do it
## Verification
- npm test
`

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-test-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'Tester')
  write('README.md', 'hi\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

test('new creates intent and makes the change active; status prints next command', () => {
  assert.equal(run(['new', 'add-login', '--type', 'feature', '--tier', 'M']).code, 0)
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/changes/add-login/intent.md')))
  const status = run(['status']).stdout
  assert.match(status, /▶ add-login/)
  assert.match(status, /next: \/rig:design add-login/)
})

test('tier L plan needs approval; approval is human-only and goes stale on edit', () => {
  run(['new', 'add-login', '--type', 'refactor', '--tier', 'L'])
  write('.sdlc/changes/add-login/plan.md', PLAN)
  assert.match(run(['status']).stdout, /awaiting approval/)

  const byModel = run(['approve', 'add-login', 'plan'])
  assert.equal(byModel.code, 3)
  assert.match(byModel.stderr, /human-only/)

  assert.equal(run(['approve', 'add-login', 'plan'], { env: { SDLC_HUMAN: '1' } }).code, 0)
  assert.match(run(['status']).stdout, /next: \/rig:build add-login/)

  write('.sdlc/changes/add-login/plan.md', PLAN + '\n- extra\n')
  assert.match(run(['status']).stdout, /stale/)
})

test('new writes .sdlc/.gitignore even when .sdlc already exists', () => {
  fs.mkdirSync(path.join(repo, '.sdlc'))
  run(['new', 'x-change', '--type', 'chore', '--tier', 'S'])
  assert.equal(fs.readFileSync(path.join(repo, '.sdlc/.gitignore'), 'utf8'), 'usage.jsonl\n.baseline\n.gate\nunresolved.json\n')
})

test('tier S chore has no gates and skips spec and plan', () => {
  run(['new', 'bump-deps', '--type', 'chore', '--tier', 'S'])
  assert.match(run(['status']).stdout, /next: \/rig:build bump-deps/)
})

test('tier S feature reviews in session only where a PR review cannot run; a local-only change that gains an origin goes back to pr (resume)', () => {
  run(['new', 'tiny', '--type', 'feature', '--tier', 'S'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write('.sdlc/changes/tiny/plan.md', PLAN)
  write('.sdlc/changes/tiny/pr.md', '---\nstate: local-only\n---\n')
  git('add', '-A'); git('commit', '-qm', 'pr')
  assert.match(run(['status']).stdout, /next: \/rig:pr-review tiny/, 'no PR review workflow and no remote: review in session')
  write('.github/workflows/rig-review.yml', 'name: rig-review\n')
  assert.match(run(['status']).stdout, /next: \/rig:pr-review tiny/, 'a workflow without a remote still cannot review')
  git('remote', 'add', 'origin', 'https://example.com/x.git')
  assert.match(run(['status']).stdout, /next: \/rig:pr tiny/, 'a local-only change that gained an origin has no PR yet: pr resumes it (and CI then reviews, so no pr-review node)')
})

test('a legacy sdlc-review.yml workflow still counts as PR review being available', () => {
  run(['new', 'tiny', '--type', 'feature', '--tier', 'S'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write('.sdlc/changes/tiny/plan.md', PLAN)
  write('.sdlc/changes/tiny/pr.md', '---\nstate: opened\n---\n')
  write('.sdlc/changes/tiny/events.jsonl', JSON.stringify({ kind: 'pr', target: 'https://example.com/x/pull/1' }) + '\n')
  git('add', '-A'); git('commit', '-qm', 'pr')
  git('remote', 'add', 'origin', 'https://example.com/x.git')
  assert.match(run(['status']).stdout, /next: \/rig:pr-review tiny/, 'no review workflow: reviewed in session')
  write('.github/workflows/sdlc-review.yml', 'name: sdlc-review\n')
  assert.doesNotMatch(run(['status']).stdout, /next: \/rig:pr-review/, 'the legacy workflow reviews in CI, so the in-session node is dropped')
})

test('log-usage keeps the change and stage captured at turn start', () => {
  run(['new', 'a-change', '--type', 'feature', '--tier', 'M'])
  run(['log-usage', JSON.stringify({ kind: 'main', usd: 0.1, change: 'a-change', stage: 'intent' })])
  const row = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8').trim())
  assert.equal(row.stage, 'intent')
})

test('ship is done only once the scope record is committed', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  run(['scope-drift', 'tiny', '--record'])
  assert.match(run(['status']).stdout, /next: \/rig:pr tiny/)
  git('add', '-A')
  git('commit', '-qm', 'chore: tiny')
  assert.match(run(['status']).stdout, /done/)
})

test('scope-drift flags files outside plan ## Files and records ship.json', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'S'])
  write('.sdlc/changes/add-login/plan.md', PLAN)
  write('src/app.js', 'x\n')
  write('tests/app.test.js', 'x\n')
  assert.equal(run(['scope-drift', 'add-login']).code, 0)

  write('src/other.js', 'y\n')
  const r = run(['scope-drift', 'add-login', '--record'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /src\/other\.js/)
  const ship = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/add-login/ship.json'), 'utf8'))
  assert.deepEqual(ship.drift, ['src/other.js'])
})

test('hooks are silent in repos that never opted in', () => {
  assert.equal(hook('session-start', {}).stdout, '')
  assert.equal(hook('post-edit', { tool_input: { file_path: path.join(repo, 'src/x.js') } }).stdout, '')
  assert.equal(hook('stop', {}).stdout, '')
})

test('post-edit blocks secrets and code-heavy plans with exit 2', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'S'])
  write('src/config.js', 'const key = "AKIAABCDEFGHIJKLMNOP"\n')
  const secret = hook('post-edit', { tool_input: { file_path: path.join(repo, 'src/config.js') } })
  assert.equal(secret.code, 2)
  assert.match(secret.stderr, /AWS access key/)

  const code = '```js\n' + 'line\n'.repeat(15) + '```\n'
  write('.sdlc/changes/add-login/plan.md', PLAN + code)
  const plan = hook('post-edit', { tool_input: { file_path: path.join(repo, '.sdlc/changes/add-login/plan.md') } })
  assert.equal(plan.code, 2)
  assert.match(plan.stderr, /not implementation code/)
})

test('F1: a new change replaces the template STATE body; a written body is kept', () => {
  run(['init'])
  run(['new', 'first', '--type', 'chore', '--tier', 'S'])
  const state = fs.readFileSync(path.join(repo, '.sdlc/STATE.md'), 'utf8')
  assert.doesNotMatch(state, /No active change/)
  assert.match(state, /Active change: first/)
  const ctx = JSON.parse(hook('session-start', {}).stdout).hookSpecificOutput.additionalContext
  assert.doesNotMatch(ctx, /No active change/)
  fs.writeFileSync(path.join(repo, '.sdlc/STATE.md'), '---\nchange: first\n---\n# State\n\nslice 2 of 3 done\n')
  run(['new', 'second', '--type', 'chore', '--tier', 'S'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/STATE.md'), 'utf8'), /slice 2 of 3 done/)
})

test('session-start tells the model that sdlc routes work, not superpowers', () => {
  run(['init'])
  const ctx = JSON.parse(hook('session-start', {}).stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /use superpowers skills only when an sdlc skill names one/)
})

test('session-start injects the active change and next command', () => {
  run(['new', 'add-login', '--type', 'bugfix', '--tier', 'S'])
  const ctx = JSON.parse(hook('session-start', {}).stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /add-login/)
  assert.match(ctx, /\/rig:diagnose add-login/)
})

test('log-usage tags rows with the active change; metrics report cost and unmeasured samples', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'S'])
  run(['log-usage', JSON.stringify({ kind: 'main', model: 'claude-sonnet-5-5', in: 10, out: 100, cr: 1000, cw: 50, usd: 0.12, ctx: 160000 })])
  run(['log-usage', JSON.stringify({ kind: 'agent', agentType: 'implementer', model: 'claude-sonnet-5-5', in: 5, out: 50, cr: 500, cw: 20 })])
  const row = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8').split('\n')[0] ?? '{}')
  assert.equal(row.change, 'add-login')
  const m = JSON.parse(run(['metrics', '--json']).stdout).metrics
  assert.equal(m.cost.usd_total, 0.12)
  assert.equal(m.cost.turns_over_150k, 1)
  assert.ok(m.cost.tokens_by_agent_type.implementer > 0)
  assert.equal(m.first_pass_share.value, null)
})

test('metrics merge plugin and standalone agent names and ignore a negative cost delta from a reset ledger', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'S'])
  run(['log-usage', JSON.stringify({ kind: 'main', usd: 0.5 })])
  run(['log-usage', JSON.stringify({ kind: 'main', usd: -2.27 })])
  run(['log-usage', JSON.stringify({ kind: 'agent', agentType: 'rig:scout', in: 10 })])
  run(['log-usage', JSON.stringify({ kind: 'agent', agentType: 'rig-scout', in: 5 })])
  const cost = JSON.parse(run(['metrics', '--json']).stdout).metrics.cost
  assert.equal(cost.usd_total, 0.5)
  assert.deepEqual(cost.usd_by_change, { 'add-login': 0.5 })
  assert.deepEqual(cost.tokens_by_agent_type, { 'rig:scout': 15 })
})

test('status warns when there is no origin remote to open a PR on', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  assert.match(run(['status']).stdout, /warn: no origin remote/)
  git('remote', 'add', 'origin', 'https://example.com/x.git')
  assert.doesNotMatch(run(['status']).stdout, /no origin remote/)
})

test('skill prints a stage skill with plugin root and arguments substituted', () => {
  const r = run(['skill', 'test', 'add-login'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /# Test add-login/)
  assert.doesNotMatch(r.stdout, /\$\{CLAUDE_PLUGIN_ROOT\}/)
  assert.doesNotMatch(r.stdout, /^---\nname:/)
  assert.notEqual(run(['skill', 'no-such-skill']).code, 0)
})

test('run records exit codes; verify-report generates verification.md; a hand-written pass does not count', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  buildDone(repo, 'tiny')
  write('.sdlc/changes/tiny/verification.md', '---\nresult: pass\n---\n')
  assert.match(run(['status']).stdout, /next: \/rig:test tiny/)

  const red = run(['run', '--expect-fail', '--', 'node -e "process.exit(3)"'])
  assert.equal(red.code, 0)
  const TOGGLE = `node -e "process.exit(require('fs').existsSync('ok') ? 0 : 2)"`
  const bad = run(['run', '--', TOGGLE])
  assert.equal(bad.code, 2)
  const rows = fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/runs.jsonl'), 'utf8').trim().split('\n').map(r => JSON.parse(r))
  assert.deepEqual(rows.map(r => [r.exit, Boolean(r.expectFail)]), [[3, true], [2, false]])

  const report = () => fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8')
  run(['verify-report', 'tiny'])
  assert.match(report(), /result: fail/)
  run(['run', '--', 'node -e "process.exit(0)"'])
  run(['verify-report', 'tiny'])
  assert.match(report(), /result: fail/, 'a different passing command must not mask a failing one')

  write('ok', '1')
  run(['run', '--', TOGGLE])
  run(['verify-report', 'tiny'])
  assert.match(report(), /result: pass/)
  assert.match(run(['status']).stdout, /next: \/rig:sensors tiny/)

  run(['run', '--', 'node -e "process.exit(1)"'])
  assert.match(run(['status']).stdout, /next: \/rig:sensors tiny/, 'runs appended after the report do not invalidate it')
})

test('verification judges only the plan commands, ignoring gate rows and abandoned exploratory runs', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/**\n## Verification\n- `node -e "process.exit(0)"`\n')
  write('.sdlc/changes/tiny/runs.jsonl', JSON.stringify({ at: 'x', cmd: 'eslint .', exit: 1, ms: 1, tail: '', source: 'gate' }) + '\n')
  run(['run', '--', 'node -e "process.exit(4)"'])
  run(['verify-report', 'tiny'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8'), /result: fail[\s\S]*Not run/)
  run(['run', '--', 'node -e "process.exit(0)"'])
  run(['verify-report', 'tiny'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8'), /result: pass/)
})

test('a forged verification.md with runs: 0 does not make the change shippable', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  buildDone(repo, 'tiny')
  const digest = crypto.createHash('sha256').update('').digest('hex').slice(0, 16)
  write('.sdlc/changes/tiny/verification.md', `---\ngenerated: sdlc\nresult: pass\nruns: 0\ndigest: ${digest}\n---\n`)
  assert.match(run(['status']).stdout, /next: \/rig:test tiny/)
})

test('run rejects a slug with no change folder and creates nothing', () => {
  run(['init'])
  const r = run(['run', '--slug', 'nope', '--', 'node -e 0'])
  assert.notEqual(r.code, 0)
  assert.equal(fs.existsSync(path.join(repo, '.sdlc/changes/nope')), false)
})

test('a new intent has a Decisions section for explicit defaults', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'M'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/add-login/intent.md'), 'utf8'), /## Decisions\n<!-- skipped optional steps and defaults taken, one line each -->/)
})

test('metrics report rule fires, prune candidates and recurring review categories', () => {
  run(['new', 'a1', '--type', 'feature', '--tier', 'S'])
  write('.sdlc/rules.json', JSON.stringify([
    { id: 'no-print', pattern: 'print\\(', message: 'use the logger', why: 'stdout is the protocol', action: 'block' },
    { id: 'old-rule', pattern: 'never-matches-xyz', message: 'm', why: 'w', action: 'warn' },
  ]))
  write('.sdlc/changes/a1/review.md', '## Findings\n- [severity: medium] [category: coupling] a\n- [severity: medium] [category: coupling] b\n- [severity: high] [category: coupling] c\n')
  write('src/a.py', 'print("x")\nprint("y")\nprint("z")\n')
  write('.sdlc/usage.jsonl', JSON.stringify({ at: new Date().toISOString(), kind: 'event', event: 'skill-load-failed' }) + '\n')
  run(['check', '--at', 'ship'])
  const h = JSON.parse(run(['metrics', '--json']).stdout).metrics.harness
  assert.equal(h.rule_fires['no-print'], 1) // 3 matching lines, one fire
  assert.match(h.rule_suggestions.join('\n'), /coupling \(3 findings\)/)
  assert.ok(Array.isArray(h.prune_candidates))
  assert.equal(h.skill_load_failures, 1)
})

test('check --at ci logs no rule fires', () => {
  run(['init'])
  write('.sdlc/rules.json', JSON.stringify([{ id: 'no-print', pattern: 'print\\(', message: 'm', why: 'w', action: 'warn' }]))
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feat')
  write('src/a.py', 'print("x")\n')
  git('add', '-A')
  git('commit', '-qm', 'add')
  run(['check', '--at', 'ci', '--base', 'main'])
  const log = path.join(repo, '.sdlc/usage.jsonl')
  assert.equal(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('rule-fired'), false)
})

test('prune candidates are rules introduced over 90 days ago that never fired', () => {
  run(['init'])
  const rule = (id: string) => ({ id, pattern: `${id}-xyz`, message: 'm', why: 'w', action: 'warn' })
  const commit = (msg: string, date: string) => execFileSync('git', ['commit', '-qm', msg], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  write('.sdlc/rules.json', JSON.stringify([rule('old-rule')]))
  git('add', '-A')
  commit('old', new Date(Date.now() - 200 * 86_400_000).toISOString())
  write('.sdlc/rules.json', JSON.stringify([rule('old-rule'), rule('new-rule')]))
  git('add', '-A')
  commit('new', new Date().toISOString())
  const h = JSON.parse(run(['metrics', '--json']).stdout).metrics.harness
  assert.deepEqual(h.prune_candidates, ['old-rule'])
})

test('waive is human-only, records the waiver for the active change, and status reports sensors', () => {
  run(['new', 'xx', '--type', 'chore', '--tier', 'S'])
  assert.equal(run(['waive', 'size', '*', 'generated', 'file']).code, 3)
  assert.equal(run(['waive', 'size', '*', 'generated', 'file'], { env: { SDLC_HUMAN: '1' } }).code, 0)
  const w = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/waivers.jsonl'), 'utf8').trim())
  assert.deepEqual([w.slug, w.sensor, w.file, w.reason], ['xx', 'size', '*', 'generated file'])
  const s = JSON.parse(run(['status', '--json']).stdout).sensors
  assert.equal(s.waivers, 1)
  assert.match(run(['sensors']).stdout, /waivers \(xx\): size \* generated file/)
})

test('impact-status holds edits to consumer files while the impact is unapproved', () => {
  run(['new', 'rate', '--type', 'feature', '--tier', 'L'])
  write('.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: '../checkout' }] }))
  write('.sdlc/changes/rate/impact.json', JSON.stringify({ at: 'x', ids: ['discount_rate'], hits: [{ consumer: 'checkout', file: 'a', line: 1, id: 'discount_rate' }], missing: [] }))
  write('.sdlc/changes/rate/plan.md', '## Files\n- ../checkout/**\n')
  const consumerFile = path.join(path.dirname(repo), 'checkout', 'a.ts')
  assert.deepEqual(JSON.parse(run(['impact-status', consumerFile, '--json']).stdout), { hold: true, slug: 'rate', consumers: ['checkout'], hits: 1 })
  run(['approve', 'rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.equal(JSON.parse(run(['impact-status', consumerFile, '--json']).stdout).hold, false)
})

test('waive rejects an unknown sensor name', () => {
  run(['new', 'xx', '--type', 'chore', '--tier', 'S'])
  const r = run(['waive', 'nonsense', '*', 'because'], { env: { SDLC_HUMAN: '1' } })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /test-tamper/)
})

test('impact-status holds for a missing-only impact', () => {
  run(['new', 'rate', '--type', 'feature', '--tier', 'L'])
  write('.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: '../checkout' }] }))
  write('.sdlc/changes/rate/impact.json', JSON.stringify({ at: 'x', ids: ['discount_rate'], hits: [], missing: ['discount_rate'] }))
  assert.equal(JSON.parse(run(['impact-status', path.join(path.dirname(repo), 'checkout', 'a.ts'), '--json']).stdout).hold, true)
})

test('impact-status recognises a consumer declared with an absolute path', () => {
  run(['new', 'rate', '--type', 'feature', '--tier', 'L'])
  const consumerDir = path.join(path.dirname(repo), 'checkout')
  write('.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: consumerDir }] }))
  write('.sdlc/changes/rate/impact.json', JSON.stringify({ at: 'x', ids: ['d'], hits: [{ consumer: 'checkout', file: 'a', line: 1, id: 'd' }], missing: [] }))
  assert.equal(JSON.parse(run(['impact-status', path.join(consumerDir, 'a.ts'), '--json']).stdout).hold, true)
})

// Real artifacts from the 2026-10-03 live trial: the architect's labelled bullets and the runs the build agent recorded.
const TRIAL = path.resolve(import.meta.dirname, '../tests/fixtures/live-trial')
const reportFor = (verification: string, rows: object[]) => {
  if (!fs.existsSync(path.join(repo, '.sdlc/changes/tiny'))) run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write('.sdlc/changes/tiny/plan.md', `## Files\n- src/**\n${verification}`)
  write('.sdlc/changes/tiny/runs.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  run(['verify-report', 'tiny'])
  return fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8')
}
const ok = (cmd: string, extra: object = {}) => ({ at: 'x', cmd, exit: 0, ms: 1, tail: '', ...extra })

test('verify-report passes on the live trial plan: labelled bullets, prose notes and a red run (regression)', () => {
  const rows = fs.readFileSync(path.join(TRIAL, 'runs.jsonl'), 'utf8').trim().split('\n').map(r => JSON.parse(r))
  const text = reportFor(fs.readFileSync(path.join(TRIAL, 'plan-verification.md'), 'utf8'), rows)
  assert.match(text, /result: pass/)
  assert.doesNotMatch(text, /Not run/)
})

test('a labelled bullet "- Label: `cmd` prose" requires cmd, not the label or the prose', () => {
  const plan = '## Verification\n- Full suite: `npm test`, which runs `node --test`.\n'
  assert.match(reportFor(plan, []), /result: fail[\s\S]*Not run[\s\S]*- `npm test`/)
  assert.match(reportFor(plan, [ok('npm test')]), /result: pass/)
})

test('a prose bullet whose backticks are not in command position is not a required command', () => {
  const plan = '## Verification\n- `npm test`\n- Lint and type-check: none configured. `.sdlc/sensors.json` only defines `npm test`.\n'
  const text = reportFor(plan, [ok('npm test')])
  assert.match(text, /result: pass/)
  assert.doesNotMatch(text, /Not run/)
  assert.match(text, /## Ignored[\s\S]*sensors\.json/)
})

test('an expected-red bullet wrapping `sdlc.ts run --expect-fail` is not a required green command', () => {
  const plan = '## Verification\n- Red first: `sdlc.ts run --expect-fail -- "node --test a.js"`.\n- `npm test`\n'
  const text = reportFor(plan, [ok('npm test')])
  assert.match(text, /result: pass/)
  assert.doesNotMatch(text, /Not run/)
})

test('a bare-command bullet stays a command; a backtick-free "Label: prose" bullet does not', () => {
  assert.match(reportFor('## Verification\n- npm test\n', []), /Not run[\s\S]*- `npm test`/)
  const text = reportFor('## Verification\n- npm test\n- Lint: none configured\n', [ok('npm test')])
  assert.match(text, /result: pass/)
})

test('sdlc.ts run -- "cmd" is unwrapped to a required command; red runs and check bullets are skipped', () => {
  const plan = `## Verification\n- Suite: \`sdlc.ts run -- "npm test"\`\n- \`sdlc.ts run --expect-fail -- "node --test a.js"\`\n- Impact: \`sdlc.ts check --at plan\`\n`
  assert.match(reportFor(plan, []), /result: fail[\s\S]*Not run[\s\S]*- `npm test`/)
  const text = reportFor(plan, [ok('npm test')])
  assert.match(text, /result: pass/)
  assert.match(text, /## Ignored[\s\S]*expect-fail[\s\S]*check --at plan/)
})

test('a label containing backticks still yields the command after the first ": "', () => {
  const plan = '## Verification\n- Unit tests for `foo`: `npm test` (fast)\n- `npm run lint`\n'
  assert.match(reportFor(plan, [ok('npm run lint')]), /result: fail[\s\S]*Not run[\s\S]*- `npm test`/)
  assert.match(reportFor(plan, [ok('npm run lint'), ok('npm test')]), /result: pass/)
})

test('a section where every bullet is ignored fails instead of passing on an unrelated green run', () => {
  const plan = '## Verification\n- Unit: npm test\n- Lint: none configured\n'
  const text = reportFor(plan, [ok('node -e "1"')])
  assert.match(text, /result: fail/)
  assert.match(text, /## Ignored \(not commands; listed in plan ## Verification\)\n- Unit: npm test\n- Lint: none configured/)
  assert.match(text, /one leading backticked command per bullet/)
})

test('a plan with no ## Verification section keeps the all-runs fallback', () => {
  assert.match(reportFor('', [ok('npm test')]), /result: pass/)
})

test('I5: a v0.1 change whose ship.json is committed stays done and never becomes the active change', () => {
  run(['new', 'old-chore', '--type', 'chore', '--tier', 'S'])
  write('.sdlc/changes/old-chore/verification.md', '---\nresult: pass\n---\n# Verification\nAll green.\n')
  write('.sdlc/changes/old-chore/ship.json', '{ "at": "2026-01-01T00:00:00Z", "matchRatio": 1 }\n')
  write('.sdlc/STATE.md', '---\nchange: old-chore\n---\n# State\n')
  git('add', '-A')
  git('commit', '-qm', 'chore: old (v0.1)')
  const status = run(['status']).stdout
  assert.match(status, /old-chore\s+chore\s+S\s+done/)
  assert.doesNotMatch(status, /▶|next: /)
  hook('prompt-submit', {})
  write('src/new.js', 'export const n = 1\n')
  hook('stop', {})
  assert.match(run(['status']).stdout, /▶ adhoc-\d{8}-\d{4}/)
})

test('F5: a failing command that prints a key is recorded without the key', () => {
  run(['new', 'leak', '--type', 'chore', '--tier', 'S'])
  run(['run', '--slug', 'leak', '--', `node -e "console.log('AKIA'+'IOSFODNN7EXAMPLE'); process.exit(1)"`])
  const runs = fs.readFileSync(path.join(repo, '.sdlc/changes/leak/runs.jsonl'), 'utf8')
  assert.doesNotMatch(runs, /AKIA[0-9A-Z]{16}/)
  assert.match(runs, /masked by sdlc/)
})

test('F2: a tier L bugfix stops at a plan gate after diagnosis; S and M do not', () => {
  run(['new', 'big-bug', '--type', 'bugfix', '--tier', 'L'])
  assert.match(run(['status']).stdout, /next: \/rig:diagnose big-bug/)
  fs.writeFileSync(path.join(repo, '.sdlc/changes/big-bug/plan.md'), '# Plan\n\n## Files\n- src/a.js\n\n## Verification\n- `npm test`\n')
  assert.match(run(['status']).stdout, /human gate: review big-bug\/plan\.md, then run \/rig-approve big-bug plan/)
  run(['approve', 'big-bug', 'plan'], { env: { SDLC_HUMAN: '1' } })
  assert.match(run(['status']).stdout, /next: \/rig:diagnose big-bug/)
  run(['new', 'small-bug', '--type', 'bugfix', '--tier', 'M'])
  const st = JSON.parse(run(['status', '--json']).stdout) as { changes: { slug: string; command: string }[] }
  assert.equal(st.changes.find(c => c.slug === 'small-bug')?.command, '/rig:diagnose small-bug')
})

test('a spec or plan with unresolved open questions cannot be approved; resolved or defaulted ones can', () => {
  run(['new', 'qs', '--type', 'feature', '--tier', 'M'])
  write('.sdlc/changes/qs/plan.md', PLAN + '\n## Open questions\n- Q1 swap GET /todos in place or add /v2?\n')
  const refused = run(['approve', 'qs', 'plan'], { env: { SDLC_HUMAN: '1' } })
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /open question.*Q1 swap/s)
  write('.sdlc/changes/qs/plan.md', PLAN + '\n## Risks\n- Q1 is still open: confirm before Task 3.\n')
  assert.notEqual(run(['approve', 'qs', 'plan'], { env: { SDLC_HUMAN: '1' } }).code, 0, 'an open Q in prose also blocks')
  write('.sdlc/changes/qs/plan.md', PLAN + '\n## Open questions\nnone\n\n## Decisions\n- Q1 swap in place → yes (default)\n')
  assert.equal(run(['approve', 'qs', 'plan'], { env: { SDLC_HUMAN: '1' } }).code, 0)
})

test('lean S/M: a feature has one design gate and no review stage; a tier L refactor keeps the plan gate', () => {
  run(['new', 'mid', '--type', 'feature', '--tier', 'M'])
  write('.sdlc/changes/mid/plan.md', PLAN)
  assert.match(run(['status']).stdout, /human gate: review mid\/plan\.md/, 'a feature has one gate at design (plan.md for older changes)')
  write('.sdlc/changes/mid/design.md', PLAN)
  run(['approve', 'mid', 'design'], { env: { SDLC_HUMAN: '1' } })
  assert.match(run(['status']).stdout, /next: \/rig:build mid/)
  const st = JSON.parse(run(['status', '--json']).stdout) as { changes: { slug: string }[] }
  assert.ok(st.changes.some(c => c.slug === 'mid'))
  run(['new', 'big', '--type', 'refactor', '--tier', 'L'])
  write('.sdlc/changes/big/plan.md', PLAN)
  assert.match(run(['status']).stdout, /human gate: review big\/plan\.md/)
})

test('metrics report autonomy and economics from events and usage', () => {
  run(['new', 'aa', '--type', 'chore', '--tier', 'S'])
  run(['log-usage', JSON.stringify({ kind: 'main', usd: 1, change: 'aa', stage: 'build' })])
  const m = JSON.parse(run(['metrics', '--json']).stdout).metrics
  assert.ok('auto_approved_per_change' in m.autonomy)
  assert.ok('escalations_per_change' in m.autonomy)
  assert.equal(m.economics.usd_by_node.build, 1)
  assert.ok('value_over_cost' in m.economics)
  assert.equal(m.economics.value_is_estimate, true)
})

test('economics: ratios need a sample, are windowed to the same changes, and honour the value override', () => {
  run(['new', 'ch-0', '--type', 'chore', '--tier', 'S'])
  run(['log-usage', JSON.stringify({ kind: 'main', usd: 1, change: 'ch-0', stage: 'build', in: 3 })])
  const few = JSON.parse(run(['metrics', '--json']).stdout).metrics.economics
  assert.equal(few.usd_per_change, null)
  assert.equal(few.value_over_cost, null)
  for (let i = 1; i < 5; i++) {
    run(['new', `ch-${i}`, '--type', 'chore', '--tier', 'S'])
    run(['log-usage', JSON.stringify({ kind: 'main', usd: 1, change: `ch-${i}`, stage: 'build', in: 3 })])
  }
  run(['log-usage', JSON.stringify({ kind: 'main', usd: 100, change: 'gone', stage: 'build' })])
  write('.sdlc/changes/ch-0/plan.md', 'value_hours: 10 because it is big\n')
  const e = JSON.parse(run(['metrics', '--json']).stdout).metrics.economics
  assert.equal(e.usd_per_change, 1)
  assert.equal(e.value_over_cost, 360)
  assert.equal(e.tokens_by_node.build, 15 + 0)
})

test('status --json carries the active story and step for the mod', () => {
  run(['new', 'aa', '--type', 'chore', '--tier', 'S'])
  const s = JSON.parse(run(['status', '--json']).stdout)
  assert.equal(s.story.slug, 'aa')
  assert.equal(s.step.verdict, 'continue')
  assert.equal(s.step.node, 'build')
})

test('every slug-taking command refuses a path-like slug and writes nothing outside .sdlc/changes', () => {
  run(['init'])
  fs.mkdirSync(path.join(repo, '.sdlc/x'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.sdlc/changes/real-one'), { recursive: true })
  write('.sdlc/changes/real-one/intent.md', '---\ntype: feature\ntier: M\n---\n# real\n')
  const human = { SDLC_HUMAN: '1' }
  const cases: Array<[string[], Record<string, string>?]> = [
    [['check', '--at', 'stop', '--slug', '../../x']],
    [['check', '--at', 'plan', '--slug', '../x']],
    [['run', '--slug', '../x', '--', 'node -e 0']],
    [['verify-report', '../x']],
    [['activate', '..']],
    [['next', '../x']],
    [['approve', '../x', 'budget'], human],
    [['waive', 'rules', '*', 'why', '--slug', '../x'], human],
    [['new', '../x', '--type', 'feature', '--tier', 'M']],
    [['scope-drift', '../x']],
  ]
  for (const [args, env] of cases) {
    const r = run(args, { env })
    assert.notEqual(r.code, 0, `${args.join(' ')} must be refused`)
    assert.match(r.stderr, /invalid change name|no change named|usage/, args.join(' '))
  }
  assert.deepEqual(fs.readdirSync(path.join(repo, '.sdlc/x')), [], 'nothing written into the sibling directory')
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/waivers.jsonl')) || fs.readFileSync(path.join(repo, '.sdlc/waivers.jsonl'), 'utf8') === '')
})

test('status warns when a plan lists ** or * in ## Files, which makes the scope gate vacuous', () => {
  run(['new', 'wide', '--type', 'chore', '--tier', 'S'])
  write('.sdlc/changes/wide/plan.md', '## Files\n- src/app.js\n- **\n')
  assert.match(run(['status']).stdout, /warn: wide: .*"\*\*".*too broad/)
  write('.sdlc/changes/wide/plan.md', '## Files\n- `*`\n')
  assert.match(run(['status']).stdout, /warn: wide: .*"\*".*too broad/)
  write('.sdlc/changes/wide/plan.md', '## Files\n- src/**\n')
  assert.doesNotMatch(run(['status']).stdout, /too broad/)
})

test('init runs git init when the directory is not inside a repository, and leaves an existing repo alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-norepo-'))
  const init = (cwd: string) => spawnSync('node', ['--disable-warning=ExperimentalWarning', SCRIPT, 'init'], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } }).stdout
  assert.match(init(dir), /ran git init/)
  assert.ok(fs.existsSync(path.join(dir, '.git')))
  assert.doesNotMatch(init(repo), /ran git init/)
})

test('init --stack declares levels from the shipped template once, and never overwrites declared ones', () => {
  const init = (...a: string[]) => run(['init', ...a])
  write('package.json', '{ "type": "module" }\n')
  assert.match(init('--stack').stdout, /declared levels for node: unit=npm test, integration=npm test, acceptance=npm test, api=npm test/)
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8')) as { levels: Record<string, string>; fast: { test: string } }
  // every level a change can require is declared, so an endpoint change onboarded with --defaults never blocks on an undeclared api level
  assert.deepEqual(cfg.levels, { unit: 'npm test', integration: 'npm test', acceptance: 'npm test', api: 'npm test' })
  assert.equal(cfg.fast.test, 'npm test')
  fs.writeFileSync(path.join(repo, '.sdlc/sensors.json'), JSON.stringify({ ...cfg, levels: { unit: 'make t' } }))
  assert.match(init('--stack').stdout, /already declared/)
  assert.equal((JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8')) as typeof cfg).levels.unit, 'make t')
  assert.match(init('--stack', 'cobol').stdout, /no stack template for cobol/)
})

test('init --stack refuses once sensors.json is committed or a change exists', () => {
  write('package.json', '{ "type": "module" }\n')
  run(['init'])
  fs.writeFileSync(path.join(repo, '.sdlc/sensors.json'), JSON.stringify({ fast: { test: 'x' }, full: { test: 'x' } }))
  git('add', '.'); git('commit', '-qm', 'sensors')
  assert.match(run(['init', '--stack']).stdout, /is committed/)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8'))), ['fast', 'full'])
  git('rm', '-q', '--cached', '.sdlc/sensors.json'); git('commit', '-qm', 'untrack')
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const r = run(['init', '--stack'])
  assert.match(r.stdout, /a change already exists/, `${r.code} ${r.stderr}`)
})
