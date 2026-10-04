// Spec 13.3 and 13.5: every seeded defect is caught at Stop (no active change, the vibe path) and in CI,
// and every forgery attempt is denied locally or judged against the base.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn, buildDone } from './testkit.ts'

let repo: string
let consumer: string
const BASE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('B1 adds', () => {\n  assert.equal(add(1, 2), 3)\n  assert.equal(add(0, 0), 0)\n})\n"

beforeEach(() => {
  repo = makeRepo()
  consumer = path.join(path.dirname(repo), `${path.basename(repo)}-checkout`)
  fs.mkdirSync(consumer)
  gitIn(consumer, 'init', '-q', '-b', 'main')
  write(consumer, 'src/cart.ts', 'const r = order.discount_rate\n')
  gitIn(consumer, 'add', '.')
  gitIn(consumer, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-qm', 'init')
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({
    layers: [{ from: 'src/domain/**', mustNotImport: ['infra'], why: 'the domain stays framework-free' }],
    consumers: [{ name: 'checkout-service', path: path.relative(repo, consumer).split(path.sep).join('/') }],
    limits: { diffLines: 500, fileLines: 400 },
  }, null, 2))
  write(repo, 'package.json', '{ "type": "module" }\n')
  write(repo, 'src/add.js', 'export const add = (a, b) => a + b\n')
  write(repo, 'test/add.test.js', BASE_TEST)
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (discount_rate NUMERIC);\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'pr')
  hook(repo, 'prompt-submit', {})
})

const DEFECTS: [string, RegExp, () => void][] = [
  ['weakened assertion', /test-tamper/, () => write(repo, 'test/add.test.js', BASE_TEST.replace('  assert.equal(add(0, 0), 0)\n', ''))],
  ['added .skip', /test-tamper/, () => write(repo, 'test/add.test.js', BASE_TEST.replace("test('B1", "test.skip('B1"))],
  ['domain imports infra', /layering/, () => write(repo, 'src/domain/order.js', "import { db } from '../infra/db.js'\n")],
  ['Bash-made suppression (sed -i)', /suppression/, () => fs.appendFileSync(path.join(repo, 'src/add.js'), '// eslint-disable-next-line\n')],
  ['schema rename with a live consumer', /contract-impact/, () => write(repo, 'schema/billing.sql', 'CREATE TABLE billing (promotional_discount NUMERIC);\n')],
  ['migration RENAME COLUMN with a live consumer', /contract-impact/, () => write(repo, 'migrations/0002.sql', 'ALTER TABLE billing RENAME COLUMN discount_rate TO promotional_discount;\n')],
  ['agent raises limits.diffLines via Bash', /harness-tamper/, () => write(repo, '.sdlc/sensors.json', fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8').replace('500', '5000'))],
]

for (const [name, sensor, apply] of DEFECTS) {
  test(`seeded: ${name} is caught at Stop and in CI`, () => {
    apply()
    const stop = JSON.parse(hook(repo, 'stop', {}).stdout || '{}')
    assert.equal(stop.decision, 'block', name)
    assert.match(stop.reason, sensor)
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-qm', 'pr')
    const ci = sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main'])
    assert.equal(ci.code, 1, `${name} in CI:\n${ci.stdout}`)
    assert.match(ci.stdout, sensor)
  })
}

test('seeded: a 700-line diff warns at Stop and blocks in CI', () => {
  write(repo, 'src/huge.js', Array.from({ length: 700 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  assert.notEqual(JSON.parse(hook(repo, 'stop', {}).stdout || '{}').decision, 'block')
  // A warn emits nothing; the proof the size sensor ran and warned is the gate summary Stop records.
  const last = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/.gate'), 'utf8')).last
  assert.ok(last, 'Stop recorded a gate summary')
  assert.ok(last.bySensor.size >= 1 && last.warns >= 1, `size warned at Stop: ${JSON.stringify(last)}`)
  assert.equal(last.blocks, 0)
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'pr')
  assert.match(sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main']).stdout, /\[size\][\s\S]*limit 500/)
})

test('seeded: a hand-written passing verification.md does not make a change shippable', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  buildDone(repo, 'xx')
  write(repo, '.sdlc/changes/xx/verification.md', '---\nresult: pass\n---\n')
  assert.match(sdlc(repo, ['status']).stdout, /next: \/sdlc:test xx/)
})

test('seeded: a B-number with no test blocks at ship', () => {
  sdlc(repo, ['new', 'sub', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/sub/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. B1 subtract, B2 negative\n## Verification\n- node --test test/*.test.js\n')
  write(repo, 'src/sub.js', 'export const sub = (a, b) => a - b\n')
  write(repo, 'test/sub.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { sub } from '../src/sub.js'\ntest('B1 subtracts', () => assert.equal(sub(3, 1), 2))\n")
  assert.match(sdlc(repo, ['check', '--at', 'ship', '--base', 'main', '--slug', 'sub']).stdout, /\[traceability\][\s\S]*B2 .*has no test that names it/)
})

const bash = (command: string, extra: Record<string, unknown> = {}) =>
  JSON.parse(hook(repo, 'pre-bash', { tool_input: { command }, ...extra }).stdout || '{}').hookSpecificOutput?.permissionDecision

test('forgery: appending to runs.jsonl, bumping the gate and model approvals or waivers are denied', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  assert.equal(bash(`echo '{"cmd":"npm test","exit":0}' >> .sdlc/changes/xx/runs.jsonl`), 'deny')
  assert.equal(bash(`echo '{"blocks":{"main":2}}' > .sdlc/.gate`), 'deny')
  assert.equal(bash('node /p/scripts/sdlc.ts approve xx plan'), 'deny')
  assert.equal(bash('node /p/scripts/sdlc.ts waive size * xx'), 'deny')
  const binEdit = JSON.parse(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, '.sdlc/bin/sensors.ts'), content: '' } }).stdout)
  assert.equal(binEdit.hookSpecificOutput.permissionDecision, 'ask')
})

test('forgery: quoting and $-quoting cannot hide an evidence path', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  for (const f of ['run"s".jsonl', "run$'s'.jsonl"]) {
    assert.equal(bash(`echo '{"exit":0}' >> .sdlc/changes/xx/${f}`, { agent_type: 'sdlc:implementer' }), 'deny', f)
  }
})

test('forgery: a read-only agent cannot smuggle a write past the Bash allowlist', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  for (const c of ['echo \\"; touch f; echo \\"', "sort '-o' f x"]) {
    assert.equal(bash(c, { agent_type: 'sdlc:reviewer' }), 'deny', c)
  }
})
