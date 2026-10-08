// Stage 1 and 2 skills: the inbox, --plan-only, and policy skills that become ## Concerns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('start reads an inbox file, passes --source, and never builds with --plan-only', () => {
  const start = read('skills/start/SKILL.md')
  assert.match(start, /If the request is a file under `\.sdlc\/intent\/`/)
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
  assert.match(text, /\.sdlc\/intent\/<kebab-name>\.md/)
  assert.match(text, /status: draft/)
  for (const h of ['## Problem', '## Proposed outcome', '## Affected users and systems', '## Constraints', '## Open questions']) assert.ok(text.includes(h), h)
  assert.match(text, /status: accepted/)
  assert.ok(text.split('\n').length <= 60)
})
