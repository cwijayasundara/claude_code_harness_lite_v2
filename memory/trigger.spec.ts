import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { acquireLock, batchPath, loadDreamState, maybeStartDream, recordDream, releaseLock, shouldDream, snapshotBatch, BATCH_ID, LOCK_STALE_MS } from './trigger.ts'
import { writeSignals, type Signal } from './capture.ts'
import { loadMemConfig } from './config.ts'
import { makeRepo } from '../shared/testkit.ts'

const T0 = new Date('2026-10-09T10:00:00Z')
const plus = (ms: number) => new Date(T0.getTime() + ms)
const sig = (i: number, dreamed = false): Signal =>
  ({ id: `id${i}`, ts: T0.toISOString(), session_id: 's', transcript_path: '', transcript_line: 0, kind: 'cmd-fail', data: {}, dreamed })
const repo = (pending: number, dreamed = 0) => {
  const dir = makeRepo({ '.sdlc/memory.json': JSON.stringify({ enabled: true }) }, { git: false })
  writeSignals(dir, [...Array.from({ length: dreamed }, (_, i) => sig(100 + i, true)), ...Array.from({ length: pending }, (_, i) => sig(i))])
  return dir
}

test('shouldDream needs minSignals un-dreamed signals', () => {
  assert.deepEqual(shouldDream(repo(2, 5), loadMemConfig(repo(0)), T0), { ok: false, reason: '2 signals pending (need 3)' })
  assert.equal(shouldDream(repo(3), loadMemConfig(repo(0)), T0).ok, true)
})

test('shouldDream honors cooldown and the daily cap, which resets the next UTC day', () => {
  const dir = repo(3), cfg = loadMemConfig(dir)
  recordDream(dir, T0)
  assert.equal(shouldDream(dir, cfg, plus(29 * 60_000)).reason, 'cooldown')
  assert.equal(shouldDream(dir, cfg, plus(30 * 60_000)).ok, true)
  for (let i = 1; i < 6; i++) recordDream(dir, plus(i * 1000))
  assert.equal(loadDreamState(dir).count, 6)
  assert.equal(shouldDream(dir, cfg, plus(60 * 60_000)).reason, 'daily cap reached')
  assert.equal(shouldDream(dir, cfg, new Date('2026-10-10T00:05:00Z')).ok, true)
})

test('lock: exclusive, released, stale after 15 min, corrupt counts as stale', () => {
  const dir = repo(0)
  assert.equal(acquireLock(dir, T0), true)
  assert.equal(acquireLock(dir, plus(LOCK_STALE_MS - 1)), false)
  assert.equal(acquireLock(dir, plus(LOCK_STALE_MS + 1)), true)
  releaseLock(dir); releaseLock(dir)
  assert.equal(acquireLock(dir, T0), true)
  fs.writeFileSync(path.join(dir, '.sdlc/memory/.cache/dream.lock'), 'garbage')
  assert.equal(acquireLock(dir, T0), true)
})

test('snapshotBatch holds only un-dreamed signals and has a safe id', () => {
  const dir = repo(2, 3)
  const b = snapshotBatch(dir, T0)
  assert.equal(b.id, 'batch-2026-10-09T10-00-00-000Z'); assert.match(b.id, BATCH_ID)
  assert.deepEqual(b.signals.map(s => s.id), ['id0', 'id1'])
  assert.deepEqual(JSON.parse(fs.readFileSync(batchPath(dir, b.id), 'utf8')).signals.length, 2)
  assert.ok(!BATCH_ID.test('../../etc/passwd')); assert.ok(!BATCH_ID.test('batch-x/../y'))
})

test('maybeStartDream spawns a detached dream with the recursion guard', () => {
  const dir = repo(3), cfg = loadMemConfig(dir)
  const calls: { cmd: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }[] = []
  const msg = maybeStartDream(dir, cfg, '/p/memory/memory.ts', T0, (cmd, args, opts) => { calls.push({ cmd, args, opts }); return true })
  assert.equal(msg, 'dream started: batch-2026-10-09T10-00-00-000Z')
  assert.equal(calls[0].cmd, process.execPath)
  assert.deepEqual(calls[0].args, ['--disable-warning=ExperimentalWarning', '/p/memory/memory.ts', 'dream', 'batch-2026-10-09T10-00-00-000Z', '--root', dir])
  assert.equal(calls[0].opts.env.RIG_UTIL_DREAMING, '1'); assert.equal(calls[0].opts.cwd, dir)
  assert.equal(maybeStartDream(dir, { ...cfg, cooldownMin: 0 }, '/x', plus(1000), () => true), 'no dream: a dream is running')
  assert.equal(loadDreamState(dir).count, 1)
})

test('maybeStartDream does nothing below threshold and cleans up when spawn fails', () => {
  const low = repo(1)
  assert.match(maybeStartDream(low, loadMemConfig(low), '/x', T0, () => { throw new Error('must not spawn') }), /^no dream: 1 signals pending/)
  const dir = repo(3)
  assert.equal(maybeStartDream(dir, loadMemConfig(dir), '/x', T0, () => false), 'no dream: spawn failed')
  assert.equal(acquireLock(dir, T0), true)
  assert.equal(fs.existsSync(batchPath(dir, 'batch-2026-10-09T10-00-00-000Z')), false)
})
