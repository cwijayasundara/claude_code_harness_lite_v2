// Hook behaviour: skill fallback, baselines, the Stop gate, guides and least privilege.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, hook } from './testkit.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
})

test('a failed sdlc skill load injects the deterministic fallback command and logs the event', () => {
  sdlc(repo, ['init'])
  const r = hook(repo, 'skill-failed', { tool_input: { skill: 'sdlc:review', args: 'add-login' } })
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /sdlc\.ts" skill review add-login/)
  assert.match(ctx, /skill fallback: sdlc:review/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8'), /skill-load-failed/)
  assert.equal(hook(repo, 'skill-failed', { tool_input: { skill: 'superpowers:brainstorming' } }).stdout, '')
})

test('evidence files are human- or script-only: model edits and Bash writes are denied, reads allowed', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  for (const f of ['.sdlc/changes/tiny/runs.jsonl', '.sdlc/waivers.jsonl', '.sdlc/.gate', '.sdlc/.baseline', '.sdlc/unresolved.json', '.sdlc/changes/tiny/verification.md']) {
    const edit = JSON.parse(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, f) } }).stdout)
    assert.equal(edit.hookSpecificOutput.permissionDecision, 'deny', f)
  }
  const append = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: `echo '{"exit":0}' >> .sdlc/changes/tiny/runs.jsonl` } }).stdout)
  assert.equal(append.hookSpecificOutput.permissionDecision, 'deny')
  const waive = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: 'node /x/scripts/sdlc.ts waive size * because' } }).stdout)
  assert.equal(waive.hookSpecificOutput.permissionDecision, 'deny')
  const forge = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: 'cat > .sdlc/changes/tiny/verification.md <<EOF\nresult: pass\nEOF' } }).stdout)
  assert.equal(forge.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'cat .sdlc/changes/tiny/verification.md' } }).stdout, '')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'tail -5 .sdlc/changes/tiny/runs.jsonl' } }).stdout, '')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'node /x/scripts/sdlc.ts run -- "npm test"' } }).stdout, '')
})
