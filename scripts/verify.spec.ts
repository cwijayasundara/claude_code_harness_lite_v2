// `verify` runs a change's verification commands through the recorder; only trusted commands run unprompted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, buildDone } from './testkit.ts'

const OK = 'node -e "process.exit(0)"'
const BAD = 'node -e "process.exit(3)"'

function change(sensors: object, plan: string): string {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify(sensors))
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  buildDone(repo, 'tiny')
  write(repo, '.sdlc/changes/tiny/plan.md', `## Files\n- src/**\n## Verification\n${plan}`)
  return repo
}
const report = (repo: string): string => fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8')
const rows = (repo: string): { cmd: string; exit: number }[] =>
  fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/runs.jsonl'), 'utf8').trim().split('\n').map(r => JSON.parse(r))

test('verify runs the plan commands the config declares, records each and writes a passing report', () => {
  const repo = change({ fast: { test: OK } }, `- \`${OK}\`\n`)
  const r = sdlc(repo, ['verify', 'tiny'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(report(repo), /result: pass/)
  assert.deepEqual(rows(repo).map(x => x.exit), [0])
})

test('verify reports a failing command with a non-zero exit and a failing report', () => {
  const repo = change({ fast: { a: OK, b: BAD } }, `- \`${OK}\`\n- \`${BAD}\`\n`)
  const r = sdlc(repo, ['verify', 'tiny'])
  assert.equal(r.code, 1)
  assert.match(report(repo), /result: fail/)
  assert.deepEqual(rows(repo).map(x => x.exit), [0, 3])
})

test('verify never runs a plan command that no config declares and no person approved', () => {
  const repo = change({ fast: { test: OK } }, `- \`${OK}\`\n- \`touch pwned\`\n`)
  const r = sdlc(repo, ['verify', 'tiny'])
  assert.match(r.stdout, /not run .*touch pwned/)
  assert.equal(fs.existsSync(path.join(repo, 'pwned')), false)
  assert.match(report(repo), /result: fail/)
  assert.deepEqual(rows(repo).map(x => x.cmd), [OK])
})

test('a command listed twice runs once', () => {
  const repo = change({ fast: { test: OK } }, `- \`${OK}\`\n- \`${OK}\`\n`)
  sdlc(repo, ['verify', 'tiny'])
  assert.equal(rows(repo).length, 1)
})
