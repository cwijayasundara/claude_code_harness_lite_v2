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
