import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readJson } from '../shared/json.ts'
import { type MemConfig, cacheDir } from './config.ts'
import { markDreamed } from './capture.ts'
import { buildDreamInput } from './input.ts'
import { applyOps } from './apply.ts'
import { type Batch, acquireLock, batchPath, recordDream, releaseLock, snapshotBatch } from './trigger.ts'

export type Runner = (input: string, model: string) => { ok: boolean; out: string; err: string }
export const PROMPT_FILE = path.join(import.meta.dirname, 'dreamer.md')

// One tool-less call: the model can only answer, never read, write or run anything
export const claudeRunner: Runner = (input, model) => {
  const r = spawnSync('claude', ['-p', '--model', model, '--tools', '', '--system-prompt-file', PROMPT_FILE, '--max-turns', '1', '--no-session-persistence', '--output-format', 'text'],
    { input, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RIG_UTIL_DREAMING: '1' } })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.error ? String(r.error) : (r.stderr ?? '') }
}

export function extractOps(out: string): unknown[] | null {
  const cands = [/```(?:json)?\s*([\s\S]*?)```/.exec(out)?.[1]]
  const a = out.indexOf('['), b = out.lastIndexOf(']')
  if (a >= 0 && b > a) cands.push(out.slice(a, b + 1))
  for (const c of cands) {
    if (!c) continue
    try { const v = JSON.parse(c.trim()); if (Array.isArray(v)) return v } catch { /* try the next candidate */ }
  }
  return null
}

export function log(root: string, msg: string, now = new Date()): void {
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true })
    fs.appendFileSync(path.join(cacheDir(root), 'log'), `${now.toISOString()} ${msg}\n`)
  } catch { /* logging never throws */ }
}

export function runDream(root: string, batchId: string, cfg: MemConfig, runner: Runner = claudeRunner, now = new Date()): string {
  const done = (msg: string): string => {
    fs.rmSync(batchPath(root, batchId), { force: true })
    releaseLock(root)
    log(root, msg, now)
    return msg
  }
  try {
    const batch = readJson<Batch | null>(batchPath(root, batchId), null)
    if (!batch || !Array.isArray(batch.signals)) return done(`dream ${batchId}: batch missing`)
    const { text, used } = buildDreamInput(root, batch)
    if (!used.length) return done(`dream ${batchId}: nothing to dream`)
    const r = runner(text, cfg.model)
    if (!r.ok) return done(`dream ${batchId}: model call failed: ${r.err.trim().slice(0, 200)}`)
    const ops = extractOps(r.out)
    if (!ops) return done(`dream ${batchId}: no ops in model output`)
    const res = applyOps(root, cfg, ops, now.toISOString().slice(0, 10))
    markDreamed(root, new Set(used))
    return done(`dream ${batchId}: +${res.added} ~${res.updated} -${res.removed} merged ${res.merged}, rejected ${res.rejected.length}`)
  } catch (e) {
    return done(`dream ${batchId}: failed: ${String(e).slice(0, 200)}`)
  }
}

export function dreamNow(root: string, cfg: MemConfig, runner: Runner = claudeRunner, now = new Date()): string {
  if (!acquireLock(root, now)) return 'a dream is already running'
  const b = snapshotBatch(root, now)
  if (!b.signals.length) { fs.rmSync(batchPath(root, b.id), { force: true }); releaseLock(root); return 'nothing to dream' }
  recordDream(root, now)
  return runDream(root, b.id, cfg, runner, now)
}
