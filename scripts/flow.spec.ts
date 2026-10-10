// The flow map: every step from init to the PR, with the current one marked.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, sdlc, write } from './testkit.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })
const flow = () => (JSON.parse(sdlc(repo, ['status', '--json']).stdout) as { flow: { label: string; state: string }[] }).flow
const line = () => flow().map(f => `${f.label}:${f.state}`).join(' ')

test('before init the flow points at init; once a change exists it follows the change', () => {
  assert.equal(line(), 'init:current start:todo design:todo build:todo test:todo sensors:todo pr:todo')
})

test('a feature shows init and intent done, design at its gate, the rest to do', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.rig/changes/big/design.md', '## Files\n- src/a.js\n## Open questions\nnone\n')
  assert.match(line(), /^init:done start:done design:gate build:todo/)
  sdlc(repo, ['approve', 'big', 'design'], { env: { SDLC_HUMAN: '1' } })
  assert.match(line(), /^init:done start:done design:done build:current test:todo/)
  assert.match(sdlc(repo, ['status']).stdout, /flow: init ✓ → start ✓ → design ✓ → \[build\]/)
})

test('the impact approval follows design.md, and an approved plan.md is not replaced by a later design.md', () => {
  sdlc(repo, ['new', 'xx', '--type', 'feature', '--tier', 'L'])
  write(repo, '.rig/changes/xx/design.md', '## Files\n- src/a.js\n## Open questions\nnone\n')
  write(repo, '.rig/changes/xx/impact.json', JSON.stringify({ ids: ['a'], hits: [{ repo: 'r', file: 'f', line: 1 }], missing: [] }))
  const human = { env: { SDLC_HUMAN: '1' } }
  const r = sdlc(repo, ['approve', 'xx', 'impact'], human); assert.equal(r.code, 0, r.stderr)
  write(repo, '.rig/changes/xx/design.md', '## Files\n- src/**\n## Open questions\nnone\n')
  assert.match(sdlc(repo, ['next', 'xx', '--json']).stdout, /impact|design/, 'editing design.md invalidates the impact approval')
  assert.equal(JSON.parse(sdlc(repo, ['next', 'xx', '--json']).stdout).verdict, 'human')

  sdlc(repo, ['new', 'yy', '--type', 'refactor', '--tier', 'L'])
  write(repo, '.rig/changes/yy/plan.md', '## Files\n- src/a.js\n## Open questions\nnone\n')
  sdlc(repo, ['approve', 'yy', 'plan'], human)
  write(repo, '.rig/changes/yy/design.md', '## Files\n- **\n')
  write(repo, 'other.txt', 'x')
  assert.match(sdlc(repo, ['scope-drift', 'yy']).stdout, /other\.txt/, 'the stray design.md (**) must not widen the scope of the approved plan.md')
})
