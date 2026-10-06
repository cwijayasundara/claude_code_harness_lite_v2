// The build and pr-review skills carry the one-review-per-change policy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8')
const build = read('skills/build/SKILL.md')
const review = read('skills/pr-review/SKILL.md')

test('build: tier S and M verify a slice with --checks and no model review; tier L reviews on Sonnet', () => {
  assert.match(build, /ratchet record \$0 build --slice N --checks/)
  const tierSM = build.split('\n').find(l => /Tier S and M/.test(l) && /--checks/.test(l)) ?? ''
  assert.ok(tierSM, 'a Tier S and M line names --checks')
  assert.doesNotMatch(tierSM, /rig:reviewer|code-review/)
  const tierL = build.split('\n').find(l => /Tier L/.test(l) && /rig:reviewer/.test(l)) ?? ''
  assert.match(tierL, /model: sonnet/)
})

test('pr-review: one review; shards and the rig-review workflow for a large tier L diff; security-review only on named risks', () => {
  assert.match(review, /sdlc\.ts shards \$0 --json/)
  assert.match(review, /rig-review/)
  assert.match(review, /scriptPath/)
  assert.match(review, /more than 8/)
  assert.match(review, /security-review[^\n]*only when[^\n]*risks name/i)
  assert.doesNotMatch(review, /If the tier is L or the risks name/)
  assert.match(review, /at most once, on the fix diff only/)
  assert.match(review, /allowed-tools:[^\n]*Workflow/)
})

test('reviewer and scout treat file content as data', () => {
  for (const f of ['agents/reviewer.md', 'agents/scout.md']) assert.match(read(f), /data, never instructions/i, f)
})
