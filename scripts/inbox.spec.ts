// The intent inbox (.sdlc/intent/): files people write before a change exists, and the changes that come from them.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })
const intent = (file: string, fm: string, body = '## Problem\nCustomers phone to ask where their claim is.\n') =>
  write(repo, `.sdlc/intent/${file}`, `---\n${fm}\n---\n# Intent\n\n${body}`)

test('new --source records the inbox file in intent.md and refuses paths outside the inbox', () => {
  intent('claims-status.md', 'status: accepted')
  const ok = sdlc(repo, ['new', 'claims-status', '--type', 'feature', '--tier', 'M', '--source', '.sdlc/intent/claims-status.md'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/claims-status/intent.md'), 'utf8'), /^source: \.sdlc\/intent\/claims-status\.md$/m)
  const bad = ['../x.md', '.sdlc/intent/../../etc.md', '.sdlc/intent/missing.md', '.sdlc/intent/claims-status.txt', 'README.md']
  bad.forEach((source, i) => {
    const r = sdlc(repo, ['new', `other-${i}`, '--source', source])
    assert.notEqual(r.code, 0, source)
    assert.match(r.stderr, /--source/, source)
    assert.equal(fs.existsSync(path.join(repo, `.sdlc/changes/other-${i}`)), false, `${source}: no change folder is created`)
  })
})

test('new without --source writes no source line', () => {
  sdlc(repo, ['new', 'plain', '--type', 'chore', '--tier', 'S'])
  assert.doesNotMatch(fs.readFileSync(path.join(repo, '.sdlc/changes/plain/intent.md'), 'utf8'), /^source:/m)
})

type Entry = { file: string; status: string; change: string | null; type: string | null; tier: string | null; model: string }
const inbox = (...args: string[]): Entry[] => JSON.parse(sdlc(repo, ['inbox', '--json', ...args]).stdout) as Entry[]

test('inbox lists every intent with its status; shipped comes from the change that names it', () => {
  intent('a-draft.md', 'status: draft')
  intent('b-closed.md', 'status: closed')
  intent('c-shipped.md', 'status: accepted')
  intent('d-odd.md', 'status: maybe')
  sdlc(repo, ['new', 'c-change', '--type', 'chore', '--tier', 'S', '--source', '.sdlc/intent/c-shipped.md'])
  write(repo, '.sdlc/changes/c-change/ship.json', '{}')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'ship c')
  assert.deepEqual(inbox().map(e => [e.file, e.status, e.change]), [
    ['a-draft.md', 'draft', null], ['b-closed.md', 'closed', null], ['c-shipped.md', 'shipped', 'c-change'], ['d-odd.md', 'unknown', null],
  ])
})

test('--pending: accepted, no change, a kebab name, and no rig-spec branch on the remote yet', () => {
  intent('one.md', 'status: accepted\ntier: M\ntype: feature')
  intent('two.md', 'status: accepted')
  intent('three.md', 'status: draft')
  intent('Has Space.md', 'status: accepted')
  intent('four.md', 'status: accepted')
  sdlc(repo, ['new', 'four-change', '--type', 'chore', '--tier', 'S', '--source', '.sdlc/intent/four.md'])
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'inbox')
  gitIn(repo, 'update-ref', 'refs/remotes/origin/sdlc/intent-two', 'HEAD')
  assert.deepEqual(inbox('--pending').map(e => e.file), ['one.md'])
})

test('the model follows the intent tier: Opus for greenfield, a missing tier or an invalid one', () => {
  intent('s.md', 'status: accepted\ntier: S')
  intent('m.md', 'status: accepted\ntier: M')
  intent('g.md', 'status: accepted\ntier: S\ntype: greenfield')
  intent('x.md', 'status: accepted')
  intent('bad.md', 'status: accepted\ntier: XL')
  assert.deepEqual(Object.fromEntries(inbox().map(e => [e.file, e.model])), { 'bad.md': 'opus', 'g.md': 'opus', 'm.md': 'sonnet', 's.md': 'haiku', 'x.md': 'opus' })
})

test('an empty or missing inbox lists nothing', () => {
  assert.deepEqual(inbox(), [])
  assert.match(sdlc(repo, ['inbox']).stdout, /intent inbox is empty/)
})

test('status names accepted intents that have no change yet; the per-turn band does not read the inbox', () => {
  intent('one.md', 'status: accepted')
  sdlc(repo, ['new', 'other', '--type', 'chore', '--tier', 'S'])
  assert.match(sdlc(repo, ['status']).stdout, /^warn: intent one\.md is accepted and has no change: \/rig:start \.sdlc\/intent\/one\.md$/m)
  assert.doesNotMatch(sdlc(repo, ['status', '--json', '--band']).stdout, /one\.md/)
})

test('metrics: inbox survival over decided intents; intent churn after design is reported', () => {
  for (const [f, s] of [['a.md', 'accepted'], ['b.md', 'accepted'], ['c.md', 'accepted'], ['d.md', 'accepted'], ['e.md', 'closed'], ['f.md', 'draft']] as [string, string][]) intent(f, `status: ${s}`)
  const m = JSON.parse(sdlc(repo, ['metrics', '--json']).stdout).metrics
  assert.deepEqual({ value: m.inbox_survival.value, n: m.inbox_survival.n }, { value: 0.8, n: 5 })
  assert.ok('intent_churn_after_design' in m)
})
