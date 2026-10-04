// Test levels: which are required for a change, and whether they ran and passed.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write } from './testkit.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })
const vfront = (slug: string) => fs.readFileSync(path.join(repo, `.sdlc/changes/${slug}/verification.md`), 'utf8')

test('unit is always required; api when the plan adds an endpoint; acceptance for tier L', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { unit: 'node -e "0"', acceptance: 'node -e "0"', api: 'node -e "0"' } }))
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/plan.md', '## Contracts\n- add `GET /products/search`\n## Files\n- src/**\n## Verification\n- `node -e "0"`\n')
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'big'])
  assert.match(vfront('big'), /^levels: unit=pass,acceptance=pass,api=pass$/m)
  assert.match(vfront('big'), /^result: pass$/m)
})

test('a required level with no declared command fails verification', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n## Verification\n- `node -e "0"`\n')
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'big'])
  assert.match(vfront('big'), /^levels: unit=plan,acceptance=undeclared$/m, 'unit falls back to the plan; acceptance must be declared')
  assert.match(vfront('big'), /^result: fail$/m)
  assert.match(vfront('big'), /## Test levels[\s\S]*acceptance: undeclared/)
})

test('a failing verify-report counts a test round; past the cap the change is blocked', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { unit: 'node -e "process.exit(1)"' } }))
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  for (let i = 0; i < 3; i++) {
    sdlc(repo, ['run', '--slug', 'tiny', '--', 'node -e "process.exit(1)"'])
    sdlc(repo, ['verify-report', 'tiny'])
  }
  assert.match(JSON.parse(sdlc(repo, ['next', 'tiny', '--json']).stdout).reason, /test: cap: 2 fix rounds/)
})

const nextStage = (slug: string) => (JSON.parse(sdlc(repo, ['status', '--json']).stdout).changes as { slug: string; next: { stage: string } | null }[]).find(c => c.slug === slug)?.next ?? { stage: 'none' }
const feature = () => {
  sdlc(repo, ['new', 'two', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/two/plan.md', '## Files\n- src/**\n## Verification\n- `node -e "0"`\n### Task 1\nA\n### Task 2\nB\n')
  sdlc(repo, ['run', '--slug', 'two', '--', 'node -e "0"'])
}

test('a new v0.4 change stays at build until every slice is reviewed, whatever verify-report says', () => {
  feature()
  sdlc(repo, ['verify-report', 'two'])
  assert.equal(nextStage('two').stage, 'build')
  sdlc(repo, ['run', '--slug', 'two', '--', 'node -e "process.exit(1)"'])
  sdlc(repo, ['verify-report', 'two'])
  assert.equal(nextStage('two').stage, 'build', 'a failing report must not complete build either')
})

test('recording a passing review for every slice moves a v0.4 change past build', () => {
  feature()
  sdlc(repo, ['verify-report', 'two'])
  sdlc(repo, ['ratchet', 'record', 'two', 'build', '--slice', '1'], { input: 'verdict: pass\n' })
  assert.equal(nextStage('two').stage, 'build')
  sdlc(repo, ['ratchet', 'record', 'two', 'build', '--slice', '2'], { input: 'verdict: pass\n' })
  assert.notEqual(nextStage('two').stage, 'build')
})

test('R24: an in-flight change without ratchet.json stays at build (fails closed), even with a passing verification.md', () => {
  sdlc(repo, ['new', 'old', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/old/plan.md', '## Files\n- src/**\n## Verification\n- `node -e "0"`\n')
  sdlc(repo, ['run', '--slug', 'old', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'old'])
  assert.match(vfront('old'), /^result: pass$/m)
  fs.rmSync(path.join(repo, '.sdlc/changes/old/ratchet.json'))
  assert.equal(nextStage('old').stage, 'build')
})

test('a corrupt ratchet.json also leaves build not done', () => {
  sdlc(repo, ['new', 'old', '--type', 'chore', '--tier', 'S'])
  sdlc(repo, ['run', '--slug', 'old', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'old'])
  write(repo, '.sdlc/changes/old/ratchet.json', '{not json')
  assert.equal(nextStage('old').stage, 'build')
})

test('an undeclared required level blocks the change with the exact edit a person makes', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n## Verification\n- `node -e "0"`\n')
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'big'])
  const n = JSON.parse(sdlc(repo, ['next', 'big', '--json']).stdout)
  assert.equal(n.verdict, 'continue', 'R46: a level block resumes at the test node, which re-derives or clears it')
  assert.match(n.reason, /pending block/)
  assert.match(n.reason, /level acceptance required but not declared: add "acceptance": "<cmd>" to \.sdlc\/sensors\.json levels: declare it on the trunk first/)
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { acceptance: 'node -e "0"' } }))
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'big'])
  assert.equal(JSON.parse(sdlc(repo, ['ratchet', 'show', 'big']).stdout).blocked, undefined, 'declaring the level and re-running verify-report clears the block')
  assert.doesNotMatch(JSON.parse(sdlc(repo, ['next', 'big', '--json']).stdout).reason, /pending block/)
})

test('declaring a missing level never drops an earlier cap block', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { unit: 'node -e "process.exit(1)"' } }))
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n')
  write(repo, '.sdlc/changes/big/ratchet.json', JSON.stringify({ nodes: { test: { rounds: 2, hashes: [], status: 'open' } }, slices: {}, baseline: {} }))
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "process.exit(1)"'])
  sdlc(repo, ['verify-report', 'big'])
  assert.match(JSON.parse(sdlc(repo, ['next', 'big', '--json']).stdout).reason, /cap: 2 fix rounds/, 'the cap came first and stays the reason')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { unit: 'node -e "0"', acceptance: 'node -e "0"' } }))
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'big'])
  const n = JSON.parse(sdlc(repo, ['next', 'big', '--json']).stdout)
  assert.equal(n.verdict, 'blocked')
  assert.match(n.reason, /cap: 2 fix rounds/)
})

test('a cap reached in the same run as a level unblock is recorded, not lost', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { unit: 'node -e "process.exit(1)"', acceptance: 'node -e "0"' } }))
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n')
  write(repo, '.sdlc/changes/big/ratchet.json', JSON.stringify({ nodes: { test: { rounds: 2, hashes: [], status: 'open' } }, slices: {}, baseline: {},
    blocked: { node: 'test', reason: 'level acceptance required but not declared', at: 'now', kind: 'level' } }))
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "process.exit(1)"'])
  sdlc(repo, ['verify-report', 'big'])
  const blocked = JSON.parse(sdlc(repo, ['ratchet', 'show', 'big']).stdout).blocked
  assert.equal(blocked?.kind, 'cap')
  assert.match(blocked?.reason, /cap: 2 fix rounds/)
})

test('a pending level block does not hide a later cap: the cap replaces it', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { unit: 'node -e "process.exit(1)"' } }))
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n')
  write(repo, '.sdlc/changes/big/ratchet.json', JSON.stringify({ nodes: { test: { rounds: 2, hashes: [], status: 'open' } }, slices: {}, baseline: {},
    blocked: { node: 'test', reason: 'level acceptance required but not declared', at: 'now', kind: 'level' } }))
  sdlc(repo, ['run', '--slug', 'big', '--', 'node -e "process.exit(1)"'])
  sdlc(repo, ['verify-report', 'big'])
  assert.equal(JSON.parse(sdlc(repo, ['ratchet', 'show', 'big']).stdout).blocked?.kind, 'cap')
  assert.equal(JSON.parse(sdlc(repo, ['next', 'big', '--json']).stdout).verdict, 'blocked')
})
