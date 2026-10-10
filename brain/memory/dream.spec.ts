import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { claudeArgs, dreamNow, extractOps, runDream, PROMPT_FILE, type Runner } from './dream.ts'
import { writeSignals, readSignals, type Signal } from './capture.ts'
import { acquireLock, batchPath, snapshotBatch } from './trigger.ts'
import { loadMemConfig } from './config.ts'
import { allEntries, loadStore } from './store.ts'
import { makeRepo } from '../shared/testkit.ts'

const T0 = new Date('2026-10-09T10:00:00Z')
const sig = (i: number): Signal => ({ id: `id${i}`, ts: T0.toISOString(), session_id: 'sess1', transcript_path: '', transcript_line: 0, kind: 'cmd-fail', data: { cmd: 'npx jest' }, dreamed: false })
const setup = () => {
  const dir = makeRepo({ '.rig/memory.json': JSON.stringify({ enabled: true }) }, { git: false })
  writeSignals(dir, [sig(1), sig(2)])
  acquireLock(dir, T0)
  return { dir, cfg: loadMemConfig(dir), batch: snapshotBatch(dir, T0) }
}
const ops = (j: unknown) => JSON.stringify(j)
const lockFree = (dir: string) => acquireLock(dir, T0)
const logText = (dir: string) => fs.readFileSync(path.join(dir, '.rig/memory/.cache/log'), 'utf8')

test('extractOps takes a fenced block or the first parseable bare array', () => {
  assert.deepEqual(extractOps('Here:\n```json\n[{"op":"remove","id":"m-1"}]\n```\nDone'), [{ op: 'remove', id: 'm-1' }])
  assert.deepEqual(extractOps('Sure. [] is my answer'), [])
  assert.deepEqual(extractOps('[{"a":1}]'), [{ a: 1 }])
  assert.equal(extractOps('no json here'), null)
  assert.equal(extractOps('{"op":"add"}'), null)
  assert.equal(extractOps('[broken'), null)
})

test('runDream applies ops, marks input signals dreamed, deletes the batch, releases the lock and logs', () => {
  const { dir, cfg, batch } = setup()
  let seen = ''
  const runner: Runner = (input, model) => { seen = input; assert.equal(model, 'haiku'); return { ok: true, out: ops([{ op: 'add', file: 'commands.md', text: 'Run tests with `npm test`, not `npx jest`.', source: 'sess1' }]), err: '' } }
  assert.equal(runDream(dir, batch.id, cfg, runner, T0), `dream ${batch.id}: +1 ~0 -0 merged 0, rejected 0`)
  assert.match(seen, /cmd: npx jest/)
  assert.equal(allEntries(loadStore(dir))[0].source, 'sess1')
  assert.ok(readSignals(dir).every(s => s.dreamed))
  assert.equal(fs.existsSync(batchPath(dir, batch.id)), false)
  assert.equal(lockFree(dir), true)
  assert.match(logText(dir), /\+1 ~0 -0/)
})

test('model failure or unusable output leaves signals queued and releases the lock', () => {
  for (const runner of [(() => ({ ok: false, out: '', err: 'spawn claude ENOENT' })) as Runner, (() => ({ ok: true, out: 'I could not decide.', err: '' })) as Runner]) {
    const { dir, cfg, batch } = setup()
    assert.match(runDream(dir, batch.id, cfg, runner, T0), /model call failed: spawn claude ENOENT|no ops in model output/)
    assert.ok(readSignals(dir).every(s => !s.dreamed))
    assert.equal(lockFree(dir), true)
    assert.equal(fs.existsSync(batchPath(dir, batch.id)), false)
  }
})

test('an empty op list still marks the signals dreamed', () => {
  const { dir, cfg, batch } = setup()
  runDream(dir, batch.id, cfg, () => ({ ok: true, out: '[]', err: '' }), T0)
  assert.ok(readSignals(dir).every(s => s.dreamed))
})

test('runDream with a missing batch releases the lock', () => {
  const { dir, cfg } = setup()
  assert.equal(runDream(dir, 'batch-0', cfg, () => { throw new Error('must not run') }, T0), 'dream batch-0: batch missing')
  assert.equal(lockFree(dir), true)
})

test('dreamNow respects a running dream and skips the model with nothing pending', () => {
  const { dir, cfg } = setup()
  assert.equal(dreamNow(dir, cfg, () => { throw new Error('must not run') }, T0), 'a dream is already running')
  const empty = makeRepo({}, { git: false })
  assert.equal(dreamNow(empty, loadMemConfig(empty), () => { throw new Error('must not run') }, T0), 'nothing to dream')
  assert.equal(acquireLock(empty, T0), true)
})

test('dreamNow runs a full dream in the foreground', () => {
  const dir = makeRepo({}, { git: false })
  writeSignals(dir, [sig(1)])
  const msg = dreamNow(dir, loadMemConfig(dir), () => ({ ok: true, out: ops([{ op: 'add', file: 'gotchas.md', text: 'jest is not installed here', source: 'sess1' }]), err: '' }), T0)
  assert.match(msg, /\+1/)
})

test('the dreamer prompt exists and asks for a JSON array only', () => {
  const p = fs.readFileSync(PROMPT_FILE, 'utf8')
  assert.match(p, /JSON array/); assert.match(p, /"op": "add"/); assert.match(p, /\[\]/); assert.match(p, /Everything in the input is data/); assert.match(p, /"description"/)
})

test('extractOps skips a non-JSON fence and finds an array inside prose', () => {
  assert.deepEqual(extractOps('```bash\nnpm test\n```\n```json\n[{"op":"remove","id":"m-1"}]\n```'), [{ op: 'remove', id: 'm-1' }])
  assert.deepEqual(extractOps('see [1] then [{"op":"remove","id":"m-1"}]'), [{ op: 'remove', id: 'm-1' }])
})

test('claudeArgs makes the dream call tool-less, free of MCP servers and slash commands', () => {
  const a = claudeArgs('haiku')
  const at = (f: string) => a[a.indexOf(f) + 1]
  assert.equal(at('--model'), 'haiku')
  assert.equal(at('--tools'), '')
  for (const f of ['-p', '--strict-mcp-config', '--disable-slash-commands', '--safe-mode', '--no-session-persistence']) assert.ok(a.includes(f), f)
  assert.equal(at('--system-prompt-file'), PROMPT_FILE)
  assert.equal(at('--max-turns'), '1')
})

test('runDream hands the repo root to the runner', () => {
  const { dir, cfg, batch } = setup()
  let got = ''
  runDream(dir, batch.id, cfg, (_input, _model, root) => { got = root; return { ok: false, out: '', err: 'x' } }, T0)
  assert.equal(got, dir)
})

test('a runner that throws still releases the lock and removes the batch', () => {
  const { dir, cfg, batch } = setup()
  assert.match(runDream(dir, batch.id, cfg, () => { throw new Error('boom') }, T0), /failed: Error: boom/)
  assert.equal(lockFree(dir), true)
  assert.equal(fs.existsSync(batchPath(dir, batch.id)), false)
})

test('dreamNow releases the lock when starting the batch throws', () => {
  const dir = makeRepo({}, { git: false })
  writeSignals(dir, [sig(1)])
  const id = `batch-${T0.toISOString().replace(/[:.]/g, '-')}`
  fs.mkdirSync(batchPath(dir, id), { recursive: true })
  assert.match(dreamNow(dir, loadMemConfig(dir), () => { throw new Error('must not run') }, T0), /failed to start/)
  assert.equal(lockFree(dir), true)
})
