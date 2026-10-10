// The intent inbox (.rig/intent/): files people write before a change exists, and the changes that come from them.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })
const intent = (file: string, fm: string, body = '## Problem\nCustomers phone to ask where their claim is.\n') =>
  write(repo, `.rig/intent/${file}`, `---\n${fm}\n---\n# Intent\n\n${body}`)

test('new --source records the inbox file in intent.md and refuses paths outside the inbox', () => {
  intent('claims-status.md', 'status: accepted')
  const ok = sdlc(repo, ['new', 'claims-status', '--type', 'feature', '--tier', 'M', '--source', '.rig/intent/claims-status.md'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.match(fs.readFileSync(path.join(repo, '.rig/changes/claims-status/intent.md'), 'utf8'), /^source: \.rig\/intent\/claims-status\.md$/m)
  const bad = ['../x.md', '.rig/intent/../../etc.md', '.rig/intent/missing.md', '.rig/intent/claims-status.txt', 'README.md']
  bad.forEach((source, i) => {
    const r = sdlc(repo, ['new', `other-${i}`, '--source', source])
    assert.notEqual(r.code, 0, source)
    assert.match(r.stderr, /--source/, source)
    assert.equal(fs.existsSync(path.join(repo, `.rig/changes/other-${i}`)), false, `${source}: no change folder is created`)
  })
})

test('new without --source writes no source line', () => {
  sdlc(repo, ['new', 'plain', '--type', 'chore', '--tier', 'S'])
  assert.doesNotMatch(fs.readFileSync(path.join(repo, '.rig/changes/plain/intent.md'), 'utf8'), /^source:/m)
})

type Entry = { file: string; status: string; change: string | null; type: string | null; tier: string | null; model: string }
const inbox = (...args: string[]): Entry[] => JSON.parse(sdlc(repo, ['inbox', '--json', ...args]).stdout) as Entry[]

test('inbox lists every intent with its status; shipped comes from the change that names it', () => {
  intent('a-draft.md', 'status: draft')
  intent('b-closed.md', 'status: closed')
  intent('c-shipped.md', 'status: accepted')
  intent('d-odd.md', 'status: maybe')
  sdlc(repo, ['new', 'c-change', '--type', 'chore', '--tier', 'S', '--source', '.rig/intent/c-shipped.md'])
  write(repo, '.rig/changes/c-change/ship.json', '{}')
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
  sdlc(repo, ['new', 'four-change', '--type', 'chore', '--tier', 'S', '--source', '.rig/intent/four.md'])
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
  assert.match(sdlc(repo, ['status']).stdout, /^warn: intent one\.md is accepted and has no change: \/rig:start \.rig\/intent\/one\.md$/m)
  assert.doesNotMatch(sdlc(repo, ['status', '--json', '--band']).stdout, /one\.md/)
})

test('metrics: inbox survival over decided intents; intent churn after design is reported', () => {
  for (const [f, s] of [['a.md', 'accepted'], ['b.md', 'accepted'], ['c.md', 'accepted'], ['d.md', 'accepted'], ['e.md', 'closed'], ['f.md', 'draft']] as [string, string][]) intent(f, `status: ${s}`)
  const m = JSON.parse(sdlc(repo, ['metrics', '--json']).stdout).metrics
  assert.deepEqual({ value: m.inbox_survival.value, n: m.inbox_survival.n }, { value: 0.8, n: 5 })
  assert.ok('intent_churn_after_design' in m)
})

type StepJson = { verdict: string; node: string | null; reason: string; command: string }
const next = (slug: string): StepJson => JSON.parse(sdlc(repo, ['next', slug, '--json']).stdout) as StepJson

test('a published draft (source:, no ratchet.json) waits for /rig-approve tier before any node, then takes its own path', () => {
  intent('fix-z.md', 'status: accepted\ntype: bugfix\ntier: S')
  assert.equal(sdlc(repo, ['new', 'fix-z', '--type', 'bugfix', '--tier', 'S', '--source', '.rig/intent/fix-z.md']).code, 0)
  fs.rmSync(path.join(repo, '.rig/changes/fix-z/ratchet.json'))
  const waiting = next('fix-z')
  assert.equal(waiting.verdict, 'human')
  assert.match(waiting.command, /^\/rig-approve fix-z tier S bugfix$/)
  assert.match(waiting.reason, /no recorded tier/)
  const ok = sdlc(repo, ['approve', 'fix-z', 'tier', 'S', 'bugfix'], { env: { SDLC_HUMAN: '1' } })
  assert.equal(ok.code, 0, ok.stderr)
  const after = next('fix-z')
  assert.equal(after.verdict, 'continue')
  assert.notEqual(after.node, 'design')
  assert.equal(after.node, 'diagnose')
})

test('status names the same next command as next while a published draft waits for its tier', () => {
  intent('fix-z.md', 'status: accepted\ntype: bugfix\ntier: S')
  sdlc(repo, ['new', 'fix-z', '--type', 'bugfix', '--tier', 'S', '--source', '.rig/intent/fix-z.md'])
  fs.rmSync(path.join(repo, '.rig/changes/fix-z/ratchet.json'))
  const out = sdlc(repo, ['status']).stdout
  assert.match(out, /^next: \/rig-approve fix-z tier S bugfix$/m)
  assert.doesNotMatch(out, /^next: \/rig:design/m)
})

test('a legacy change with no source: and no recorded tier keeps the old behaviour', () => {
  sdlc(repo, ['new', 'old-y', '--type', 'bugfix', '--tier', 'S'])
  fs.rmSync(path.join(repo, '.rig/changes/old-y/ratchet.json'))
  const s = next('old-y')
  assert.equal(s.verdict, 'continue')
  assert.equal(s.node, 'design')
})

test('status text names a waiting intent in a repo with no changes yet', () => {
  intent('one.md', 'status: accepted')
  const out = sdlc(repo, ['status']).stdout
  assert.match(out, /no changes yet/)
  assert.match(out, /warn: intent one\.md is accepted and has no change/)
})
