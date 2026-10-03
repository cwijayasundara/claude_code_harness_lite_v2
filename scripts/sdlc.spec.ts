// Tests for scripts/sdlc.ts. Run with: npm test (node --test scripts/*.spec.ts)
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { verified } from './testkit.ts'

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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-test-'))
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
  assert.match(status, /next: \/sdlc:plan add-login/)
})

test('tier M feature needs plan approval; approval is human-only and goes stale on edit', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'M'])
  write('.sdlc/changes/add-login/plan.md', PLAN)
  assert.match(run(['status']).stdout, /awaiting approval/)

  const byModel = run(['approve', 'add-login', 'plan'])
  assert.equal(byModel.code, 3)
  assert.match(byModel.stderr, /human-only/)

  assert.equal(run(['approve', 'add-login', 'plan'], { env: { SDLC_HUMAN: '1' } }).code, 0)
  assert.match(run(['status']).stdout, /next: \/sdlc:build add-login/)

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
  assert.match(run(['status']).stdout, /next: \/sdlc:build bump-deps/)
})

test('tier S feature is the fast path: plan, build, verify, ship with no review stage', () => {
  run(['new', 'tiny', '--type', 'feature', '--tier', 'S'])
  verified(repo, 'tiny')
  write('.sdlc/changes/tiny/plan.md', PLAN)
  assert.match(run(['status']).stdout, /next: \/sdlc:ship tiny/)
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
  run(['scope-drift', 'tiny', '--record'])
  assert.match(run(['status']).stdout, /next: \/sdlc:ship tiny/)
  git('add', '-A')
  git('commit', '-qm', 'chore: tiny')
  assert.match(run(['status']).stdout, /done/)
})

test('ship commits code plus artifacts on a branch', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  write('src/app.js', 'x\n')
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n## Verification\n- npm test\n')
  assert.match(run(['status']).stdout, /next: \/sdlc:ship tiny/)
  const shipped = run(['ship', 'tiny', '--message', 'chore: tiny'])
  assert.equal(shipped.code, 0, shipped.stderr)
  assert.match(shipped.stdout, /sdlc\/tiny/)
  const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  assert.match(files, /src\/app\.js/)
  assert.match(files, /\.sdlc\/changes\/tiny\/verification\.md/)
  assert.doesNotMatch(files, /usage\.jsonl/)
  assert.match(run(['status']).stdout, /done/)
})

test('ship refuses scope drift and unfinished changes', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  assert.match(run(['ship', 'tiny', '--message', 'chore: x']).stderr, /not ready to ship/)
  verified(repo, 'tiny')
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  write('src/other.js', 'y\n')
  const r = run(['ship', 'tiny', '--message', 'chore: x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /scope drift/)
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

test('pre-bash hook denies model approvals and long sleeps, allows normal commands', () => {
  run(['init'])
  const approve = JSON.parse(hook('pre-bash', { tool_input: { command: 'node /x/scripts/sdlc.ts approve a plan' } }).stdout)
  assert.equal(approve.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(hook('pre-bash', { tool_input: { command: 'git add src/a.js .sdlc/approvals.jsonl && git commit -m "feat: x"' } }).stdout, '')
  assert.equal(hook('pre-bash', { tool_input: { command: 'cat .sdlc/approvals.jsonl' } }).stdout, '')
  const redirect = JSON.parse(hook('pre-bash', { tool_input: { command: 'echo {} >> .sdlc/approvals.jsonl' } }).stdout)
  assert.equal(redirect.hookSpecificOutput.permissionDecision, 'deny')
  const restore = JSON.parse(hook('pre-bash', { tool_input: { command: 'git checkout -- .sdlc/approvals.jsonl' } }).stdout)
  assert.equal(restore.hookSpecificOutput.permissionDecision, 'deny')
  const forged = JSON.parse(hook('pre-bash', { tool_input: { command: `python3 -c "open('.sdlc/approvals.jsonl','a').write('x')"` } }).stdout)
  assert.equal(forged.hookSpecificOutput.permissionDecision, 'deny')
  const sleep = JSON.parse(hook('pre-bash', { tool_input: { command: 'sleep 120 && cat out.log' } }).stdout)
  assert.equal(sleep.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(hook('pre-bash', { tool_input: { command: 'sleep 2' } }).stdout, '')
  assert.equal(hook('pre-bash', { tool_input: { command: 'npm test' } }).stdout, '')
})

test('hooks are silent in repos that never opted in', () => {
  assert.equal(hook('pre-bash', { tool_input: { command: 'sleep 300' } }).stdout, '')
  assert.equal(hook('session-start', {}).stdout, '')
  assert.equal(hook('pre-edit', { tool_input: { file_path: path.join(repo, 'src/x.js') } }).stdout, '')
})

test('pre-edit asks for files outside the plan during build and denies approvals.jsonl', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'S'])
  write('.sdlc/changes/add-login/plan.md', PLAN)
  const outside = JSON.parse(hook('pre-edit', { tool_input: { file_path: path.join(repo, 'src/other.js') } }).stdout)
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'ask')
  assert.equal(hook('pre-edit', { tool_input: { file_path: path.join(repo, 'src/app.js') } }).stdout, '')
  const approvals = JSON.parse(hook('pre-edit', { tool_input: { file_path: path.join(repo, '.sdlc/approvals.jsonl') } }).stdout)
  assert.equal(approvals.hookSpecificOutput.permissionDecision, 'deny')
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

test('session-start injects the active change and next command', () => {
  run(['new', 'add-login', '--type', 'bugfix', '--tier', 'S'])
  const ctx = JSON.parse(hook('session-start', {}).stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /add-login/)
  assert.match(ctx, /\/sdlc:diagnose add-login/)
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

test('ship clears STATE.md, stages it and .sdlc/.gitignore, and leaves no active change', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  write('src/app.js', 'x\n')
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n## Verification\n- npm test\n')
  const shipped = run(['ship', 'tiny', '--message', 'chore: tiny'])
  assert.equal(shipped.code, 0, shipped.stderr)
  const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  assert.match(files, /\.sdlc\/STATE\.md/)
  assert.match(files, /\.sdlc\/\.gitignore/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/STATE.md'), 'utf8'), /No active change\. Last shipped: tiny\./)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '')
  assert.doesNotMatch(run(['status']).stdout, /next: /)
})

test('activeSlug never falls back to a finished change', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  write('src/app.js', 'x\n')
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  run(['ship', 'tiny', '--message', 'chore: tiny'])
  fs.rmSync(path.join(repo, '.sdlc/STATE.md'))
  assert.doesNotMatch(run(['status']).stdout, /▶ tiny/)
})

test('skill prints a stage skill with plugin root and arguments substituted', () => {
  const r = run(['skill', 'verify', 'add-login'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /# Verify add-login/)
  assert.doesNotMatch(r.stdout, /\$\{CLAUDE_PLUGIN_ROOT\}/)
  assert.doesNotMatch(r.stdout, /^---\nname:/)
  assert.notEqual(run(['skill', 'no-such-skill']).code, 0)
})

test('run records exit codes; verify-report generates verification.md; a hand-written pass does not count', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write('.sdlc/changes/tiny/verification.md', '---\nresult: pass\n---\n')
  assert.match(run(['status']).stdout, /next: \/sdlc:verify tiny/)

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
  assert.match(run(['status']).stdout, /next: \/sdlc:ship tiny/)

  run(['run', '--', 'node -e "process.exit(1)"'])
  assert.match(run(['status']).stdout, /next: \/sdlc:ship tiny/, 'runs appended after the report do not invalidate it')
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
  const digest = crypto.createHash('sha256').update('').digest('hex').slice(0, 16)
  write('.sdlc/changes/tiny/verification.md', `---\ngenerated: sdlc\nresult: pass\nruns: 0\ndigest: ${digest}\n---\n`)
  assert.match(run(['status']).stdout, /next: \/sdlc:verify tiny/)
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

test('impact-status holds for a missing-only impact and for an absolute consumer path', () => {
  run(['new', 'rate', '--type', 'feature', '--tier', 'L'])
  const consumerDir = path.join(path.dirname(repo), 'checkout')
  write('.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: consumerDir }] }))
  write('.sdlc/changes/rate/impact.json', JSON.stringify({ at: 'x', ids: ['discount_rate'], hits: [], missing: ['discount_rate'] }))
  const r = JSON.parse(run(['impact-status', path.join(consumerDir, 'a.ts'), '--json']).stdout)
  assert.equal(r.hold, true)
})
