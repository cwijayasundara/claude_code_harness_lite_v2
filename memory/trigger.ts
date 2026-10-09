import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readJson, writeJson } from '../shared/json.ts'
import { type MemConfig, cacheDir } from './config.ts'
import { type Signal, readSignals } from './capture.ts'

export type Batch = { id: string; signals: Signal[] }
export type DreamState = { last: string; day: string; count: number }
export type Spawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => boolean
export const LOCK_STALE_MS = 15 * 60_000
export const BATCH_ID = /^batch-[0-9TZ-]+$/

const lockPath = (root: string): string => path.join(cacheDir(root), 'dream.lock')
const statePath = (root: string): string => path.join(cacheDir(root), 'last-dream.json')
export const batchPath = (root: string, id: string): string => path.join(cacheDir(root), `${id}.json`)
const day = (d: Date): string => d.toISOString().slice(0, 10)

// The lock body is written to a private temp file and hard-linked into place: the lock
// appears complete or not at all, and link() fails if another process already holds it.
function createLock(f: string, now: Date): boolean {
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: now.toISOString() }))
  try { fs.linkSync(tmp, f); return true } catch { return false } finally { fs.rmSync(tmp, { force: true }) }
}

// A parseable lock is judged by its recorded ts; an unparseable one by its mtime.
function isStale(f: string, now: Date): boolean {
  let text: string, mtime: number
  try { text = fs.readFileSync(f, 'utf8'); mtime = fs.statSync(f).mtimeMs } catch { return false }
  let ts = NaN
  try { ts = Date.parse(JSON.parse(text).ts) } catch { /* unparseable: fall back to mtime */ }
  if (!Number.isFinite(ts)) ts = mtime
  return now.getTime() - ts >= LOCK_STALE_MS
}

export function acquireLock(root: string, now = new Date()): boolean {
  const f = lockPath(root)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  if (createLock(f, now)) return true
  if (!isStale(f, now)) return false
  // Takeover: only the process whose rename succeeds may replace the stale lock.
  const aside = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.stale`
  try { fs.renameSync(f, aside) } catch { return false }
  // The lock may have been replaced between our check and the rename; if the file we moved
  // is not stale after all, put it back and give up.
  if (!isStale(aside, now)) {
    try { fs.linkSync(aside, f) } catch { /* someone already re-created the lock */ }
    fs.rmSync(aside, { force: true })
    return false
  }
  fs.rmSync(aside, { force: true })
  return createLock(f, now)
}

export function releaseLock(root: string): void {
  fs.rmSync(lockPath(root), { force: true })
}

export function loadDreamState(root: string): DreamState {
  const s = readJson<unknown>(statePath(root), null)
  if (!s || typeof s !== 'object') return { last: '', day: '', count: 0 }
  const o = s as Record<string, unknown>
  return { last: String(o.last ?? ''), day: String(o.day ?? ''), count: Number(o.count) || 0 }
}

export function recordDream(root: string, now = new Date()): void {
  const st = loadDreamState(root)
  writeJson(statePath(root), { last: now.toISOString(), day: day(now), count: st.day === day(now) ? st.count + 1 : 1 })
}

export function shouldDream(root: string, cfg: MemConfig, now = new Date()): { ok: boolean; reason: string } {
  const pending = readSignals(root).filter(s => !s.dreamed).length
  if (pending < Math.max(1, cfg.minSignals)) return { ok: false, reason: `${pending} signals pending (need ${cfg.minSignals})` }
  const st = loadDreamState(root)
  const last = Date.parse(st.last)
  if (Number.isFinite(last) && now.getTime() - last < cfg.cooldownMin * 60_000) return { ok: false, reason: 'cooldown' }
  if (st.day === day(now) && st.count >= cfg.maxDreamsPerDay) return { ok: false, reason: 'daily cap reached' }
  return { ok: true, reason: `${pending} signals pending` }
}

export function snapshotBatch(root: string, now = new Date()): Batch {
  const b: Batch = { id: `batch-${now.toISOString().replace(/[:.]/g, '-')}`, signals: readSignals(root).filter(s => !s.dreamed) }
  writeJson(batchPath(root, b.id), b)
  return b
}

export const detachedSpawn: Spawn = (cmd, args, opts) => {
  try {
    const c = spawn(cmd, args, { ...opts, detached: true, stdio: 'ignore' })
    c.on('error', () => { /* logged by the dream process when it runs; nothing to do here */ })
    c.unref()
    return true
  } catch { return false }
}

export function maybeStartDream(root: string, cfg: MemConfig, memoryTs: string, now = new Date(), run: Spawn = detachedSpawn): string {
  const d = shouldDream(root, cfg, now)
  if (!d.ok) return `no dream: ${d.reason}`
  if (!acquireLock(root, now)) return 'no dream: a dream is running'
  let id = ''
  let started = false
  try {
    id = snapshotBatch(root, now).id
    started = run(process.execPath, ['--disable-warning=ExperimentalWarning', memoryTs, 'dream', id, '--root', root], { cwd: root, env: { ...process.env, RIG_UTIL_DREAMING: '1' } })
    if (!started) return 'no dream: spawn failed'
    // Recorded only once the dream is running, so a failed spawn spends no daily slot or cooldown.
    recordDream(root, now)
    return `dream started: ${id}`
  } catch (e) {
    return started ? `dream started: ${id}` : `no dream: ${(e as Error).message}`
  } finally {
    if (!started) {
      releaseLock(root)
      if (id) try { fs.rmSync(batchPath(root, id), { force: true }) } catch { /* not removable: leave it */ }
    }
  }
}
