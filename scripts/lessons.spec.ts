// The "twice" rule and the review sweep: skill text that decides when a lesson is earned and how review ends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('rule: a lesson needs two occurrences, then becomes a regex rule or one CLAUDE.md line the person adds', () => {
  const rule = read('skills/rule/SKILL.md')
  assert.match(rule, /at least two real occurrences/)
  assert.match(rule, /fewer than two, stop/)
  assert.match(rule, /## Things Claude gets wrong/)
  assert.match(rule, /cannot be stated as a regular expression/)
  assert.match(rule, /CLAUDE\.md is a protected harness file/)
  assert.match(rule, /^description: .*CLAUDE\.md/m)
})

test('pr-review: a finding whose category appears in another change hands over to /rig:rule', () => {
  const review = read('skills/pr-review/SKILL.md')
  assert.match(review, /^allowed-tools: .*\bGrep\b/m)
  assert.match(review, /\.sdlc\/changes\/\*\/review\.md/)
  assert.match(review, /Next: \/rig:rule "<category>"/)
})
