// Stage 1 and 2 skills: the inbox, --plan-only, and policy skills that become ## Concerns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write } from './testkit.ts'

const ROOT = path.join(import.meta.dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('start reads an inbox file, passes --source, and never builds with --plan-only', () => {
  const start = read('skills/start/SKILL.md')
  assert.match(start, /If the request is a file under `\.rig\/intent\/`/)
  assert.match(start, /--source <that path>/)
  assert.match(start, /`--plan-only`[^\n]*never build/)
  assert.match(start, /Tier S fast path\*\* \(not with `--plan-only`;/)
})

test('design, plan and spec apply policy skills and record conflicts as ## Concerns', () => {
  for (const s of ['design', 'plan', 'spec']) {
    const text = read(`skills/${s}/SKILL.md`)
    assert.match(text, /\.claude\/skills\/policy-\*\/SKILL\.md/, s)
    assert.match(text, /## Concerns/, s)
  }
})

test('the intent skill writes a draft inbox file in the playbook form and hands it to the product owner', () => {
  const text = read('skills/intent/SKILL.md')
  assert.match(text, /^name: intent$/m)
  assert.match(text, /\.rig\/intent\/<kebab-name>\.md/)
  assert.match(text, /status: draft/)
  for (const h of ['## Problem', '## Proposed outcome', '## Affected users and systems', '## Constraints', '## Open questions']) assert.ok(text.includes(h), h)
  assert.match(text, /status: accepted/)
  assert.ok(text.split('\n').length <= 60)
})

test('--plan-only stops start and design before approval, and every drafting skill states the concern format', () => {
  assert.match(read('skills/start/SKILL.md'), /With `--plan-only`, tell the design skill so, and stop when it has written design\.md/)
  assert.match(read('skills/start/SKILL.md'), /With `--plan-only`, do not resume a build/)
  assert.match(read('skills/design/SKILL.md'), /do not ask for approval and do not build/)
  for (const s of ['design', 'plan', 'spec']) assert.ok(read(`skills/${s}/SKILL.md`).includes('- [policy-<area>] <concern> → owner:'), s)
  for (const s of ['plan', 'spec']) assert.match(read(`skills/${s}/SKILL.md`), /Approval is refused until/, s)
  assert.match(read('skills/intent/SKILL.md'), /Without a file system \(claude\.ai\)/)
  // The closing line must not override the --plan-only ending: it applies only otherwise.
  assert.match(read('skills/start/SKILL.md'), /Otherwise end with exactly one line: `Next: <command from status>`/)
  assert.match(read('skills/design/SKILL.md'), /Otherwise end with: `Next: <command from status>`/)
})

test('new does not scaffold policy; plain init does not; init --full scaffolds once and never overwrites', () => {
  const repo = makeRepo()
  const file = path.join(repo, '.claude/skills/policy-security/SKILL.md')
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  assert.equal(fs.existsSync(file), false, 'new initialises .rig but writes no policy skill')
  sdlc(repo, ['init'])
  assert.equal(fs.existsSync(file), false, 'plain init does not write policy skill')
  const r = sdlc(repo, ['init', '--full'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /wrote \.claude\/skills\/policy-security\/SKILL\.md: set its owner and source/)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^name: policy-security$/m)
  assert.match(text, /^owner: /m)
  assert.match(text, /^source: /m)
  write(repo, '.claude/skills/policy-security/SKILL.md', 'mine\n')
  sdlc(repo, ['init', '--full'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n', 'a second init --full never overwrites the policy skill')
})
