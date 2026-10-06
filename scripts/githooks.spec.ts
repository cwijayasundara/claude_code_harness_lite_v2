// Git hooks: check --at commit and push, install, the hook scripts, warning carry-over and the model's bypass denials.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'

const SECRET = 'const apikey = "abcdefghijklmnop12345678"\n'
let repo: string
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', '{}')
})
const stage = (rel: string, text: string): void => {
  write(repo, rel, text)
  gitIn(repo, 'add', rel)
}
const commit = () => sdlc(repo, ['check', '--at', 'commit'])

test('check --at commit blocks a staged secret and ignores what is not staged', () => {
  stage('src/a.js', SECRET)
  const bad = commit()
  assert.equal(bad.code, 1)
  assert.match(bad.stdout, /secrets/)
  gitIn(repo, 'reset', '-q')
  assert.equal(commit().code, 0, 'nothing staged: nothing to judge')
  stage('src/b.js', 'export const ok = 1\n')
  write(repo, 'src/c.js', SECRET) // untracked and unstaged: not part of this commit
  assert.equal(commit().code, 0, commit().stdout)
})

test('the index is what counts, not the working copy', () => {
  stage('src/a.js', SECRET)
  write(repo, 'src/a.js', 'export const ok = 1\n') // working copy cleaned after staging
  assert.equal(commit().code, 1, 'the staged secret still blocks')
  gitIn(repo, 'reset', '-q')
  stage('src/a.js', 'export const ok = 1\n')
  write(repo, 'src/a.js', SECRET) // secret only in the working copy
  assert.equal(commit().code, 0)
})

test('staged assertion removal blocks as test-tamper', () => {
  stage('test/a.test.js', "import assert from 'node:assert'\nassert.equal(1, 1)\nassert.equal(2, 2)\n")
  gitIn(repo, 'commit', '-qm', 'tests')
  stage('test/a.test.js', "import assert from 'node:assert'\n")
  const r = commit()
  assert.equal(r.code, 1)
  assert.match(r.stdout, /test-tamper/)
})

test('a failing fast command blocks; a size warning prints but does not block', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "process.exit(1)"' }, limits: { fileLines: 5 } }))
  stage('src/a.js', 'export const a = 1\n')
  const red = commit()
  assert.equal(red.code, 1)
  assert.match(red.stdout, /fast\.test/)
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { fileLines: 5 } }))
  stage('src/big.js', Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n')
  const warn = commit()
  assert.equal(warn.code, 0)
  assert.match(warn.stdout, /size/)
})

test('file names with spaces are judged; a binary file is skipped without a crash', () => {
  stage('src/my file.js', SECRET)
  const r = commit()
  assert.equal(r.code, 1)
  assert.match(r.stdout, /my file\.js/)
  gitIn(repo, 'reset', '-q')
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0, 0, 1, 2, 3]))
  gitIn(repo, 'add', 'logo.png')
  assert.equal(commit().code, 0)
})

test('a repo with no commits yet is judged against nothing, not a crash', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-fresh-'))
  gitIn(fresh, 'init', '-q', '-b', 'main')
  write(fresh, '.sdlc/sensors.json', '{}')
  write(fresh, 'src/a.js', SECRET)
  gitIn(fresh, 'add', 'src/a.js')
  const r = sdlc(fresh, ['check', '--at', 'commit'])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /secrets/)
})

test('a merge or rebase in progress is skipped, and the skip says so', () => {
  stage('src/a.js', SECRET)
  const rebase = sdlc(repo, ['check', '--at', 'commit'], { env: { GIT_REFLOG_ACTION: 'rebase (pick)' } })
  assert.equal(rebase.code, 0)
  assert.match(rebase.stdout, /skipped/)
  fs.writeFileSync(path.join(repo, '.git/MERGE_HEAD'), gitIn(repo, 'rev-parse', 'HEAD') + '\n')
  const merge = commit()
  assert.equal(merge.code, 0)
  assert.match(merge.stdout, /skipped/)
})
