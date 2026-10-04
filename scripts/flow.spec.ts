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
  write(repo, '.sdlc/changes/big/design.md', '## Files\n- src/a.js\n## Open questions\nnone\n')
  assert.match(line(), /^init:done start:done design:gate build:todo/)
  sdlc(repo, ['approve', 'big', 'design'], { env: { SDLC_HUMAN: '1' } })
  assert.match(line(), /^init:done start:done design:done build:current test:todo/)
  assert.match(sdlc(repo, ['status']).stdout, /flow: init ✓ → start ✓ → design ✓ → \[build\]/)
})
