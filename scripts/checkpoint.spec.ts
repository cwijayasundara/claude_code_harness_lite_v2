// Each recorded build slice is committed by the script on sdlc/<slug>: only that slice's planned files, never the trunk, never a push.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

const GREEN = 'node -e "process.exit(0)"'
let repo: string
function setup(branch = 'sdlc/feat') {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: GREEN } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  if (branch !== 'main') gitIn(repo, 'checkout', '-qb', branch)
  sdlc(repo, ['new', 'feat', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/feat/plan.md', '## Files\n- src/a.js\n- src/b.js\n- test/a.test.js\n## Slices\n### Task 1: a\nFiles: `src/a.js` `test/a.test.js`\n### Task 2: b\nFiles: `src/b.js`\n')
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
