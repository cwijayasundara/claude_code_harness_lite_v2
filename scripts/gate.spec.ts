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
