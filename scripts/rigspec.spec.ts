// rig-spec.yml: the publish job's file check runs as written in the workflow; the privilege split is in the text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const yml = fs.readFileSync(path.join(import.meta.dirname, '..', 'templates/rig-spec.yml'), 'utf8')

// The publish check, cut from the workflow between its markers and run with bash -e like GitHub does.
function publishCheck(setup: (dir: string) => void): { code: number | null; slug: string; err: string } {
  const start = yml.indexOf('# publish-check:start')
  const end = yml.indexOf('# publish-check:end')
  assert.ok(start >= 0 && end > start, 'the workflow carries both publish-check markers')
  const script = yml.slice(start, end).split('\n').map(l => l.replace(/^ {10}/, '')).join('\n')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-spec-'))
  fs.mkdirSync(path.join(work, 'change'))
  setup(path.join(work, 'change'))
  const outFile = path.join(work, 'out')
  const r = spawnSync('bash', ['-e', '-c', script], { cwd: work, env: { ...process.env, GITHUB_OUTPUT: outFile }, encoding: 'utf8' })
  return { code: r.status, slug: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '', err: r.stdout + r.stderr }
}
const folder = (dir: string, slug: string, files: string[]) => {
  fs.mkdirSync(path.join(dir, slug))
  for (const f of files) fs.writeFileSync(path.join(dir, slug, f), 'x\n')
}

test('publish accepts one change folder of rig files and outputs its name', () => {
  const r = publishCheck(d => folder(d, 'claims-status', ['intent.md', 'design.md', 'ratchet.json', 'events.jsonl']))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.slug, 'slug=claims-status')
})

function refused(setup: (dir: string) => void, reason: RegExp) {
  const r = publishCheck(setup)
  assert.notEqual(r.code, 0, r.err)
  assert.match(r.err, reason)
}

test('publish refuses a script, a symlink, a nested folder and a dot-dot file name inside a valid change folder', () => {
  refused(d => folder(d, 'abc', ['intent.md', 'run.sh']), /refusing .*run\.sh/)
  refused(d => { folder(d, 'abc', ['intent.md']); fs.symlinkSync('/etc/passwd', path.join(d, 'abc', 'design.md')) }, /refusing .*design\.md/)
  refused(d => { folder(d, 'abc', ['intent.md']); fs.mkdirSync(path.join(d, 'abc', 'sub')) }, /refusing .*sub/)
  refused(d => folder(d, 'abc', ['intent.md', '..evil']), /refusing .*\.\.evil/)
})

test('publish refuses a second change folder, a bad name and an empty change directory', () => {
  refused(d => { folder(d, 'abc', ['intent.md']); folder(d, 'def', ['intent.md']) }, /exactly one change folder/)
  refused(d => folder(d, 'Bad_Name', ['intent.md']), /bad change name/)
  refused(() => {}, /exactly one change folder/)
})

test('privilege split: read-only model job with no persisted credentials; the publish job runs no model', () => {
  assert.match(yml, /^permissions:\n  contents: read$/m)
  const [beforePublish = '', publish = ''] = yml.split(/^  publish:$/m)
  assert.match(beforePublish, /persist-credentials: false/)
  assert.match(beforePublish, /anthropics\/claude-code-action@/)
  assert.doesNotMatch(publish, /claude-code-action|claude -p/)
  assert.match(publish, /contents: write/)
  assert.match(publish, /pull-requests: write/)
  const draft = yml.split(/^  draft:$/m)[1]?.split(/^  publish:$/m)[0] ?? ''
  assert.match(draft, /persist-credentials: false/)
  assert.match(draft, /claude-code-action/)
  assert.doesNotMatch(draft, /permissions:|: write/)
  assert.match(publish, /if: \$\{\{ !cancelled\(\) && needs\.pick\.result == 'success'/)
  assert.match(publish, /for f in intent\.md design\.md spec\.md plan\.md/)
  assert.doesNotMatch(publish, /cp -R/)
})

test('the model job never builds and edits only change folders', () => {
  assert.match(yml, /\/rig-start \.sdlc\/intent\/\$\{\{ matrix\.intent\.file \}\} --plan-only/)
  assert.match(yml, /Edit\(\.\/\.sdlc\/changes\/\*\*\)/)
  assert.doesNotMatch(yml, /--allowedTools "[^"]*\b(?:Edit|Write|Bash),/)
  assert.match(yml, /inbox --pending --json/)
  assert.match(yml, /sdlc\/intent-\$\{FILE%\.md\}/)
})
