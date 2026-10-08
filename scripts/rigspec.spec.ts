// rig-spec.yml: the publish job's file check runs as written in the workflow; the privilege split is in the text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

const yml = fs.readFileSync(path.join(import.meta.dirname, '..', 'templates/rig-spec.yml'), 'utf8')

// The publish check, cut from the workflow between its markers and run with bash -e like GitHub does.
// It runs inside a temp git repo (the publish job's checkout); `trunk` commits files there first.
function publishCheck(setup: (dir: string) => void, trunk: (repo: string) => void = () => {}): { code: number | null; slug: string; err: string } {
  const start = yml.indexOf('# publish-check:start')
  const end = yml.indexOf('# publish-check:end')
  assert.ok(start >= 0 && end > start, 'the workflow carries both publish-check markers')
  const script = yml.slice(start, end).split('\n').map(l => l.replace(/^ {10}/, '')).join('\n')
  const work = makeRepo()
  trunk(work)
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

function refused(setup: (dir: string) => void, reason: RegExp, trunk?: (repo: string) => void) {
  const r = publishCheck(setup, trunk)
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

// A draft built by rig's real commands: `new --source` then the design skill's `check --at plan` (impact.json, events, ratchet).
function drafted(slug: string, type: string, artifact: [string, string]): string {
  const repo = makeRepo()
  write(repo, `.sdlc/intent/${slug}.md`, '---\nstatus: accepted\n---\n# Intent\n\n## Problem\nY is missing.\n')
  const made = sdlc(repo, ['new', slug, '--type', type, '--tier', 'M', '--source', `.sdlc/intent/${slug}.md`])
  assert.equal(made.code, 0, made.stderr)
  write(repo, `.sdlc/changes/${slug}/${artifact[0]}`, artifact[1])
  if (artifact[0] === 'design.md') sdlc(repo, ['check', '--at', 'plan', '--slug', slug])
  return path.join(repo, '.sdlc/changes', slug)
}

test('publish accepts a feature draft made by new --source and check --at plan', () => {
  const src = drafted('add-y', 'feature', ['design.md', '## Files\n- src/a.js\n## Verification\n- `node -e "0"`\n'])
  assert.ok(fs.existsSync(path.join(src, 'impact.json')), 'check --at plan wrote impact.json')
  const r = publishCheck(d => fs.cpSync(src, path.join(d, 'add-y'), { recursive: true }))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.slug, 'slug=add-y')
})

test('publish accepts a spike draft with notes.md', () => {
  const src = drafted('try-y', 'spike', ['notes.md', '# Notes\nAnswer.\n'])
  const r = publishCheck(d => fs.cpSync(src, path.join(d, 'try-y'), { recursive: true }))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.slug, 'slug=try-y')
})

test('publish refuses a change folder the trunk already has', () => {
  refused(d => folder(d, 'abc', ['intent.md']), /change abc already exists on the trunk/, repo => {
    write(repo, '.sdlc/changes/abc/intent.md', 'x\n')
    gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'abc')
  })
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
  assert.match(publish, /for f in intent\.md design\.md spec\.md plan\.md notes\.md; do/)
  assert.doesNotMatch(publish, /cp -R/)
})

test('the model job never builds and edits only change folders', () => {
  assert.match(yml, /\/rig-start \.sdlc\/intent\/\$\{\{ matrix\.intent\.file \}\} --plan-only/)
  assert.match(yml, /Edit\(\.\/\.sdlc\/changes\/\*\*\)/)
  const denied = /--disallowedTools "([^"]*)"/.exec(yml)?.[1]?.split(',') ?? []
  for (const t of ['Edit(./.sdlc/bin/**)', 'Edit(./.sdlc/sensors.json)', 'Edit(./.sdlc/rules.json)', 'Edit(./.claude/**)', 'Edit(./.github/**)']) assert.ok(denied.includes(t), `the draft job denies ${t}`)
  assert.doesNotMatch(yml, /--allowedTools "[^"]*\b(?:Edit|Write|Bash),/)
  assert.match(yml, /inbox --pending --json/)
  assert.match(yml, /sdlc\/intent-\$\{FILE%\.md\}/)
})

test('resuming a published draft re-derives its impact (impact.json is not published)', () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', 'skills/start/SKILL.md'), 'utf8')
  const resume = skill.split('## Resume')[1]?.split('\n## ')[0] ?? ''
  assert.match(resume, /intent\.md has `source:` and it has a design\.md or plan\.md, run `[^`]*sdlc\.ts check --at plan --slug <slug>` once/)
})
