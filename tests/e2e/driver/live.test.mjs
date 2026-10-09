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
