import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessions } from './live.mjs'

// A fake sandbox whose `claude` prints whatever the test says and records the budget flag it was given.
const fakeSb = stdout => {
  const calls = []
  return { calls, run: (cmd, args) => { calls.push(args); return { status: 0, stdout, stderr: '' } } }
}
const out = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rig-live-test-'))
const result = cost => JSON.stringify({ type: 'result', is_error: false, total_cost_usd: cost, num_turns: 1, duration_ms: 1, permission_denials: [] })

test('final review: a cap that is not a positive number is refused', () => {
  for (const bad of [NaN, 0, -1, "abc"]) assert.throws(() => createSessions({ sb: fakeSb(result(0)), out: out(), capUsd: bad }), /cap/)
})

test('final review: a session with no result event counts its whole budget as spent', () => {
  const sb = fakeSb('{"type":"assistant","message":{"content":[]}}')
  const s = createSessions({ sb, out: out(), capUsd: 6 })
  s.run('a', 'x')
  assert.equal(s.sessions[0].costUsd, 6)
  assert.throws(() => s.run('b', 'y'), /spend cap/)
})

test('a session that reports its cost is counted at that cost, and the next budget shrinks', () => {
  const sb = fakeSb(result(1.5))
  const s = createSessions({ sb, out: out(), capUsd: 6 })
  s.run('a', 'x')
  s.run('b', 'y')
  const budget = args => args[args.indexOf('--max-budget-usd') + 1]
  assert.equal(budget(sb.calls[0]), '6.00')
  assert.equal(budget(sb.calls[1]), '4.50')
})

import { liveDriver } from './live.mjs'

test('begin(): when /rig-start ends before creating a change, it continues with the skill invocation itself (plain text loses the skill\'s allowed tools)', async () => {
  const prompts = []
  const sb = {
    run: (cmd, args) => { prompts.push({ prompt: args[1], cont: args.includes('--continue') }); return { status: 0, stdout: result(0.1), stderr: '' } },
    sdlc: () => ({ status: 0, stdout: JSON.stringify({ active: prompts.length >= 3 ? 'c' : null }), stderr: '' }),
  }
  const sessions = createSessions({ sb, out: out(), capUsd: 6 })
  const slug = await liveDriver(sb, { id: 'PX', prompt: '/rig-start do the thing' }, { sessions }).begin()
  assert.equal(slug, 'c')
  assert.deepEqual(prompts.map(p => p.prompt), ['/rig-start do the thing', '/rig-start do the thing', '/rig-start do the thing'])
  assert.deepEqual(prompts.map(p => p.cont), [false, true, true])
})

import { PLUGIN } from '../../integration/lib/sandbox.mjs'

test('headless sessions carry the template allow rules on --settings: -p never trusts the workspace, so the same rules in .claude/settings.json are ignored', () => {
  const sb = fakeSb(result(0))
  createSessions({ sb, out: out(), capUsd: 6 }).run('a', 'x')
  const args = sb.calls[0]
  const inline = JSON.parse(args[args.indexOf('--settings') + 1])
  const template = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'templates/settings.json'), 'utf8'))
  assert.deepEqual(inline, { permissions: { allow: template.permissions.allow } })
  assert.ok(inline.permissions.allow.some(r => r.startsWith('Bash(node ') && r.includes('sdlc.ts')))
})
