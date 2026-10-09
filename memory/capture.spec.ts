import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { appendSignal, capture, cmdKey, isCorrection, markDreamed, pruneSignals, readSignals, writeSignals, type Signal } from './capture.ts'
import { makeRepo } from '../shared/testkit.ts'

const T0 = new Date('2026-10-09T10:00:00Z')
const at = (s: number) => new Date(T0.getTime() + s * 1000)
const transcript = (dir: string, withAssistant = true) => {
  const f = path.join(dir, 't.jsonl')
  fs.writeFileSync(f, [JSON.stringify({ type: 'user', message: { content: 'hi' } }), ...(withAssistant ? [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })] : [])].join('\n') + '\n')
  return f
}
const bash = (dir: string, command: string, exit: number, extra: Record<string, unknown> = {}) =>
  ({ session_id: 's1', transcript_path: transcript(dir), tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: exit ? 'boom' : '', exit_code: exit }, ...extra })

test('cmdKey skips env assignments and keeps executable + first arg', () => {
  assert.equal(cmdKey('FOO=1 npm run build --x'), 'npm run')
  assert.equal(cmdKey('  npx jest '), 'npx jest')
})

test('isCorrection matches corrections, not ordinary requests', () => {
  for (const p of ['no, use pnpm', "Don't touch that file", 'stop', "that's wrong", 'use vitest, not jest', 'do it with sed instead']) assert.ok(isCorrection(p), p)
  for (const p of ['Now add a test', 'add logout', 'note this down']) assert.ok(!isCorrection(p), p)
})

test('failed bash records cmd-fail with redacted, clipped fields and a transcript line', () => {
  const dir = makeRepo({}, { git: false })
  const s = capture(dir, 'post-bash', bash(dir, 'curl -H "Authorization: Bearer abcdefghijklmnop123" x', 7), T0)!
  assert.equal(s.kind, 'cmd-fail'); assert.equal(s.data.exit, '7'); assert.equal(s.data.error, 'boom')
  assert.match(s.data.cmd, /\[REDACTED\]/); assert.equal(s.transcript_line, 2); assert.equal(s.dreamed, false)
  assert.equal(readSignals(dir).length, 1)
  assert.equal(fs.readFileSync(path.join(dir, '.sdlc/memory/.gitignore'), 'utf8'), '.cache/\n')
})

test('PostToolUseFailure on Bash is a cmd-fail; on other tools a tool-error', () => {
  const dir = makeRepo({}, { git: false })
  assert.equal(capture(dir, 'tool-fail', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'make' }, error: 'exit 2' }, T0)!.kind, 'cmd-fail')
  const e = capture(dir, 'tool-fail', { session_id: 's1', tool_name: 'Read', tool_input: {}, error: 'ENOENT' }, T0)!
  assert.equal(e.kind, 'tool-error'); assert.equal(e.data.tool, 'Read'); assert.equal(e.data.error, 'ENOENT')
})

test('a later success pairs once with the failure: same key any time, other non-trivial command within 120s', () => {
  const dir = makeRepo({}, { git: false })
  const f1 = capture(dir, 'post-bash', bash(dir, 'npm run build', 1), T0)!
  const fx = capture(dir, 'post-bash', bash(dir, 'npm run build', 0), at(600))!
  assert.equal(fx.kind, 'cmd-fixed'); assert.equal(fx.data.fail, f1.id); assert.equal(fx.data.failed, 'npm run build')
  assert.equal(capture(dir, 'post-bash', bash(dir, 'npm run build', 0), at(601)), null)
  const f2 = capture(dir, 'post-bash', bash(dir, 'npx jest', 1), at(700))!
  assert.equal(capture(dir, 'post-bash', bash(dir, 'ls -la', 0), at(710)), null)
  const fx2 = capture(dir, 'post-bash', bash(dir, 'npm test', 0), at(720))!
  assert.equal(fx2.kind, 'cmd-fixed'); assert.equal(fx2.data.fail, f2.id)
  capture(dir, 'post-bash', bash(dir, 'cargo build', 1), at(800))
  assert.equal(capture(dir, 'post-bash', bash(dir, 'npm test', 0), at(1000)), null)
  assert.equal(capture(dir, 'post-bash', { ...bash(dir, 'npm run build', 0), session_id: 's2' }, at(1001)), null)
})

test('three edits of one file in a session record churn once', () => {
  const dir = makeRepo({}, { git: false })
  const ed = (sid: string) => capture(dir, 'post-edit', { session_id: sid, tool_input: { file_path: path.join(dir, 'src/a.ts') } }, T0)
  assert.equal(ed('s1'), null); assert.equal(ed('s1'), null)
  const c = ed('s1')!
  assert.equal(c.kind, 'churn'); assert.equal(c.data.file, 'src/a.ts')
  assert.equal(ed('s1'), null); assert.equal(ed('s2'), null)
  assert.equal(capture(dir, 'post-edit', { session_id: 's1', tool_input: { file_path: '/etc/hosts' } }, T0), null)
})

test('correction needs an earlier assistant turn and is redacted', () => {
  const dir = makeRepo({}, { git: false })
  assert.equal(capture(dir, 'prompt', { session_id: 's1', transcript_path: transcript(dir, false), prompt: 'no, use pnpm' }, T0), null)
  assert.equal(capture(dir, 'prompt', { session_id: 's1', transcript_path: transcript(dir), prompt: 'add logout' }, T0), null)
  const c = capture(dir, 'prompt', { session_id: 's1', transcript_path: transcript(dir), prompt: 'no, the password: hunter22 is wrong' }, T0)!
  assert.equal(c.kind, 'correction'); assert.match(c.data.prompt, /\[REDACTED\]/)
})

test('capture tolerates odd payloads', () => {
  const dir = makeRepo({}, { git: false })
  assert.equal(capture(dir, 'post-bash', {}, T0), null)
  assert.equal(capture(dir, 'post-bash', { tool_input: { command: 'x' }, tool_response: 'plain string' }, T0), null)
  const s = capture(dir, 'post-bash', { tool_input: { command: 'x' }, tool_response: { exitCode: 3 } }, T0)!
  assert.equal(s.kind, 'cmd-fail'); assert.equal(s.session_id, 'unknown'); assert.equal(s.transcript_line, 0)
  assert.equal(capture(dir, 'post-edit', { tool_input: null }, T0), null)
  assert.equal(capture(dir, 'prompt', { prompt: 42 }, T0), null)
})

const sig = (i: number, extra: Partial<Signal> = {}): Signal =>
  ({ id: `id${i}`, ts: T0.toISOString(), session_id: 's', transcript_path: '', transcript_line: 0, kind: 'cmd-fail', data: {}, dreamed: false, ...extra })

test('appendSignal appends without rewriting and trims past 600', () => {
  const dir = makeRepo({}, { git: false })
  for (let i = 1; i <= 600; i++) appendSignal(dir, sig(i))
  assert.equal(readSignals(dir).length, 600)
  appendSignal(dir, sig(601))
  const all = readSignals(dir)
  assert.equal(all.length, 500); assert.equal(all[0].id, 'id102'); assert.equal(all[499].id, 'id601')
})

test('readSignals skips garbage; markDreamed and pruneSignals', () => {
  const dir = makeRepo({}, { git: false })
  writeSignals(dir, [sig(1), sig(2, { ts: '2026-09-30T00:00:00Z' }), sig(3, { ts: '2026-10-07T00:00:00Z', dreamed: true })])
  fs.appendFileSync(path.join(dir, '.sdlc/memory/.cache/signals.jsonl'), 'not json\n{"a":1}\n')
  assert.equal(readSignals(dir).length, 3)
  markDreamed(dir, new Set(['id1']))
  assert.equal(readSignals(dir).find(s => s.id === 'id1')!.dreamed, true)
  pruneSignals(dir, T0)
  assert.deepEqual(readSignals(dir).map(s => s.id), ['id1'])
})

test('a piped command whose exit code is masked still counts as a failure when its output shows one', () => {
  const dir = makeRepo({}, { git: false })
  const piped = (command: string, stdout: string) => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false } })
  const f = capture(dir, 'post-bash', piped('npx --no-install jest 2>&1 | tail -30', 'npm error npx canceled due to missing packages'), T0)!
  assert.equal(f.kind, 'cmd-fail'); assert.match(f.data.error, /npm error/)
  assert.equal(capture(dir, 'post-bash', piped('npm test 2>&1 | tail -20', '> test\ntests ok'), at(10))!.kind, 'cmd-fixed')
  assert.equal(capture(dir, 'post-bash', piped('grep -n error src/a.ts | head', 'src/a.ts:3: throw new Error("x")'), at(20)), null)
  assert.equal(capture(dir, 'post-bash', piped('npm run build', 'npm error something'), at(30)), null)
})
