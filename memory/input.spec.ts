import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildDreamInput, renderLine, transcriptWindow } from './input.ts'
import type { Signal } from './capture.ts'
import { makeRepo } from '../shared/testkit.ts'

const J = (o: unknown) => JSON.stringify(o)

test('renderLine renders user/assistant text, tool calls and results; ignores the rest', () => {
  assert.equal(renderLine(J({ type: 'user', message: { content: 'run tests' } })), 'user: run tests')
  assert.equal(renderLine(J({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash', input: { command: 'npx jest' } }] } })),
    'assistant: ok [Bash {"command":"npx jest"}]')
  assert.equal(renderLine(J({ type: 'user', message: { content: [{ type: 'tool_result', content: 'not found' }] } })), 'user: [result not found]')
  assert.equal(renderLine(J({ type: 'summary', summary: 'x' })), '')
  assert.equal(renderLine('garbage'), '')
  assert.equal(renderLine(J({ type: 'user', message: { content: [{ type: 'image' }] } })), '')
})

test('renderLine redacts and clips each block to 400 chars', () => {
  assert.equal(renderLine(J({ type: 'user', message: { content: 'password: hunter22' } })), 'user: password: [REDACTED]')
  const long = renderLine(J({ type: 'user', message: { content: 'x'.repeat(1000) } }))
  assert.equal(long, `user: ${'x'.repeat(400)}…`)
})

test('transcriptWindow takes radius lines each side of the signal', () => {
  const lines = Array.from({ length: 100 }, (_, i) => J({ type: 'user', message: { content: `m${i}` } }))
  const w = transcriptWindow(lines, 50)
  assert.equal(w.length, 40); assert.equal(w[0], 'user: m30'); assert.equal(w[39], 'user: m69')
  assert.equal(transcriptWindow(lines, 2).length, 22)
})

const sig = (i: number, transcript_path: string, line = 1): Signal =>
  ({ id: `id${i}`, ts: `2026-10-09T10:00:0${i}Z`, session_id: `s${i}`, transcript_path, transcript_line: line, kind: 'cmd-fail', data: { cmd: `cmd${i}` }, dreamed: false })

test('buildDreamInput includes signals in order with context and the current memory', () => {
  const dir = makeRepo({ '.sdlc/memory/commands.md': '# commands\n> x\n\n- a [source: s; added: 2026-10-01; id: m-aaaaaa]\n' }, { git: false })
  const t = path.join(dir, 't.jsonl')
  fs.writeFileSync(t, J({ type: 'user', message: { content: 'please run tests' } }) + '\n')
  const r = buildDreamInput(dir, { id: 'b', signals: [sig(1, t), sig(2, path.join(dir, 'missing.jsonl')), sig(3, path.join(dir, 'x.txt'))] })
  assert.deepEqual(r.used, ['id1', 'id2', 'id3'])
  assert.ok(r.text.indexOf('cmd1') < r.text.indexOf('cmd2'))
  assert.match(r.text, /### cmd-fail \(session: s1, 2026-10-09T10:00:01Z\)\ncmd: cmd1\ncontext:\n  user: please run tests/)
  assert.match(r.text, /cmd: cmd2\ncontext:\n  \(transcript unavailable\)/)
  assert.match(r.text, /## Current memory\n### commands\.md\n# commands/)
})

test('buildDreamInput drops the oldest signals past the cap and leaves them out of used', () => {
  const dir = makeRepo({}, { git: false })
  const signals = Array.from({ length: 9 }, (_, i) => sig(i, ''))
  const one = buildDreamInput(dir, { id: 'b', signals: [signals[0]] }).text.length
  const r = buildDreamInput(dir, { id: 'b', signals }, one + 200)
  assert.ok(r.used.length >= 1 && r.used.length < 9)
  assert.equal(r.used.at(-1), 'id8')
  assert.match(buildDreamInput(dir, { id: 'b', signals: [] }).text, /## Signals\n\(none\)/)
})
