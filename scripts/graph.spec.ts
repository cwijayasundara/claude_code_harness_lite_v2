// The stage graph: paths per type and tier, gates from config, legacy v0.3 changes.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn, verified } from './testkit.ts'

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
  write(repo, '.sdlc/changes/tiny/pr.md', '---\nstate: local-only\n---\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'pr')
  assert.match(sdlc(repo, ['status']).stdout, /▶ tiny/)
})
