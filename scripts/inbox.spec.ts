// The intent inbox (.sdlc/intent/): files people write before a change exists, and the changes that come from them.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write } from './testkit.ts'

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
