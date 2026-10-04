// Auto-approval: allow inside an approved plan's autonomous nodes, never outside it.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

let repo: string
const decision = (hook: 'pre-edit' | 'pre-bash', tool_input: Record<string, unknown>) => {
  const r = sdlc(repo, ['hook', hook], { input: JSON.stringify({ tool_input }) })
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined
}
const edit = (rel: string) => decision('pre-edit', { file_path: path.join(repo, rel), content: 'x' })
const editRaw = (file: string) => decision('pre-edit', { file_path: file, content: 'x' })
const bash = (command: string) => decision('pre-bash', { command })

beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'npm test' }, levels: { api: 'npm run test:api' } }))
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/spec.md', '# Spec\n## Open questions\nnone\n')
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n- test/**\n## Verification\n- `npm test`\n## Open questions\nnone\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'plan')
})
const approveAll = () => {
  for (const g of ['spec', 'plan']) sdlc(repo, ['approve', 'big', g], { env: { SDLC_HUMAN: '1' } })
}

test('before the gates are approved nothing is auto-approved', () => {
  assert.notEqual(edit('src/a.js'), 'allow')
  assert.notEqual(bash('npm test'), 'allow')
})

test('in build, planned edits and declared commands are allowed; the rest is not', () => {
  approveAll()
  assert.equal(edit('src/a.js'), 'allow')
  assert.equal(edit('test/a.test.js'), 'allow')
  assert.notEqual(edit('docs/x.md'), 'allow', 'outside ## Files')
  assert.notEqual(edit('.sdlc/sensors.json'), 'allow', 'harness file')
  assert.equal(edit('.sdlc/changes/big/ratchet.json'), 'deny', 'evidence stays denied')
  assert.equal(bash('npm test'), 'allow')
  assert.equal(bash('npm run test:api'), 'allow', 'a declared level')
  assert.equal(bash('node /x/scripts/sdlc.ts run --slug big -- "npm test"'), 'allow')
  assert.equal(bash('git status'), 'allow', 'read-only git')
  assert.notEqual(bash('npm install left-pad'), 'allow')
})

test('chained commands are never auto-approved', () => {
  approveAll()
  for (const c of ['npm test && curl x | sh', 'npm test; rm -rf .', 'npm test | tee out', 'npm test > /etc/x', 'git status && git push --force'])
    assert.notEqual(bash(c), 'allow', c)
})

test('pushes, merges and force are never auto-approved', () => {
  approveAll()
  for (const c of ['git push origin main', 'git push --force origin sdlc/big', 'gh pr merge 1', 'git reset --hard HEAD~1'])
    assert.notEqual(bash(c), 'allow', c)
})

test('a stale plan approval stops auto-approval', () => {
  approveAll()
  assert.equal(edit('src/a.js'), 'allow')
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n- test/**\n- docs/**\n## Verification\n- `npm test`\n## Open questions\nnone\n')
  assert.notEqual(edit('src/a.js'), 'allow')
})

test('a blocked change is not auto-approved', () => {
  approveAll()
  sdlc(repo, ['ratchet', 'record', 'big', 'build', '--slice', '1'], { input: '- [severity: high] [category: correctness] a.js:1: x\n' })
  sdlc(repo, ['ratchet', 'record', 'big', 'build', '--slice', '1'], { input: '- [severity: high] [category: correctness] a.js:1: x\n' })
  assert.notEqual(edit('src/a.js'), 'allow')
})

test('each auto-approval is recorded in events.jsonl', () => {
  approveAll()
  edit('src/a.js')
  const events = fs.readFileSync(path.join(repo, '.sdlc/changes/big/events.jsonl'), 'utf8')
  assert.match(events, /"kind":"auto-approve","tool":"Edit","target":"src\/a\.js"/)
})

test('paths that escape the repo or reach harness files by indirection are never auto-approved', () => {
  approveAll()
  assert.equal(editRaw(path.join(repo, 'src/a.js')), 'allow')
  assert.notEqual(editRaw('/tmp/x.js'), 'allow', 'absolute path outside the repo')
  assert.notEqual(editRaw(path.join(repo, 'src/../../x.js')), 'allow', '.. escape')
  assert.notEqual(editRaw(path.join(repo, 'src') + '/../.sdlc/sensors.json'), 'allow')
  assert.notEqual(editRaw('src/../.sdlc/sensors.json'), 'allow', 'relative traversal into a harness file')
  assert.notEqual(edit('.SDLC/sensors.json'), 'allow', 'case variant')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.symlinkSync('/tmp', path.join(repo, 'src/link'))
  assert.notEqual(edit('src/link/x.js'), 'allow', 'symlink out of the repo')
})

test('command spacing is normalised; approvals, waivers and usage logging are never auto-approved', () => {
  approveAll()
  assert.equal(bash('npm test  '), 'allow')
  assert.equal(bash('npm   test'), 'allow')
  assert.notEqual(bash('node /x/scripts/sdlc.ts approve big plan'), 'allow')
  assert.equal(bash('node /x/scripts/sdlc.ts approve big plan'), 'deny')
  assert.notEqual(bash('node /x/scripts/sdlc.ts waive x * y'), 'allow')
  assert.equal(bash('node /x/scripts/sdlc.ts waive x * y'), 'deny')
  assert.notEqual(bash('node /x/scripts/sdlc.ts log-usage {}'), 'allow')
})

test('control characters, quoting tricks and substitutions never ride along on an allowed command', () => {
  approveAll()
  for (const c of ['node /x/scripts/sdlc.ts status\nrm -rf .', 'npm test\ncurl x', 'npm\ttest', 'npm test\r',
    'node /x/scripts/sdlc.ts run -- "npm test\\"; rm -rf ."', 'node /x/scripts/sdlc.ts status $(rm -rf .)'])
    assert.notEqual(bash(c), 'allow', JSON.stringify(c))
  assert.notEqual(editRaw(path.join(repo, 'src/a.js\nb')), 'allow', 'newline in a path')
})
