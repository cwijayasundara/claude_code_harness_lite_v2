import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
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

export function acquireLock(root: string, now = new Date()): boolean {
  const f = lockPath(root)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const body = JSON.stringify({ pid: process.pid, ts: now.toISOString() })
  try { fs.writeFileSync(f, body, { flag: 'wx' }); return true } catch { /* held: check age */ }
  let ts = NaN
  try { ts = Date.parse(JSON.parse(fs.readFileSync(f, 'utf8')).ts) } catch { /* corrupt lock counts as stale */ }
  if (Number.isFinite(ts) && now.getTime() - ts < LOCK_STALE_MS) return false
  fs.writeFileSync(f, body)
  return true
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
  const b = snapshotBatch(root, now)
  recordDream(root, now)
  const ok = run(process.execPath, ['--disable-warning=ExperimentalWarning', memoryTs, 'dream', b.id, '--root', root], { cwd: root, env: { ...process.env, RIG_UTIL_DREAMING: '1' } })
  if (ok) return `dream started: ${b.id}`
  releaseLock(root)
  fs.rmSync(batchPath(root, b.id), { force: true })
  return 'no dream: spawn failed'
}
