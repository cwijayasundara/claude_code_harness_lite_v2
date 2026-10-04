// The ratchet: rounds per node and slice, stall detection, caps, budgets and test-case counting.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write } from './testkit.ts'
import { testCaseCount, parseReviewFindings } from './ratchet.ts'

let repo: string
beforeEach(() => { repo = makeRepo(); sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L']) })
const record = (node: string, text: string, slice = '1') => JSON.parse(sdlc(repo, ['ratchet', 'record', 'big', node, '--slice', slice], { input: text }).stdout)
const HIGH = '- [severity: high] [category: correctness] src/a.js:3: off by one → fix (confidence 90)\n'
const HIGH2 = '- [severity: high] [category: security] src/a.js:9: unescaped input → escape (confidence 85)\n'

test('parseReviewFindings reads the reviewer line format', () => {
  assert.deepEqual(parseReviewFindings(`verdict: changes-needed\n## Findings\n${HIGH}- [severity: medium] [category: tests] t.js:1: weak\n`).map(f => f.severity), ['high', 'medium'])
})

test('a slice with no high findings is done; new high findings continue; a repeated one stalls', () => {
  assert.equal(record('build', 'verdict: pass\n## Findings\n', '1').verdict, 'done')
  assert.equal(record('build', HIGH, '2').verdict, 'continue')
  const stalled = record('build', HIGH, '2')
  assert.equal(stalled.verdict, 'blocked')
  assert.match(stalled.reason, /stall: the same finding came back/)
  const r = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/big/ratchet.json'), 'utf8'))
  assert.equal(r.slices['1'].status, 'done')
  assert.equal(r.blocked.node, 'build')
})

test('the round cap blocks: default build cap is 2 fix rounds', () => {
  assert.equal(record('build', HIGH).verdict, 'continue')
  assert.equal(record('build', HIGH2).verdict, 'continue')
  const capped = record('build', HIGH.replace('off by one', 'still off'))
  assert.equal(capped.verdict, 'blocked')
  assert.match(capped.reason, /cap: 2 fix rounds/)
})

test('build is done when every plan slice is done', () => {
  write(repo, '.sdlc/changes/big/plan.md', '## Slices\n### Task 1: a\n### Task 2: b\n')
  record('build', 'verdict: pass\n', '1')
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/big/ratchet.json'), 'utf8')).nodes.build?.status, 'done')
  record('build', 'verdict: pass\n', '2')
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/big/ratchet.json'), 'utf8')).nodes.build.status, 'done')
})

test('ratchet.json, events.jsonl, pr.md and ship.json are evidence: model edits and Bash writes are denied', () => {
  for (const f of ['.sdlc/changes/big/ratchet.json', '.sdlc/changes/big/events.jsonl', '.sdlc/changes/big/pr.md', '.sdlc/changes/big/ship.json']) {
    const edit = JSON.parse(sdlc(repo, ['hook', 'pre-edit'], { input: JSON.stringify({ tool_input: { file_path: path.join(repo, f) } }) }).stdout)
    assert.equal(edit.hookSpecificOutput.permissionDecision, 'deny', f)
  }
  for (const f of ['ratchet.json', 'ship.json']) {
    const bash = JSON.parse(sdlc(repo, ['hook', 'pre-bash'], { input: JSON.stringify({ tool_input: { command: `echo {} > .sdlc/changes/big/${f}` } }) }).stdout)
    assert.equal(bash.hookSpecificOutput.permissionDecision, 'deny', f)
  }
})

test('testCaseCount counts test cases across common frameworks', () => {
  assert.equal(testCaseCount(["test('a', () => {})\nit('b', () => {})\n  it.each([1])('c', x => {})", 'def test_x():\n    pass\n', 'func TestY(t *testing.T) {}', '@Test\nvoid z() {}']), 6)
})

test('spendUsd sums a change\'s main-turn cost, per node', () => {
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 0.5, change: 'big', stage: 'build' })])
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 0.25, change: 'big', stage: 'test' })])
  const r = JSON.parse(sdlc(repo, ['ratchet', 'spend', 'big']).stdout)
  assert.deepEqual(r, { total: 0.75, byNode: { build: 0.5, test: 0.25 } })
})
