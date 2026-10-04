// The per-story view and the PR scorecard: tokens, cost per node, estimated value, rounds, autonomy.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, sdlc, write } from './testkit.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 1.5, change: 'big', stage: 'build', in: 100, out: 50, cr: 1000, cw: 10 })])
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'agent', agentType: 'rig:implementer', change: 'big', stage: 'build', in: 10, out: 5 })])
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 0.5, change: 'big', stage: 'test' })])
})

test('story: tokens, cost by node and value from the tier default', () => {
  const s = JSON.parse(sdlc(repo, ['scorecard', 'big', '--json']).stdout)
  assert.equal(s.tokens, 1175)
  assert.equal(s.usd, 2)
  assert.deepEqual(s.usdByNode, { build: 1.5, test: 0.5 })
  assert.equal(s.valueHours, 24)
  assert.equal(s.valueUsd, 2400)
})

test('the architect can override value hours in plan.md, with a reason', () => {
  write(repo, '.sdlc/changes/big/plan.md', '## Risks & rollback\nvalue_hours: 6 because the endpoint is additive and small\n')
  const s = JSON.parse(sdlc(repo, ['scorecard', 'big', '--json']).stdout)
  assert.equal(s.valueHours, 6)
  assert.equal(s.valueUsd, 600)
})

test('a value override without a reason is ignored', () => {
  write(repo, '.sdlc/changes/big/plan.md', '## Risks & rollback\nvalue_hours: 6\n')
  assert.equal(JSON.parse(sdlc(repo, ['scorecard', 'big', '--json']).stdout).valueHours, 24)
})

test('the scorecard markdown labels value as an estimate and lists rounds and autonomy', () => {
  const md = sdlc(repo, ['scorecard', 'big']).stdout
  assert.match(md, /## Scorecard/)
  assert.match(md, /Cost \| \$2\.00/)
  assert.match(md, /Value \(estimate\) \| \$2,400 \(24 h × \$100\/h\)/)
  assert.match(md, /Artifacts: `\.sdlc\/changes\/big\/`/)
})

test('the scorecard rejects a path-like or unknown slug', () => {
  assert.notEqual(sdlc(repo, ['scorecard', '../x']).code, 0)
  assert.notEqual(sdlc(repo, ['scorecard', 'nope']).code, 0)
})

test('a row with no stage is its own bucket and the buckets sum to the total', () => {
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 0.25, change: 'big' })])
  const s = JSON.parse(sdlc(repo, ['scorecard', 'big', '--json']).stdout)
  assert.deepEqual(s.usdByNode, { build: 1.5, test: 0.5, '(none)': 0.25 })
  assert.equal(s.usd, 2.25)
})

test('tokens and spend against budget per node', () => {
  const s = JSON.parse(sdlc(repo, ['scorecard', 'big', '--json']).stdout)
  assert.equal(s.tokensByNode.build, 1175)
  assert.deepEqual(s.budgetByNode, { build: { spent: 1.5, cap: 6 }, test: { spent: 0.5, cap: 2 } })
  assert.match(sdlc(repo, ['scorecard', 'big']).stdout, /Budget \| build \$1\.50\/\$6, test \$0\.50\/\$2/)
})

test('a value override whose reason is on the next line is ignored', () => {
  write(repo, '.sdlc/changes/big/plan.md', 'value_hours: 6\nbecause x\n')
  assert.equal(JSON.parse(sdlc(repo, ['scorecard', 'big', '--json']).stdout).valueHours, 24)
})
