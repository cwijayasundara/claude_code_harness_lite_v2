// Integration: baselines and diffs, sdlc check at each point, ship verdicts. Each test gets a fresh temp repo.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeRepo, sdlc, hook, write, gitIn, verified, ratcheted } from './testkit.ts'

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
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-bare-'))
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

test('check-file accepts an absolute path to an untracked test file', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'test/a.test.js', "it.only('x', () => {})\n")
  const r = JSON.parse(sdlc(repo, ['check-file', path.join(repo, 'test/a.test.js'), '--json']).stdout)
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
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(0)"' }], levels: { integration: 'node -e "process.exit(0)"' } })
  gitIn(repo, 'add', '.sdlc/sensors.json'); gitIn(repo, 'commit', '-qm', 'declare sensors')
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (discount_rate NUMERIC);\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'schema')
  hook(repo, 'prompt-submit', {})
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (promotional_discount NUMERIC);\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[contract-impact\][\s\S]*checkout-service: src\/cart\.ts:1 still uses discount_rate/)
  assert.match(r.stdout, /run \/rig:start/)
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
  assert.match(sdlc(repo, ['status']).stdout, /\/rig-approve rename-rate impact/)
  sdlc(repo, ['approve', 'rename-rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.match(sdlc(repo, ['status']).stdout, /next: \/rig:build rename-rate/)
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
  assert.match(sdlc(repo, ['status']).stdout, /next: \/rig:build/)
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
  assert.match(sdlc(repo, ['status']).stdout, /next: \/rig:build/, 'identical re-run keeps the approval')
  write(path.resolve(repo, rel), 'src/b.ts', 'a_col again\n')
  check('--at', 'plan', '--slug', 'scoped-change')
  assert.match(sdlc(repo, ['status']).stdout, /\/rig-approve scoped-change impact[\s\S]*stale/)
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

test('approving impact without an impact.json fails', () => {
  sdlc(repo, ['new', 'ev', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/ev/plan.md', '## Files\n- a\n')
  assert.notEqual(sdlc(repo, ['approve', 'ev', 'impact'], { env: { SDLC_HUMAN: '1' } }).code, 0)
})

test('check --at ship reports a weakened committed sensors.json as harness-tamper', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  gitIn(repo, 'add', '.sdlc/sensors.json')
  gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 9000 } }))
  gitIn(repo, 'commit', '-qam', 'loosen')
  const r = check('--at', 'ship', '--base', 'main')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[harness-tamper\]/)
})

function featureRepo(): void {
  sensors({ full: { test: 'node --test test/*.test.js' } })
  write(repo, 'src/add.js', 'export const add = (a, b) => a + b\n')
  write(repo, 'test/add.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n")
  write(repo, 'package.json', '{ "type": "module" }\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'feature')
  sdlc(repo, ['new', 'sub', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/sub/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. B1 subtract\n## Verification\n- node --test test/*.test.js\n')
}

test('ship: new tests that fail on the base prove red; tests that already pass there do not', () => {
  featureRepo()
  write(repo, 'src/sub.js', 'export const sub = (a, b) => a - b\n')
  write(repo, 'test/sub.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { sub } from '../src/sub.js'\ntest('B1 subtracts', () => assert.equal(sub(3, 1), 2))\n")
  const ok = check('--at', 'ship', '--base', 'main', '--slug', 'sub')
  assert.equal(ok.code, 0, ok.stdout)
  fs.rmSync(path.join(repo, 'test/sub.test.js'))
  write(repo, 'test/add2.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('B1 add again', () => assert.equal(add(2, 2), 4))\n")
  const weak = check('--at', 'ship', '--base', 'main', '--slug', 'sub')
  assert.equal(weak.code, 1)
  assert.match(weak.stdout, /\[red-proof\][\s\S]*already pass on the base/)
})

test('ship: a refactor\'s characterization tests must pass on the base, not fail', () => {
  featureRepo()
  sdlc(repo, ['new', 'tidy', '--type', 'refactor', '--tier', 'M'])
  write(repo, '.sdlc/changes/tidy/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. characterize add\n## Verification\n- node --test test/*.test.js\n')
  write(repo, 'test/add-char.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('add keeps working', () => assert.equal(add(2, 3), 5))\n")
  assert.equal(check('--at', 'ship', '--base', 'main', '--slug', 'tidy').code, 0)
  write(repo, 'test/add-char.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('add is now different', () => assert.equal(add(2, 3), 6))\n")
  write(repo, 'src/add.js', 'export const add = (a, b) => a + b + 1\n')
  assert.match(check('--at', 'ship', '--base', 'main', '--slug', 'tidy').stdout, /fail on the base: they do not describe the behaviour/)
})

test('ship: every behaviour needs a test that names it', () => {
  featureRepo()
  write(repo, '.sdlc/changes/sub/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. B1 subtract, B2 negative\n## Verification\n- node --test test/*.test.js\n')
  write(repo, 'src/sub.js', 'export const sub = (a, b) => a - b\n')
  write(repo, 'test/sub.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { sub } from '../src/sub.js'\ntest('B1 subtracts', () => assert.equal(sub(3, 1), 2))\n")
  const r = check('--at', 'ship', '--base', 'main', '--slug', 'sub')
  assert.match(r.stdout, /\[traceability\][\s\S]*B2 .*has no test that names it/)
})

test('an ad-hoc change that started small is re-tiered at ship as it grows', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/one.js', 'export const one = 1\n')
  hook(repo, 'stop', {})
  const slug = (sdlc(repo, ['status', '--json']).stdout.match(/adhoc-[\d-]+/) ?? [''])[0]
  assert.match(fs.readFileSync(path.join(repo, `.sdlc/changes/${slug}/intent.md`), 'utf8'), /tier: S/)
  for (const f of ['a', 'b', 'c', 'd']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  assert.match(check('--at', 'ship', '--slug', slug).stdout, /\[adhoc\][\s\S]*now tier M/)
})

test('ship refuses an ad-hoc tier M change with no plan', () => {
  hook(repo, 'prompt-submit', {})
  for (const f of ['a', 'b', 'c', 'd']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  hook(repo, 'stop', {})
  const slug = (sdlc(repo, ['status', '--json']).stdout.match(/adhoc-[\d-]+/) ?? [''])[0]
  const r = check('--at', 'ship', '--slug', slug)
  assert.match(r.stdout, /\[adhoc\][\s\S]*run \/rig:start adhoc-/)
})

test('sdlc run does not inherit NODE_TEST_CONTEXT: a failing node --test records a non-zero exit', () => {
  sdlc(repo, ['new', 'rn', '--type', 'chore', '--tier', 'S'])
  write(repo, 'test/bad.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\ntest('bad', () => assert.equal(1, 2))\n")
  write(repo, 'package.json', '{ "type": "module" }\n')
  sdlc(repo, ['run', '--slug', 'rn', '--', 'node --test test/bad.test.js'], { env: { NODE_TEST_CONTEXT: 'child-v8' } })
  const rows = fs.readFileSync(path.join(repo, '.sdlc/changes/rn/runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { exit: number })
  assert.notEqual(rows.at(-1)?.exit, 0)
})

test('ship: an old committed test naming B2 does not satisfy this change\'s B2', () => {
  write(repo, 'test/old.test.js', "// B2 from long ago\n")
  featureRepo()
  write(repo, '.sdlc/changes/sub/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. B1 subtract\n2. B2 negative numbers\n## Verification\n- node --test test/*.test.js\n')
  write(repo, 'src/sub.js', 'export const sub = (a, b) => a - b\n')
  write(repo, 'test/sub.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { sub } from '../src/sub.js'\ntest('test_B1_subtracts', () => assert.equal(sub(3, 1), 2))\n")
  assert.match(check('--at', 'ship', '--base', 'main', '--slug', 'sub').stdout, /B2 \(negative numbers\) has no test that names it/)
})

test('ship: a fixture added in the branch travels with the tests, so an already-passing test is not a false red', () => {
  featureRepo()
  write(repo, 'test/fixtures/data.json', '{ "n": 3 }\n')
  write(repo, 'test/data.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport fs from 'node:fs'\nimport { add } from '../src/add.js'\nconst d = JSON.parse(fs.readFileSync(new URL('./fixtures/data.json', import.meta.url), 'utf8'))\ntest('B1 uses data', () => assert.equal(add(d.n, 1), 4))\n")
  assert.match(check('--at', 'ship', '--base', 'main', '--slug', 'sub').stdout, /already pass on the base/)
})

test('ship commits a changed consumer on the same branch after its tests pass, and records it', () => {
  const rel = consumerRepo('checkout2', 'src/cart.ts', 'const r = order.discount_rate\n')
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(0)"' }], levels: { integration: 'node -e "process.exit(0)"' } })
  gitIn(repo, 'add', '.sdlc/sensors.json'); gitIn(repo, 'commit', '-qm', 'declare sensors')
  sdlc(repo, ['new', 'rate', '--type', 'chore', '--tier', 'S'])
  write(repo, 'src/app.js', 'export const a = 10\n')
  write(repo, '.sdlc/changes/rate/plan.md', `## Files\n- src/**\n- ${rel}/src/**\n- .sdlc/sensors.json\n- notes.txt\n`)
  write(path.resolve(repo, rel), 'src/cart.ts', 'const r = order.promotional_discount\n')
  verified(repo, 'rate')
  ratcheted(repo, 'rate')
  const r = sdlc(repo, ['ship', 'rate', '--message', 'chore: rename rate'])
  assert.equal(r.code, 0, r.stderr)
  const shipped = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/rate/ship.json'), 'utf8'))
  assert.equal(shipped.repos[0].branch, 'sdlc/rate')
  assert.match(gitIn(path.resolve(repo, rel), 'log', '-1', '--format=%B', 'sdlc/rate'), /Part of .*@sdlc\/rate/)
})

test('ship refuses and commits nothing when a changed consumer\'s tests fail', () => {
  const rel = consumerRepo('checkout3', 'src/cart.ts', 'x\n')
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(1)"' }], levels: { integration: 'node -e "process.exit(0)"' } })
  gitIn(repo, 'add', '.sdlc/sensors.json'); gitIn(repo, 'commit', '-qm', 'declare sensors')
  sdlc(repo, ['new', 'rate', '--type', 'chore', '--tier', 'S'])
  write(repo, 'src/app.js', 'export const a = 11\n')
  write(repo, '.sdlc/changes/rate/plan.md', `## Files\n- src/**\n- ${rel}/src/**\n- .sdlc/sensors.json\n- notes.txt\n`)
  write(path.resolve(repo, rel), 'src/cart.ts', 'y\n')
  verified(repo, 'rate')
  ratcheted(repo, 'rate')
  const head = gitIn(repo, 'rev-parse', 'HEAD')
  const r = sdlc(repo, ['ship', 'rate', '--message', 'chore: x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /checkout-service tests failed/)
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), head)
  assert.equal(gitIn(path.resolve(repo, rel), 'branch', '--list', 'sdlc/rate'), '')
  assert.notEqual(gitIn(path.resolve(repo, rel), 'status', '--porcelain'), '')
})

function shipSetup(name: string): string {
  const rel = consumerRepo(name, 'src/cart.ts', 'x\n')
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(0)"' }], levels: { integration: 'node -e "process.exit(0)"' } })
  gitIn(repo, 'add', '.sdlc/sensors.json'); gitIn(repo, 'commit', '-qm', 'declare sensors')
  sdlc(repo, ['new', 'rate', '--type', 'chore', '--tier', 'S'])
  write(repo, 'src/app.js', 'export const a = 12\n')
  write(repo, '.sdlc/changes/rate/plan.md', `## Files\n- src/**\n- ${rel}/src/**\n- .sdlc/sensors.json\n- notes.txt\n`)
  write(path.resolve(repo, rel), 'src/cart.ts', 'y\n')
  verified(repo, 'rate')
  ratcheted(repo, 'rate')
  return rel
}

test('ship refuses when a consumer has an unplanned change, and commits nothing anywhere', () => {
  const rel = shipSetup('checkout4')
  write(path.resolve(repo, rel), 'scratch.txt', 'tmp\n')
  const head = gitIn(repo, 'rev-parse', 'HEAD')
  const chead = gitIn(path.resolve(repo, rel), 'rev-parse', 'HEAD')
  const r = sdlc(repo, ['ship', 'rate', '--message', 'chore: x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /checkout-service has changes outside rate\/plan\.md ## Files: scratch\.txt/)
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), head)
  assert.equal(gitIn(path.resolve(repo, rel), 'rev-parse', 'HEAD'), chead)
})

test('ship refuses before committing anything when sdlc/<slug> already exists in a consumer', () => {
  const rel = shipSetup('checkout5')
  const cdir = path.resolve(repo, rel)
  gitIn(cdir, 'branch', 'sdlc/rate')
  const chead = gitIn(cdir, 'rev-parse', 'HEAD')
  const r = sdlc(repo, ['ship', 'rate', '--message', 'chore: x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /sdlc\/rate already exists in checkout-service/)
  assert.equal(gitIn(cdir, 'rev-parse', 'HEAD'), chead)
  assert.notEqual(gitIn(cdir, 'status', '--porcelain'), '')
})

test('vendor copies a standalone checker that runs without the plugin', () => {
  const v = sdlc(repo, ['vendor'])
  assert.equal(v.code, 0, v.stderr)
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/bin/VERSION')))
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/bin/testkit.ts')))
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', '.sdlc/bin/sdlc.ts', 'check', '--at', 'ship'], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('the harness vendoring its own files does not trip the Stop gate', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  sdlc(repo, ['vendor'])
  assert.equal(hook(repo, 'stop', {}).stdout, '')
})

test('CI judges a PR by the base branch config, so loosening limits does not help', () => {
  sensors({ limits: { diffLines: 500 } })
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'pr')
  sensors({ limits: { diffLines: 5000 } })
  write(repo, 'src/huge.js', Array.from({ length: 700 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'big')
  const r = check('--at', 'ci', '--base', 'main', '--config-from', 'main')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[size\][\s\S]*limit 500/)
  assert.match(r.stdout, /\[harness-tamper\][\s\S]*diffLines raised 500 → 5000/)
})

test('I1: CI blocks a tier M PR that carries no committed change record; a tier S one passes', () => {
  gitIn(repo, 'checkout', '-qb', 'vibe')
  write(repo, 'src/one.js', 'export const one = 1\n')
  gitIn(repo, 'add', 'src')
  gitIn(repo, 'commit', '-qm', 'small')
  const small = check('--at', 'ci', '--base', 'main', '--config-from', 'main')
  assert.equal(small.code, 0, small.stdout)
  for (const f of ['a', 'b', 'c', 'd']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  gitIn(repo, 'add', 'src')
  gitIn(repo, 'commit', '-qm', 'vibe-coded')
  const r = check('--at', 'ci', '--base', 'main', '--config-from', 'main')
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /\[adhoc\][\s\S]*no sdlc change record for a tier M diff[\s\S]*\/rig:start/)
})

test('I4: CI lists every waiver and approval row the PR adds, for human review', () => {
  gitIn(repo, 'checkout', '-qb', 'pr')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/waivers.jsonl', JSON.stringify({ slug: 'tiny', sensor: 'red-proof', file: '*', reason: 'trust me', by: 'Mallory', at: '2026-10-03T00:00:00Z' }) + '\n')
  write(repo, '.sdlc/approvals.jsonl', JSON.stringify({ slug: 'tiny', stage: 'plan', by: 'Mallory', at: '2026-10-03T00:00:00Z', digest: 'x' }) + '\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'pr')
  const summary = path.join(path.dirname(repo), `${path.basename(repo)}-summary.md`)
  const r = sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main'], { env: { GITHUB_STEP_SUMMARY: summary } })
  for (const text of [r.stdout, fs.readFileSync(summary, 'utf8')]) {
    assert.match(text, /needs human review: 2 waiver\/approval row\(s\) added by this PR/)
    assert.match(text, /waiver tiny: red-proof \* "trust me" by Mallory/)
    assert.match(text, /approval tiny plan by Mallory/)
  }
  const json = JSON.parse(sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main', '--json']).stdout)
  assert.equal(json.humanRows.length, 2)
})

test('I4: PR-controlled waiver fields cannot break out of the review listing', () => {
  gitIn(repo, 'checkout', '-qb', 'pr')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const reason = 'ok\n```\n::warning::all clean\n<b>x</b>\u2028more'
  write(repo, '.sdlc/waivers.jsonl', JSON.stringify({ slug: 'tiny', sensor: 'red-proof', file: '*', reason, by: 'M\r\n::error::x' }) + '\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'pr')
  const summary = path.join(path.dirname(repo), `${path.basename(repo)}-summary.md`)
  const r = sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main'], { env: { GITHUB_STEP_SUMMARY: summary } })
  for (const text of [r.stdout, fs.readFileSync(summary, 'utf8')]) {
    const rows = text.split('\n').filter(l => l.includes('waiver tiny'))
    assert.equal(rows.length, 1, text)
    assert.doesNotMatch(rows[0] ?? '', /`|<|>|\u2028/)
    assert.ok(!text.split('\n').some(l => l.startsWith('::')), 'no line starts a workflow command')
    assert.equal((text.match(/```/g) ?? []).length % 2, 0, 'fences stay balanced')
  }
})

test('a big diff blocks in CI unless the person approved the change plan; then it only warns', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 50 } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'big')
  sdlc(repo, ['new', 'big-change', '--type', 'refactor', '--tier', 'L'])
  write(repo, '.sdlc/changes/big-change/plan.md', '# Plan\n\n## Files\n- src/**\n\n## Verification\n- `node -e 0`\n')
  write(repo, 'src/a.js', Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'work')
  const size = () => (JSON.parse(sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--json']).stdout) as { findings: { sensor: string; severity: string; file?: string }[] })
    .findings.filter(f => f.sensor === 'size' && !f.file).map(f => f.severity)
  assert.deepEqual(size(), ['block'])
  sdlc(repo, ['approve', 'big-change', 'plan'], { env: { SDLC_HUMAN: '1' } })
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'approved')
  assert.deepEqual(size(), ['warn'])
})

test('a tier S or M change that touches a contract or a risky path blocks at CI until it is re-tiered to L', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'risky')
  sdlc(repo, ['new', 'small-auth', '--type', 'feature', '--tier', 'M'])
  write(repo, 'src/auth/keys.js', 'export const k = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'work')
  type Report = { findings: { sensor: string; severity: string; file?: string }[] }
  const report = (): Report => JSON.parse(sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--json']).stdout) as Report
  const tier = () => report().findings.filter(f => f.sensor === 'tier')
  assert.deepEqual(tier().map(f => [f.severity, f.file]), [['block', 'src/auth/keys.js']])
  const intent = path.join(repo, '.sdlc/changes/small-auth/intent.md')
  fs.writeFileSync(intent, fs.readFileSync(intent, 'utf8').replace('tier: M', 'tier: L'))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'retier')
  assert.deepEqual(tier(), [])
})

test('CI waivers apply only to changes the PR adds, and only to files in that change\'s plan or folder', () => {
  const waiver = (slug: string, file: string) => JSON.stringify({ slug, sensor: 'suppression', file, reason: 'ok', by: 'p', at: 'now' }) + '\n'
  const ci = () => check('--at', 'ci', '--base', 'main', '--config-from', 'main')
  sdlc(repo, ['new', 'old-one', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/waivers.jsonl', waiver('old-one', '*'))
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'old change with a wildcard waiver')
  gitIn(repo, 'checkout', '-qb', 'pr')
  fs.appendFileSync(path.join(repo, '.sdlc/changes/old-one/intent.md'), '\ntouched\n')
  write(repo, 'src/app.js', 'export const a = 9 // eslint-disable-line\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'touch the old change folder')
  const touched = ci()
  assert.equal(touched.code, 1, 'an older change\'s * waiver is not inherited by touching its folder\n' + touched.stdout)
  assert.match(touched.stdout, /suppression/)
  // A change the PR adds, with a plan naming the file: its waiver applies; for a file outside the plan it does not.
  sdlc(repo, ['new', 'fresh-one', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/fresh-one/plan.md', '# Plan\n## Files\n- src/app.js\n')
  write(repo, '.sdlc/waivers.jsonl', waiver('old-one', '*') + waiver('fresh-one', '*'))
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'add fresh change')
  const inPlan = ci()
  assert.doesNotMatch(inPlan.stdout, /\[suppression\]/, inPlan.stdout)
  write(repo, 'src/other.js', 'export const b = 1 // eslint-disable-line\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'file outside the plan')
  const outside = ci()
  assert.match(outside.stdout, /suppression[\s\S]*src\/other\.js|src\/other\.js[\s\S]*suppression/, outside.stdout)
})

test('at CI a harness-tamper waiver in the PR never waives, exact file or *; other waivers on an added change still do', () => {
  const ci = () => check('--at', 'ci', '--base', 'main', '--config-from', 'main')
  const waiver = (sensor: string, file: string) => JSON.stringify({ slug: 'lvl', sensor, file, reason: 'r', by: 'p', at: 'now' }) + '\n'
  gitIn(repo, 'checkout', '-qb', 'pr')
  sdlc(repo, ['new', 'lvl', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/lvl/plan.md', '## Files\n- src/**\n')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { acceptance: 'node -e "0"' } }))
  write(repo, 'src/app.js', 'export const a = 9 // eslint-disable-line\n')
  for (const file of ['*', '.sdlc/sensors.json']) {
    write(repo, '.sdlc/waivers.jsonl', waiver('harness-tamper', file))
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-qm', `waiver ${file}`)
    const r = ci()
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /\[harness-tamper\]/, file)
    assert.match(r.stdout, /declare it on the trunk first/)
    assert.doesNotMatch(r.stderr, /TypeError/)
  }
  write(repo, '.sdlc/waivers.jsonl', waiver('suppression', 'src/app.js'))
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'suppression waiver')
  const r = ci()
  assert.doesNotMatch(r.stdout, /\[suppression\]/, r.stdout)
  assert.match(r.stdout, /\[harness-tamper\]/)
})

// A fake gh answers the reviews lookup; the event payload says who opened the PR and which commit is its head.
let prN = 0
// reviews may use the commit id 'HEAD', replaced by the real checked-out commit; a fake gh answers the lookup.
const prRun = (reviews: unknown[], head = 'HEAD') => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-gh-'))
  gitIn(repo, 'checkout', '-q', 'main')
  gitIn(repo, 'checkout', '-qb', `pr${++prN}`)
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/waivers.jsonl', JSON.stringify({ slug: 'tiny', sensor: 'red-proof', file: '*', reason: 'forged', by: 'dev', at: '2026-10-03T00:00:00Z' }) + '\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'pr')
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  const real = (x: string): string => (x === 'HEAD' ? sha : x)
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho '${JSON.stringify([reviews.map(r => ({ ...(r as object), commit_id: real(String((r as { commit_id?: string }).commit_id)) }))])}'\n`, { mode: 0o755 })
  const ev = path.join(bin, 'event.json')
  fs.writeFileSync(ev, JSON.stringify({ repository: { full_name: 'o/r' }, pull_request: { number: 5, user: { login: 'dev' }, head: { sha: real(head) } } }))
  return sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main'], { env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_PATH: ev } })
}
const posix = process.platform !== 'win32'

test('CI blocks added approval/waiver rows with no independent review of the head commit', { skip: !posix }, () => {
  const none = prRun([])
  assert.equal(none.code, 1, none.stdout)
  assert.match(none.stdout, /\[human-approval\][\s\S]*no approving review of [0-9a-f]{7} from someone other than dev/)
  const self = prRun([{ user: { login: 'dev' }, state: 'APPROVED', author_association: 'MEMBER', commit_id: 'HEAD' }])
  assert.match(self.stdout, /human-approval/, 'the author cannot approve their own rows')
})

test('CI rejects a stale approval, a later change-request, a drive-by reviewer, and a run outside GitHub', { skip: !posix }, () => {
  assert.match(prRun([{ user: { login: 'lead' }, state: 'APPROVED', commit_id: 'old0000' }]).stdout, /human-approval/)
  const flipped = prRun([{ user: { login: 'lead' }, state: 'APPROVED', author_association: 'MEMBER', commit_id: 'HEAD' }, { user: { login: 'lead' }, state: 'CHANGES_REQUESTED', commit_id: 'HEAD' }])
  assert.match(flipped.stdout, /human-approval/)
  assert.match(prRun([{ user: { login: 'rando' }, state: 'APPROVED', author_association: 'NONE', commit_id: 'HEAD' }]).stdout, /human-approval/, 'a reviewer without write access does not count')
  const offline = sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main'])
  assert.match(offline.stdout, /cannot verify a reviewer outside a GitHub pull_request run/)
})

test('CI passes the human-approval gate when a different person approved the head commit', { skip: !posix }, () => {
  const r = prRun([{ user: { login: 'lead' }, state: 'APPROVED', author_association: 'MEMBER', commit_id: 'HEAD' }])
  assert.doesNotMatch(r.stdout, /\[human-approval\]/, r.stdout)
  assert.match(r.stdout, /needs human review: 1 waiver\/approval row/)
})

test('the reviewer lookup happens before any PR test command runs', { skip: !posix }, () => {
  // A declared full command that plants a fake gh and rewrites the event file must not be able to fake an approval.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-gh-'))
  const planted = path.join(bin, 'planted')
  fs.mkdirSync(planted)
  fs.writeFileSync(path.join(bin, 'gh'), "#!/bin/sh\necho '[[]]'\n", { mode: 0o755 })
  gitIn(repo, 'checkout', '-q', 'main')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ full: { plant: `cp ${planted}/gh ${bin}/gh` } }))
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'config')
  gitIn(repo, 'checkout', '-qb', 'prx')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/waivers.jsonl', JSON.stringify({ slug: 'tiny', sensor: 'red-proof', file: '*', reason: 'forged', by: 'dev' }) + '\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'pr')
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  const ev = path.join(bin, 'event.json')
  fs.writeFileSync(ev, JSON.stringify({ repository: { full_name: 'o/r' }, pull_request: { number: 5, user: { login: 'dev' }, head: { sha } } }))
  fs.writeFileSync(path.join(planted, 'gh'), `#!/bin/sh\necho '[[{"user":{"login":"lead"},"state":"APPROVED","author_association":"MEMBER","commit_id":"${sha}"}]]'\n`, { mode: 0o755 })
  const r = sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main'], { env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_PATH: ev } })
  assert.match(r.stdout, /human-approval/, r.stdout)
  assert.equal(r.code, 1)
})

test('CI rejects an approval when the event names a commit that is not the one checked out (stale re-run)', { skip: !posix }, () => {
  const r = prRun([{ user: { login: 'lead' }, state: 'APPROVED', author_association: 'MEMBER', commit_id: 'oldsha1' }], 'oldsha1')
  assert.match(r.stdout, /not the checked-out commit/, r.stdout)
  assert.equal(r.code, 1)
})
