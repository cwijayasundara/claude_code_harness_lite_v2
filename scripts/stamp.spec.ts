// The tree stamp: a content fingerprint of the working tree that survives commits and ignores harness evidence.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

let repo: string
const stamp = (r = repo): string => sdlc(r, ['stamp']).stdout.trim()
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.gitignore', 'dist\n')
  write(repo, 'src/a.js', 'export const a = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
})

test('the stamp is stable, and changes with an edit, an untracked file, the sensors config and a deletion', () => {
  const clean = stamp()
  assert.match(clean, /^[0-9a-f]{16}$/)
  assert.equal(stamp(), clean)
  write(repo, 'src/a.js', 'export const a = 2\n')
  const edited = stamp()
  assert.notEqual(edited, clean)
  write(repo, 'src/b.js', 'export const b = 1\n')
  const added = stamp()
  assert.notEqual(added, edited)
  write(repo, '.sdlc/sensors.json', '{"limits":{"fileLines":50}}')
  assert.notEqual(stamp(), added)
  fs.rmSync(path.join(repo, 'src/a.js'))
  assert.notEqual(stamp(), added)
})

test('touching a file or churning .sdlc evidence or an ignored file does not change the stamp', () => {
  const clean = stamp()
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(repo, 'src/a.js'), t, t)
  write(repo, '.sdlc/changes/x/runs.jsonl', '{}\n')
  write(repo, 'dist/out.js', 'built\n')
  assert.equal(stamp(), clean)
})

test('committing the same content keeps the stamp, so the pr commit does not invalidate it', () => {
  write(repo, 'src/b.js', 'export const b = 1\n')
  const before = stamp()
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'more')
  assert.equal(stamp(), before)
})

test('a repository with no commits has no stamp', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-nohead-'))
  gitIn(bare, 'init', '-q', '-b', 'main')
  assert.equal(stamp(bare), 'none')
})

test('a linked worktree gets the same stamp as the main checkout for the same content', () => {
  const wt = path.join(os.tmpdir(), `rig-wt-${Date.now()}`)
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'other', wt)
  assert.equal(stamp(wt), stamp())
  gitIn(repo, 'worktree', 'remove', '--force', wt)
})
