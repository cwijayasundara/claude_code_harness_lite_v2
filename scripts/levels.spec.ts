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

test('a legacy change folder (no ratchet.json) with a passing verification.md still reads build done', () => {
  sdlc(repo, ['new', 'old', '--type', 'chore', '--tier', 'S'])
  fs.rmSync(path.join(repo, '.sdlc/changes/old/ratchet.json'))
  write(repo, '.sdlc/changes/old/plan.md', '## Files\n- src/**\n## Verification\n- `node -e "0"`\n')
  sdlc(repo, ['run', '--slug', 'old', '--', 'node -e "0"'])
  sdlc(repo, ['verify-report', 'old'])
  assert.notEqual(nextStage('old').stage, 'build')
})
