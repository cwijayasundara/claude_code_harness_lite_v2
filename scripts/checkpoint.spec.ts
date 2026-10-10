// Each recorded build slice is committed by the script on sdlc/<slug>: only that slice's planned files, never the trunk, never a push.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

const GREEN = 'node -e "process.exit(0)"'
let repo: string
function setup(branch = 'sdlc/feat') {
  write(repo, '.rig/sensors.json', JSON.stringify({ fast: { test: GREEN } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  if (branch !== 'main') gitIn(repo, 'checkout', '-qb', branch)
  sdlc(repo, ['new', 'feat', '--type', 'feature', '--tier', 'M'])
  write(repo, '.rig/changes/feat/plan.md', '## Files\n- src/a.js\n- src/b.js\n- test/a.test.js\n## Slices\n### Task 1: a\nFiles: `src/a.js` `test/a.test.js`\n### Task 2: b\nFiles: `src/b.js`\n')
  write(repo, 'src/a.js', 'export const a = 1\n')
  write(repo, 'test/a.test.js', "test('B1 a', () => {})\n")
  write(repo, 'src/b.js', 'export const b = 1\n')
}
const record = (slice: string) => {
  sdlc(repo, ['run', '--slug', 'feat', '--', GREEN])
  return sdlc(repo, ['ratchet', 'record', 'feat', 'build', '--slice', slice, '--checks'])
}
const subjects = (): string[] => gitIn(repo, 'log', '--format=%s', 'main..HEAD').split('\n').filter(Boolean)
beforeEach(() => { repo = makeRepo() })

test('a recorded slice is committed with only its own files', () => {
  setup()
  const r = record('1')
  assert.equal(r.code, 0, r.stderr)
  assert.match(JSON.parse(r.stdout).commit, /^[0-9a-f]{7,}$/)
  assert.deepEqual(subjects(), ['sdlc/feat: slice 1'])
  assert.deepEqual(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['src/a.js', 'test/a.test.js'])
  assert.match(gitIn(repo, 'status', '--porcelain'), /src\/b\.js/, 'slice 2 work stays uncommitted')
})

test('the second slice adds its own commit; ratchet show lists both done', () => {
  setup()
  record('1'); record('2')
  assert.deepEqual(subjects(), ['sdlc/feat: slice 2', 'sdlc/feat: slice 1'])
  const r = JSON.parse(sdlc(repo, ['ratchet', 'show', 'feat']).stdout)
  assert.equal(r.slices['1'].status, 'done')
  assert.equal(r.slices['2'].status, 'done')
})

test('on the trunk nothing is committed but the slice is still recorded', () => {
  setup('main')
  const r = record('1')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).commit, null)
  assert.equal(gitIn(repo, 'rev-list', '--count', 'HEAD'), '2', 'no new commit on main')
})

test('files the user staged outside the slice are not swept into the commit', () => {
  setup()
  write(repo, 'notes.txt', 'mine\n')
  gitIn(repo, 'add', 'notes.txt')
  record('1')
  assert.ok(!gitIn(repo, 'show', '--name-only', '--format=', 'HEAD').includes('notes.txt'))
  assert.match(gitIn(repo, 'status', '--porcelain'), /A\s+notes\.txt/, 'still staged')
})

test('a failed commit leaves the slice not done', () => {
  setup()
  gitIn(repo, 'config', 'commit.gpgsign', 'true')
  gitIn(repo, 'config', 'gpg.program', 'false')
  const r = record('1')
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /could not commit slice 1/)
  const state = JSON.parse(sdlc(repo, ['ratchet', 'show', 'feat']).stdout)
  assert.notEqual(state.slices['1']?.status, 'done')
})

test('a slice with no changed planned files records without a commit', () => {
  setup()
  gitIn(repo, 'add', 'src/a.js', 'test/a.test.js'); gitIn(repo, 'commit', '-qm', 'already committed')
  const r = record('1')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).commit, null)
})

const files = (rev = 'HEAD') => gitIn(repo, 'show', '--name-status', '--format=', rev).split('\n').sort()
function plan(list: string[]) {
  fs.rmSync(path.join(repo, 'src/b.js')); fs.rmSync(path.join(repo, 'test/a.test.js'))
  write(repo, '.rig/changes/feat/plan.md', `## Files\n${list.map(f => `- ${f}`).join('\n')}\n## Slices\n### Task 1: a\n`)
}

test('planned deletions (git rm and unstaged) are committed with the slice', () => {
  setup()
  write(repo, 'src/x.js', 'x\n'); write(repo, 'src/y.js', 'y\n')
  gitIn(repo, 'add', 'src/x.js', 'src/y.js'); gitIn(repo, 'commit', '-qm', 'old')
  plan(['src/a.js', 'src/x.js', 'src/y.js'])
  gitIn(repo, 'rm', '-q', 'src/x.js'); fs.rmSync(path.join(repo, 'src/y.js'))
  const r = record('1')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(files(), ['A\tsrc/a.js', 'D\tsrc/x.js', 'D\tsrc/y.js'])
})

test('pathspec magic in a planned name stays literal', () => {
  setup()
  plan(['src/a.js', 'src/a[y].js', 'src/ay.js'])
  write(repo, '.rig/changes/feat/plan.md', '## Files\n- src/a.js\n- src/a[y].js\n- src/ay.js\n## Slices\n### Task 1: lit\nFiles: `src/a.js` `src/a[y].js`\n### Task 2: other\nFiles: `src/ay.js`\n')
  write(repo, 'src/a[y].js', 'lit\n'); write(repo, 'src/ay.js', 'other\n')
  { const r = record('1'); assert.equal(r.code, 0, r.stderr) }
  assert.deepEqual(files(), ['A\tsrc/a.js', 'A\tsrc/a[y].js'])
  assert.match(gitIn(repo, 'status', '--porcelain'), /src\/ay\.js/)
})

test('a renamed planned file commits the deletion of the old path too', () => {
  setup()
  write(repo, 'src/old.js', 'o\n'); gitIn(repo, 'add', 'src/old.js'); gitIn(repo, 'commit', '-qm', 'old')
  plan(['src/a.js', 'src/new.js', 'src/old.js'])
  gitIn(repo, 'mv', 'src/old.js', 'src/new.js')
  { const r = record('1'); assert.equal(r.code, 0, r.stderr) }
  assert.deepEqual(files(), ['A\tsrc/a.js', 'R100\tsrc/old.js\tsrc/new.js'])
})

test('a commit failure names git, not signing', () => {
  setup()
  gitIn(repo, 'config', 'commit.gpgsign', 'true'); gitIn(repo, 'config', 'gpg.program', 'false')
  assert.match(record('1').stderr, /git commit failed: .+/)
})

test('detached HEAD commits nothing', () => {
  setup()
  gitIn(repo, 'checkout', '-q', '--detach')
  const r = record('1')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).commit, null)
})

test('tier L: a passing reply commits the slice; a failed commit reopens it and logs it', () => {
  setup()
  const reply = () => sdlc(repo, ['ratchet', 'record', 'feat', 'build', '--slice', '1'], { input: 'verdict: pass\n' })
  gitIn(repo, 'config', 'commit.gpgsign', 'true'); gitIn(repo, 'config', 'gpg.program', 'false')
  const bad = reply()
  assert.notEqual(bad.code, 0)
  assert.match(bad.stderr, /the slice is reopened/)
  assert.equal(JSON.parse(sdlc(repo, ['ratchet', 'show', 'feat']).stdout).slices['1'].status, 'open')
  assert.match(fs.readFileSync(path.join(repo, '.rig/changes/feat/events.jsonl'), 'utf8'), /"node":"build#1","verdict":"reopened","reason":"checkpoint commit failed"/)
  gitIn(repo, 'config', 'commit.gpgsign', 'false')
  const ok = reply()
  assert.equal(ok.code, 0, ok.stderr)
  assert.match(JSON.parse(ok.stdout).commit, /^[0-9a-f]{7,}$/)
  assert.deepEqual(subjects(), ['sdlc/feat: slice 1'])
})
