// Integration: baselines and diffs, sdlc check at each point, ship verdicts. Each test gets a fresh temp repo.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, 'src/app.js', 'export const a = 1\n')
  write(repo, 'notes.txt', 'untracked before the turn\n')
  gitIn(repo, 'add', 'src/app.js')
  gitIn(repo, 'commit', '-qm', 'app')
})

const turnFiles = () => JSON.parse(sdlc(repo, ['diff', '--turn', '--json']).stdout).map((d: { file: string; status: string }) => `${d.status} ${d.file}`).sort()

test('the turn diff holds tracked edits, Bash-style writes and new untracked files, not older untracked ones', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 2\n')
  fs.appendFileSync(path.join(repo, 'src/app.js'), '// via sed\n')
  write(repo, 'src/new.js', 'export const b = 1\n')
  assert.deepEqual(turnFiles(), ['A src/new.js', 'M src/app.js'])
})

test('an untracked file changed during the turn counts; a staged-only change counts', () => {
  hook(repo, 'prompt-submit', {})
  fs.appendFileSync(path.join(repo, 'notes.txt'), 'edited\n')
  write(repo, 'src/app.js', 'export const a = 3\n')
  gitIn(repo, 'add', 'src/app.js')
  assert.deepEqual(turnFiles(), ['A notes.txt', 'M src/app.js'])
})

test('an untracked .sdlc/sensors.json created during the turn appears in the turn diff', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', '{"ignore":["**"]}\n')
  assert.ok(turnFiles().includes('A .sdlc/sensors.json'))
})

test('a diff over 1 MB is parsed, not silently empty', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/big.js', Array.from({ length: 80_000 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  gitIn(repo, 'add', 'src/big.js')
  const diffs = JSON.parse(sdlc(repo, ['diff', '--turn', '--json']).stdout)
  assert.equal(diffs.find((d: { file: string }) => d.file === 'src/big.js')?.added.length, 80_000)
})

test('the branch diff covers commits since the merge-base plus the working tree', () => {
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, 'src/app.js', 'export const a = 4\n')
  gitIn(repo, 'commit', '-qam', 'wip')
  write(repo, 'src/later.js', 'x\n')
  const files = JSON.parse(sdlc(repo, ['diff', '--base', 'main', '--json']).stdout).map((d: { file: string }) => d.file).filter((f: string) => !f.startsWith('.sdlc/')).sort()
  assert.deepEqual(files, ['notes.txt', 'src/app.js', 'src/later.js'])
})

test('no commits yet: prompt-submit is silent and writes no baseline', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bare-'))
  gitIn(bare, 'init', '-q')
  sdlc(bare, ['init'])
  const r = hook(bare, 'prompt-submit', {})
  assert.deepEqual([r.code, r.stdout], [0, ''])
  assert.ok(!fs.existsSync(path.join(bare, '.sdlc/.baseline')))
})

test('an edit made before the turn is not blamed on it, even with no git identity configured', () => {
  gitIn(repo, 'config', 'user.name', '')
  gitIn(repo, 'config', 'user.email', '')
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  write(repo, 'src/app.js', 'export const a = 9\n')
  sdlc(repo, ['hook', 'prompt-submit'], { input: '{}', env })
  write(repo, 'src/other.js', 'y\n')
  const r = sdlc(repo, ['diff', '--turn', '--json'], { env })
  assert.deepEqual(JSON.parse(r.stdout).map((d: { file: string }) => d.file), ['src/other.js'])
})

test('diff --turn without a baseline says so instead of diffing against now', () => {
  const r = sdlc(repo, ['diff', '--turn'])
  assert.deepEqual([r.code, r.stdout.trim()], [0, 'no turn baseline yet (run a prompt first)'])
})

const sensors = (cfg: object) => write(repo, '.sdlc/sensors.json', JSON.stringify(cfg, null, 2) + '\n')
const check = (...args: string[]) => sdlc(repo, ['check', ...args])

test('check is silent-success: one pass line, exit 0', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 5\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^sdlc check stop: pass/)
})

test('a failing fast command blocks with its output tail; a passing one is silent', () => {
  sensors({ fast: { lint: 'node -e "console.log(\'src/app.js:1 no-var\'); process.exit(1)"', test: 'node -e "process.exit(0)"' } })
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'var a = 5\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[commands\]/)
  assert.match(r.stdout, /fast\.lint failed \(exit 1\)/)
  assert.match(r.stdout, /src\/app\.js:1 no-var/)
  assert.doesNotMatch(r.stdout, /fast\.test/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/xx/runs.jsonl'), 'utf8'), /fast|no-var|process\.exit/)
})

test('a hanging command, and a grandchild holding its output, time out inside the budget and count as a failure', () => {
  sensors({ fast: { test: `node -e "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }); setTimeout(() => {}, 20000)"` } })
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 6\n')
  const started = Date.now()
  const r = check('--at', 'stop', '--budget-ms', '1500')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /timed out/)
  assert.ok(Date.now() - started < 10_000)
})

test('known-red commands warn instead of block, and the ratchet removes them once green', () => {
  sensors({ fast: { lint: 'node -e "process.exit(1)"' }, knownRed: ['fast.lint'] })
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 7\n')
  const red = check('--at', 'stop')
  assert.equal(red.code, 0)
  assert.match(red.stdout, /warn: \d+ \(.*commands 1/)
  sensors({ fast: { lint: 'node -e "process.exit(0)"' }, knownRed: ['fast.lint'] })
  check('--at', 'stop')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8')).knownRed, [])
})

test('an invalid sensors.json blocks with the parse error', () => {
  write(repo, '.sdlc/sensors.json', '{ "limits": { "fileLines": "big" } }')
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 8\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[config\][\s\S]*limits\.fileLines must be a positive number/)
})

test('a human waiver for the active change drops the matching finding', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 9 // eslint-disable-line\n')
  assert.equal(check('--at', 'stop').code, 1)
  write(repo, '.sdlc/waivers.jsonl', JSON.stringify({ slug: 'xx', sensor: 'suppression', file: 'src/app.js', reason: 'generated file', by: 'p', at: 'now' }) + '\n')
  assert.equal(check('--at', 'stop').code, 0)
})

test('check-file reports a single file\'s cheap sensors as JSON', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'test/a.test.js', "it.only('x', () => {})\n")
  const r = JSON.parse(sdlc(repo, ['check-file', 'test/a.test.js', '--json']).stdout)
  assert.equal(r[0].sensor, 'test-tamper')
})

test('an unknown --config-from ref blocks instead of falling back to defaults', () => {
  const r = check('--at', 'ci', '--base', 'main', '--config-from', 'no-such-ref')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[config\]/)
  assert.match(r.stdout, /does not exist/)
})

test('ci with a base-branch config never ratchets sensors.json or records runs', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  sensors({ fast: {}, full: { t: 'node -e "process.exit(0)"' }, knownRed: ['full.t'] })
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'cfg')
  const file = path.join(repo, '.sdlc/sensors.json')
  const before = fs.readFileSync(file, 'utf8')
  const r = check('--at', 'ci', '--base', 'main', '--config-from', 'main')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(fs.existsSync(path.join(repo, '.sdlc/changes/xx/runs.jsonl')), false)
})

test('a known-red command that times out still blocks', () => {
  sensors({ fast: { t: 'node -e "setTimeout(() => {}, 20000)"' }, knownRed: ['fast.t'] })
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 11\n')
  assert.equal(check('--at', 'stop', '--budget-ms', '1000').code, 1)
})

test('a non-numeric --budget-ms is a usage error', () => {
  hook(repo, 'prompt-submit', {})
  const r = check('--at', 'stop', '--budget-ms', 'soon')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /budget-ms/)
})

function consumerRepo(name: string, file: string, text: string): string {
  const dir = path.join(path.dirname(repo), `${path.basename(repo)}-${name}`)
  fs.mkdirSync(dir)
  gitIn(dir, 'init', '-q', '-b', 'main')
  gitIn(dir, 'config', 'user.email', 't@example.com')
  gitIn(dir, 'config', 'user.name', 'Tester')
  write(dir, file, text)
  gitIn(dir, 'add', '.')
  gitIn(dir, 'commit', '-qm', 'init')
  return path.relative(repo, dir).split(path.sep).join('/')
}

test('Stop blocks a contract rename that a consumer still uses, naming file:line', () => {
  const rel = consumerRepo('checkout', 'src/cart.ts', 'const r = order.discount_rate\n')
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(0)"' }] })
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (discount_rate NUMERIC);\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'schema')
  hook(repo, 'prompt-submit', {})
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (promotional_discount NUMERIC);\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[contract-impact\][\s\S]*checkout-service: src\/cart\.ts:1 still uses discount_rate/)
  assert.match(r.stdout, /run \/sdlc:start/)
})

test('the plan point records impact, escalates to tier L and requires the impact approval', () => {
  const rel = consumerRepo('invoicing', 'src/invoice.py', 'rate = row["discount_rate"]\n')
  sensors({ consumers: [{ name: 'invoicing-service', path: rel }] })
  sdlc(repo, ['new', 'rename-rate', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/rename-rate/plan.md', '## Files\n- schema/**\n## Contracts\n- rename `discount_rate` → `promotional_discount`\n## Verification\n- npm test\n')
  const r = check('--at', 'plan', '--slug', 'rename-rate')
  assert.match(r.stdout, /1 consumer reference/)
  const impact = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/rename-rate/impact.json'), 'utf8'))
  assert.equal(impact.hits[0].file, 'src/invoice.py')
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/rename-rate/intent.md'), 'utf8'), /tier: L/)
  write(repo, '.sdlc/changes/rename-rate/spec.md', '## Behaviours\nB1 rename\n')
  sdlc(repo, ['approve', 'rename-rate', 'spec'], { env: { SDLC_HUMAN: '1' } })
  sdlc(repo, ['approve', 'rename-rate', 'plan'], { env: { SDLC_HUMAN: '1' } })
  assert.match(sdlc(repo, ['status']).stdout, /\/sdlc-approve rename-rate impact/)
  sdlc(repo, ['approve', 'rename-rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.match(sdlc(repo, ['status']).stdout, /next: \/sdlc:build rename-rate/)
})

test('a declared consumer that is not checked out warns at Stop and blocks at ship and CI', () => {
  sensors({ consumers: [{ name: 'ghost', path: '../does-not-exist' }] })
  write(repo, 'schema/a.sql', 'x_col INT;\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'schema')
  hook(repo, 'prompt-submit', {})
  write(repo, 'schema/a.sql', 'y_col INT;\n')
  assert.equal(check('--at', 'stop').code, 0)
  assert.equal(check('--at', 'ship').code, 1)
})

function stopWithRename(oldCol: string, newCol: string): void {
  write(repo, 'schema/billing.sql', `CREATE TABLE billing (${oldCol} NUMERIC);\n`)
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'schema')
  hook(repo, 'prompt-submit', {})
  write(repo, 'schema/billing.sql', `CREATE TABLE billing (${newCol} NUMERIC);\n`)
}

test('a consumer directory that is not a git repo cannot be verified: blocks at ship', () => {
  const dir = path.join(path.dirname(repo), `${path.basename(repo)}-plain`)
  fs.mkdirSync(dir)
  write(dir, 'a.ts', 'x\n')
  sensors({ consumers: [{ name: 'plain', path: path.relative(repo, dir).split(path.sep).join('/') }] })
  stopWithRename('x_col', 'y_col')
  const r = check('--at', 'ship')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /plain is not checked out/)
})

test('untracked consumer files count, and a migration history does not hide the rename', () => {
  const rel = consumerRepo('untr', 'README.md', 'nothing\n')
  write(path.resolve(repo, rel), 'src/new.ts', 'use(discount_rate)\n')
  sensors({ consumers: [{ name: 'untr', path: rel }] })
  write(repo, 'migrations/0001_init.sql', 'CREATE TABLE billing (discount_rate NUMERIC);\n')
  stopWithRename('discount_rate', 'promotional_discount')
  assert.match(check('--at', 'stop').stdout, /untr: src\/new\.ts:1 still uses discount_rate/)
})

test('an impact approval only downgrades the ids it covers, and re-running the plan point makes it stale', () => {
  const rel = consumerRepo('scoped', 'src/a.ts', 'a_col b_col\n')
  sensors({ consumers: [{ name: 'scoped', path: rel }] })
  sdlc(repo, ['new', 'scoped-change', '--type', 'feature', '--tier', 'M'])
  const planPath = '.sdlc/changes/scoped-change/plan.md'
  write(repo, planPath, '## Files\n- schema/**\n## Contracts\n- remove `a_col`\n')
  check('--at', 'plan', '--slug', 'scoped-change')
  write(repo, '.sdlc/changes/scoped-change/spec.md', '## Behaviours\nB1\n')
  for (const s of ['spec', 'plan', 'impact']) sdlc(repo, ['approve', 'scoped-change', s], { env: { SDLC_HUMAN: '1' } })
  assert.match(sdlc(repo, ['status']).stdout, /next: \/sdlc:build/)
  stopWithRename('a_col', 'z_col')
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (z_col NUMERIC);\n-- b_col gone\n')
  const ok = check('--at', 'stop')
  assert.equal(ok.code, 0)
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (z_col NUMERIC);\n')
  write(repo, 'schema/other.sql', 'CREATE TABLE o (b_col INT);\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'other')
  hook(repo, 'prompt-submit', {})
  write(repo, 'schema/other.sql', 'CREATE TABLE o (c_col INT);\n')
  assert.equal(check('--at', 'stop').code, 1, 'b_col is not in the approved impact')
  check('--at', 'plan', '--slug', 'scoped-change')
  assert.match(sdlc(repo, ['status']).stdout, /\/sdlc-approve scoped-change impact[\s\S]*stale/)
})

test('a consumer that is not checked out at the plan point also needs the impact approval', () => {
  sensors({ consumers: [{ name: 'ghost', path: '../does-not-exist' }] })
  sdlc(repo, ['new', 'ghost-change', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/ghost-change/plan.md', '## Files\n- schema/**\n## Contracts\n- remove `q_col`\n')
  assert.match(check('--at', 'plan', '--slug', 'ghost-change').stdout, /not checked out/i)
  write(repo, '.sdlc/changes/ghost-change/spec.md', '## Behaviours\nB1\n')
  sdlc(repo, ['approve', 'ghost-change', 'spec'], { env: { SDLC_HUMAN: '1' } })
  sdlc(repo, ['approve', 'ghost-change', 'plan'], { env: { SDLC_HUMAN: '1' } })
  assert.match(sdlc(repo, ['status']).stdout, /impact \(awaiting approval\)/)
})

test('impact.json is evidence: pre-edit denies writing it; approving impact without it fails', () => {
  sdlc(repo, ['new', 'ev', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/ev/plan.md', '## Files\n- a\n')
  const r = JSON.parse(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, '.sdlc/changes/ev/impact.json') } }).stdout)
  assert.match(JSON.stringify(r), /deny/)
  assert.notEqual(sdlc(repo, ['approve', 'ev', 'impact'], { env: { SDLC_HUMAN: '1' } }).code, 0)
})
