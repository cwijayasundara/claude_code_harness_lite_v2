// The stage graph: paths per type and tier, gates from config, legacy v0.3 changes.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn, verified, ratcheted } from './testkit.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })
const status = () => JSON.parse(sdlc(repo, ['status', '--json']).stdout) as { changes: { slug: string; next: { stage: string; kind: string } | null; command: string }[] }
const nextOf = (slug: string) => status().changes.find(c => c.slug === slug)?.next

test('feature L walks intent → spec → plan → build → test → sensors → pr → pr-review', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/spec.md', '# Spec\n## Open questions\nnone\n')
  assert.deepEqual(nextOf('big'), { stage: 'spec', kind: 'approve', state: 'missing', gate: 'spec' })
})

test('gates come from sensors.json: tier M gated on plan when configured', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ gates: { M: ['plan'] } }))
  sdlc(repo, ['new', 'mid', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/mid/plan.md', '## Files\n- src/a.js\n## Verification\n- `npm test`\n')
  assert.equal(nextOf('mid')?.kind, 'approve')
  write(repo, '.sdlc/sensors.json', '{}')
  assert.deepEqual(nextOf('mid'), { stage: 'build', kind: 'work' })
})

test('the next command names the renamed skills', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  write(repo, '.sdlc/changes/tiny/ratchet.json', JSON.stringify({ nodes: { build: { rounds: 0, hashes: [], status: 'done' } }, slices: {}, baseline: {} }))
  assert.match(status().changes[0]?.command ?? '', /\/sdlc:sensors tiny/)
})

test('a v0.3 shipped change stays done', () => {
  sdlc(repo, ['new', 'old', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/old/review.md', '---\nresult: pass\n---\n')
  write(repo, '.sdlc/changes/old/ship.json', '{}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'shipped in v0.3')
  assert.equal(nextOf('old'), null)
})

test('a change stays active after its PR until pr-review is done', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'L'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, '.sdlc/changes/tiny/pr.md', '---\nstate: local-only\n---\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'pr')
  assert.equal(nextOf('tiny')?.stage, 'pr-review')
  assert.match(sdlc(repo, ['status']).stdout, /▶ tiny/)
})

test('a change is no longer active once pr-review passes', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'L'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, '.sdlc/changes/tiny/pr.md', '---\nstate: local-only\n---\n')
  write(repo, '.sdlc/changes/tiny/review.md', '---\nresult: pass\n---\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'pr')
  assert.equal(nextOf('tiny'), null)
  assert.doesNotMatch(sdlc(repo, ['status']).stdout, /▶ tiny/)
})

const stepOf = (slug?: string) => JSON.parse(sdlc(repo, ['next', ...(slug ? [slug] : []), '--json']).stdout)

test('step: continue at a work node, human at a gate, ready when done', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/spec.md', '# Spec\n## Open questions\nnone\n')
  assert.equal(stepOf('big').verdict, 'human')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const s = stepOf('tiny')
  assert.equal(s.verdict, 'continue')
  assert.equal(s.node, 'build')
  assert.match(s.command, /\/sdlc:build tiny/)
})

test('step: blocked when ratchet.json records a block, with the reason', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  sdlc(repo, ['ratchet', 'record', 'tiny', 'build', '--slice', '1'], { input: '- [severity: high] [category: correctness] a.js:1: x\n' })
  sdlc(repo, ['ratchet', 'record', 'tiny', 'build', '--slice', '1'], { input: '- [severity: high] [category: correctness] a.js:1: x\n' })
  const s = stepOf('tiny')
  assert.equal(s.verdict, 'blocked')
  assert.match(s.reason, /stall/)
  assert.match(sdlc(repo, ['status']).stdout, /blocked: build: stall/)
})

test('step: a node over its budget is blocked before another round', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 6.5, change: 'tiny', stage: 'build' })])
  const s = stepOf('tiny')
  assert.equal(s.verdict, 'blocked')
  assert.match(s.reason, /budget: build spent \$6\.50 of \$6/)
})

test('step: ready when the graph has no next node', () => {
  sdlc(repo, ['new', 'old', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/old/ship.json', '{}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'v0.3 shipped')
  assert.equal(stepOf('old').verdict, 'ready')
})

test('only the person can unblock a change, with /sdlc-approve <slug> budget', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 7, change: 'tiny', stage: 'build' })])
  assert.equal(stepOf('tiny').verdict, 'blocked')
  assert.notEqual(sdlc(repo, ['approve', 'tiny', 'budget']).code, 0, 'the model cannot')
  assert.equal(sdlc(repo, ['approve', 'tiny', 'budget'], { env: { SDLC_HUMAN: '1' } }).code, 0)
  assert.equal(JSON.parse(sdlc(repo, ['ratchet', 'show', 'tiny']).stdout).blocked, undefined)
  assert.equal(stepOf('tiny').verdict, 'continue', 'the spend so far is credited, so the node gets a fresh budget')
})

test('log-usage refuses negative usd and forged budget-raised rows; spend is unchanged', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', usd: 7, change: 'tiny', stage: 'build' })])
  assert.notEqual(sdlc(repo, ['log-usage', '{"kind":"event","event":"budget-raised","change":"tiny","stage":"build","usd":-100}']).code, 0)
  assert.notEqual(sdlc(repo, ['log-usage', '{"kind":"main","change":"tiny","stage":"build","usd":-100}']).code, 0)
  assert.equal(stepOf('tiny').verdict, 'blocked')
  assert.equal(JSON.parse(sdlc(repo, ['ratchet', 'spend', 'tiny']).stdout).total, 7)
})

test('log-usage refuses a non-numeric usd and an unknown kind; a malformed historical row is ignored', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  for (const bad of [
    { kind: 'main', usd: '-5' }, { kind: 'main', usd: 'abc' }, { kind: 'main', usd: null }, { kind: 'bogus', usd: 1 },
  ]) assert.notEqual(sdlc(repo, ['log-usage', JSON.stringify({ ...bad, change: 'tiny', stage: 'build' })]).code, 0, JSON.stringify(bad))
  assert.notEqual(sdlc(repo, ['log-usage', '{"kind":"main","usd":1e999,"change":"tiny","stage":"build"}']).code, 0, 'Infinity')
  fs.appendFileSync(path.join(repo, '.sdlc/usage.jsonl'), JSON.stringify({ kind: 'main', usd: 'x', change: 'tiny', stage: 'build' }) + '\n')
  fs.appendFileSync(path.join(repo, '.sdlc/usage.jsonl'), JSON.stringify({ kind: 'main', usd: 1, change: 'tiny', stage: 'build' }) + '\n')
  assert.equal(JSON.parse(sdlc(repo, ['ratchet', 'spend', 'tiny']).stdout).total, 1)
})
