// ratchet record build --checks: the slice verdict comes from captured evidence, never from a model's reply.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

const GREEN = 'node -e "process.exit(0)"'
let repo: string
function change(tier: string) {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: GREEN } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/feat')
  sdlc(repo, ['new', 'feat', '--type', 'feature', '--tier', tier])
  write(repo, '.sdlc/changes/feat/plan.md', '## Files\n- src/a.js\n- test/a.test.js\n## Slices\n### Task 1: a\n')
  write(repo, 'src/a.js', 'export const a = 1\n')
  write(repo, 'test/a.test.js', "test('B1 a', () => {})\n")
}
const run = () => sdlc(repo, ['run', '--slug', 'feat', '--', GREEN])
const record = () => sdlc(repo, ['ratchet', 'record', 'feat', 'build', '--checks'])
const state = () => JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/feat/ratchet.json'), 'utf8'))
beforeEach(() => { repo = makeRepo() })

test('a green declared run on the current tree records the slice as done', () => {
  change('M')
  assert.equal(run().code, 0)
  const r = record()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).verdict, 'done')
  assert.equal(state().slices['1'].status, 'done')
  assert.equal(state().nodes.build.status, 'done')
})

test('no run at all refuses and records nothing', () => {
  change('M')
  const r = record()
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /no green run of a declared test command on the current tree/)
  assert.equal(state().slices['1'], undefined)
})

test('an edit after the green run makes the run stale', () => {
  change('M')
  run()
  write(repo, 'src/a.js', 'export const a = 2\n')
  assert.match(record().stderr, /no green run/)
})

test('a file outside the plan refuses', () => {
  change('M')
  write(repo, 'src/other.js', 'export const o = 1\n')
  run()
  assert.match(record().stderr, /outside the plan's ## Files: src\/other\.js/)
})

test('a blocking sensor refuses even with a green run', () => {
  change('M')
  write(repo, 'src/a.js', 'const apikey = "abcdefghijklmnop12345678"\n')
  run()
  assert.match(record().stderr, /sensors block: secrets/)
})

test('tier L slices need a reviewer verdict, not --checks', () => {
  change('L')
  run()
  assert.match(record().stderr, /tier L slices need a reviewer verdict/)
})

test('--checks applies to the build node only', () => {
  change('M')
  run()
  const r = sdlc(repo, ['ratchet', 'record', 'feat', 'pr-review', '--checks'])
  assert.match(r.stderr, /--checks applies to the build node only/)
})

test('--checks takes no reply: combined with --from it refuses', () => {
  change('M')
  run()
  write(repo, '.sdlc/changes/feat/r.md', 'verdict: pass\n')
  const r = sdlc(repo, ['ratchet', 'record', 'feat', 'build', '--checks', '--from', '.sdlc/changes/feat/r.md'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--checks takes no reply/)
  assert.equal(state().slices['1'], undefined)
})
