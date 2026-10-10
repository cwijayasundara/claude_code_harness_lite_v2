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

test('feature L walks intent → design → build → test → sensors → pr → pr-review', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  assert.deepEqual(nextOf('big'), { stage: 'design', kind: 'work' })
  write(repo, '.rig/changes/big/design.md', '## Files\n- src/a.js\n## Verification\n- `npm test`\n## Open questions\nnone\n')
  assert.deepEqual(nextOf('big'), { stage: 'design', kind: 'approve', state: 'missing', gate: 'design' })
  sdlc(repo, ['approve', 'big', 'design'], { env: { SDLC_HUMAN: '1' } })
  assert.deepEqual(nextOf('big'), { stage: 'build', kind: 'work' })
  write(repo, '.rig/changes/big/intent.md', fs.readFileSync(path.join(repo, '.rig/changes/big/intent.md'), 'utf8') + '\nedited\n')
  assert.equal(nextOf('big')?.kind, 'approve', 'one approval covers intent.md too, so editing it makes the approval stale')
})

test('gates come from sensors.json: tier M is gated on design by default and on nothing when configured so', () => {
  sdlc(repo, ['new', 'mid', '--type', 'feature', '--tier', 'M'])
  write(repo, '.rig/changes/mid/design.md', '## Files\n- src/a.js\n## Verification\n- `npm test`\n')
  assert.deepEqual(nextOf('mid'), { stage: 'design', kind: 'approve', state: 'missing', gate: 'design' })
  write(repo, '.rig/sensors.json', JSON.stringify({ gates: { M: [] } }))
  assert.deepEqual(nextOf('mid'), { stage: 'build', kind: 'work' })
})

test('the next command names the renamed skills', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  write(repo, '.rig/changes/tiny/ratchet.json', JSON.stringify({ tier: 'S', type: 'chore', nodes: { build: { rounds: 0, hashes: [], status: 'done' } }, slices: {}, baseline: {} }))
  assert.match(status().changes[0]?.command ?? '', /\/rig:sensors tiny/)
})

test('a v0.3 shipped change stays done', () => {
  sdlc(repo, ['new', 'old', '--type', 'feature', '--tier', 'M'])
  write(repo, '.rig/changes/old/review.md', '---\nresult: pass\n---\n')
  write(repo, '.rig/changes/old/ship.json', '{}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'shipped in v0.3')
  assert.equal(nextOf('old'), null)
})

test('a change stays active after its PR until pr-review is done', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'L'])
  write(repo, '.rig/sensors.json', JSON.stringify({ levels: { acceptance: 'node -e "process.exit(0)"' } }))
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, '.rig/changes/tiny/pr.md', '---\nstate: local-only\n---\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'pr')
  assert.equal(nextOf('tiny')?.stage, 'pr-review')
  assert.match(sdlc(repo, ['status']).stdout, /▶ tiny/)
})

test('a change is no longer active once pr-review passes', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'L'])
  write(repo, '.rig/sensors.json', JSON.stringify({ levels: { acceptance: 'node -e "process.exit(0)"' } }))
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, '.rig/changes/tiny/pr.md', '---\nstate: local-only\n---\n')
  write(repo, '.rig/changes/tiny/review.md', '---\nresult: pass\n---\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'pr')
  assert.equal(nextOf('tiny'), null)
  assert.doesNotMatch(sdlc(repo, ['status']).stdout, /▶ tiny/)
})

const stepOf = (slug?: string) => JSON.parse(sdlc(repo, ['next', ...(slug ? [slug] : []), '--json']).stdout)

test('step: continue at a work node, human at a gate, ready when done', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  assert.equal(stepOf('big').verdict, 'continue')
  write(repo, '.rig/changes/big/design.md', '## Files\n- src/a.js\n## Open questions\nnone\n')
  assert.equal(stepOf('big').verdict, 'human')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const s = stepOf('tiny')
  assert.equal(s.verdict, 'continue')
  assert.equal(s.node, 'build')
  assert.match(s.command, /\/rig:build tiny/)
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
  write(repo, '.rig/changes/old/ship.json', '{}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'v0.3 shipped')
  assert.equal(stepOf('old').verdict, 'ready')
})

test('only the person can unblock a change, with /rig:approve <slug> budget', () => {
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
  fs.appendFileSync(path.join(repo, '.rig/usage.jsonl'), JSON.stringify({ kind: 'main', usd: 'x', change: 'tiny', stage: 'build' }) + '\n')
  fs.appendFileSync(path.join(repo, '.rig/usage.jsonl'), JSON.stringify({ kind: 'main', usd: 1, change: 'tiny', stage: 'build' }) + '\n')
  assert.equal(JSON.parse(sdlc(repo, ['ratchet', 'spend', 'tiny']).stdout).total, 1)
})

test('R46: gate and level blocks resume at the current node; cap, stall, budget and other stay blocked', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const at = (kind: string) => write(repo, '.rig/changes/tiny/ratchet.json', JSON.stringify({ nodes: {}, slices: {}, baseline: {}, blocked: { node: 'build', reason: `why-${kind}`, at: 'now', kind } }))
  for (const kind of ['gate', 'level']) {
    at(kind)
    const s = stepOf('tiny')
    assert.equal(s.verdict, 'continue', kind)
    assert.match(s.reason, new RegExp(`pending block.*why-${kind}`), kind)
  }
  for (const kind of ['cap', 'stall', 'budget', 'other']) {
    at(kind)
    assert.equal(stepOf('tiny').verdict, 'blocked', kind)
  }
  write(repo, '.rig/changes/tiny/ratchet.json', JSON.stringify({ nodes: {}, slices: {}, baseline: {}, blocked: { node: 'build', reason: 'no kind', at: 'now' } }))
  assert.equal(stepOf('tiny').verdict, 'blocked', 'a legacy block without a kind is other')
})

test('step reports how many build slices are done, so the driver sees partial progress', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  assert.equal(stepOf('tiny').progress, 0)
  const done = { rounds: 0, hashes: [], status: 'done' }
  write(repo, '.rig/changes/tiny/ratchet.json', JSON.stringify({ tier: 'S', type: 'chore', nodes: {}, slices: { 1: done, 2: { ...done, status: 'open' }, 3: done }, baseline: {} }))
  assert.equal(stepOf('tiny').progress, 2)
})

test('next --json names the model for the tier: S haiku, M sonnet, L opus, greenfield opus at any tier', () => {
  const cases: [string, string, string, string][] = [['s1', 'feature', 'S', 'haiku'], ['m1', 'refactor', 'M', 'sonnet'], ['l1', 'bugfix', 'L', 'opus'], ['g1', 'greenfield', 'S', 'opus']]
  for (const [slug, type, tier, model] of cases) {
    sdlc(repo, ['new', slug, '--type', type, '--tier', tier])
    assert.equal(stepOf(slug).model, model, `${type} ${tier}`)
  }
})

test('the model follows the effective tier: lowering tier in intent.md does not lower the model', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  const f = path.join(repo, '.rig/changes/big/intent.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^tier: L$/m, 'tier: S'))
  assert.equal(stepOf('big').model, 'opus')
})

test('next --json carries routes for every role from the effective tier', () => {
  sdlc(repo, ['new', 'rs', '--type', 'feature', '--tier', 'S'])
  const s = stepOf('rs')
  assert.deepEqual(s.routes.implementer, { model: 'haiku', effort: 'medium' })
  assert.deepEqual(s.routes.reviewer, { model: 'sonnet', effort: 'medium' })
  assert.equal(s.routes.architect, 'main')
  assert.equal(s.model, 'haiku', 'the legacy tier model is kept for vendored skills')
})

test('lowering tier in intent.md on an L change keeps the L routes', () => {
  sdlc(repo, ['new', 'rl', '--type', 'feature', '--tier', 'L'])
  const f = path.join(repo, '.rig/changes/rl/intent.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^tier: L$/m, 'tier: S'))
  const s = stepOf('rl')
  assert.deepEqual(s.routes.architect, { model: 'opus', effort: 'high' })
  assert.deepEqual(s.routes.implementer, { model: 'sonnet', effort: 'high' })
})

test('an override below a floor is clamped and next warns naming the role', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ routing: { reviewer: { S: 'haiku' } } }))
  sdlc(repo, ['new', 'rw', '--type', 'feature', '--tier', 'S'])
  const s = stepOf('rw')
  assert.equal(s.routes.reviewer.model, 'sonnet')
  assert.match(s.routeWarnings.join('\n'), /reviewer/)
  assert.match(sdlc(repo, ['next', 'rw']).stderr, /reviewer.*floor/)
})

test('the build retry follows the open slice only: a failed earlier slice does not lift the next one', () => {
  sdlc(repo, ['new', 'rt', '--type', 'chore', '--tier', 'S'])
  const sl = (rounds: number, status: string) => ({ rounds, hashes: [], status })
  const ratchet = (slices: object) => write(repo, '.rig/changes/rt/ratchet.json', JSON.stringify({ tier: 'S', type: 'chore', nodes: {}, slices, baseline: {} }))
  ratchet({ 1: sl(1, 'done'), 2: sl(0, 'open') })
  assert.deepEqual(stepOf('rt').routes.implementer, { model: 'haiku', effort: 'medium' })
  ratchet({ 1: sl(0, 'done'), 2: sl(1, 'open') })
  assert.deepEqual(stepOf('rt').routes.implementer, { model: 'haiku', effort: 'high' })
})
