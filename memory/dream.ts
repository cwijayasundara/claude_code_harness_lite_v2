import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readJson } from '../shared/json.ts'
import { type MemConfig, cacheDir } from './config.ts'
import { markDreamed } from './capture.ts'
import { buildDreamInput } from './input.ts'
import { applyOps } from './apply.ts'
import { type Batch, acquireLock, batchPath, recordDream, releaseLock, snapshotBatch } from './trigger.ts'

export type Runner = (input: string, model: string, root: string) => { ok: boolean; out: string; err: string }
export const PROMPT_FILE = path.join(import.meta.dirname, 'dreamer.md')

// Flags that keep the dream call tool-less: no built-in tools, no MCP servers from user or
// project config, no slash commands, no session saved, a single turn.
export const claudeArgs = (model: string): string[] => [
  '-p', '--model', model, '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
  '--system-prompt-file', PROMPT_FILE, '--max-turns', '1', '--no-session-persistence', '--output-format', 'text',
]

export const claudeRunner: Runner = (input, model, root) => {
  const r = spawnSync('claude', claudeArgs(model),
    { cwd: root, input, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, RIG_UTIL_DREAMING: '1' } })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.error ? String(r.error) : (r.stderr ?? '') }
}

const MAX_BRACKETS = 500
const isOps = (v: unknown): v is unknown[] => Array.isArray(v) && v.every(x => x !== null && typeof x === 'object' && !Array.isArray(x))
const tryOps = (s: string): unknown[] | null => { try { const v = JSON.parse(s); return isOps(v) ? v : null } catch { return null } }

// Fenced blocks first (in order), then every '[' .. ']' span from the first '[' on; the first span that parses to an array of objects wins.
export function extractOps(out: string): unknown[] | null {
  for (const m of out.matchAll(/```[^\n`]*\n?([\s\S]*?)```/g)) {
    const v = tryOps(m[1].trim())
    if (v) return v
  }
  const opens: number[] = [], closes: number[] = []
  for (let i = 0; i < out.length && (opens.length < MAX_BRACKETS || closes.length < MAX_BRACKETS); i++) {
    if (out[i] === '[' && opens.length < MAX_BRACKETS) opens.push(i)
    else if (out[i] === ']' && closes.length < MAX_BRACKETS) closes.push(i)
  }
  for (const a of opens) for (const b of closes) {
    if (b <= a) continue
    const v = tryOps(out.slice(a, b + 1))
    if (v) return v
  }
  return null
}

export function log(root: string, msg: string, now = new Date()): void {
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true })
    fs.appendFileSync(path.join(cacheDir(root), 'log'), `${now.toISOString()} ${msg}\n`)
  } catch { /* logging never throws */ }
}

// Runs every step even if an earlier one throws; the lock goes first so it is never leaked.
const cleanup = (steps: Array<() => void>): void => {
  for (const step of steps) { try { step() } catch { /* one failing step must not skip the others */ } }
}

export function runDream(root: string, batchId: string, cfg: MemConfig, runner: Runner = claudeRunner, now = new Date()): string {
  const done = (msg: string): string => {
    cleanup([
      () => releaseLock(root),
      () => fs.rmSync(batchPath(root, batchId), { force: true }),
      () => log(root, msg, now),
    ])
    return msg
  }
  try {
    const batch = readJson<Batch | null>(batchPath(root, batchId), null)
    if (!batch || !Array.isArray(batch.signals)) return done(`dream ${batchId}: batch missing`)
    const { text, used } = buildDreamInput(root, batch)
    if (!used.length) return done(`dream ${batchId}: nothing to dream`)
    const r = runner(text, cfg.model, root)
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
  // Same id snapshotBatch derives from `now`, so a failed start can still remove its batch file.
  const id = `batch-${now.toISOString().replace(/[:.]/g, '-')}`
  const release = (): void => cleanup([() => releaseLock(root), () => fs.rmSync(batchPath(root, id), { force: true })])
  let b: Batch
  try {
    b = snapshotBatch(root, now)
    if (!b.signals.length) { release(); return 'nothing to dream' }
    recordDream(root, now)
  } catch (e) {
    release()
    return `dream ${id}: failed to start: ${String(e).slice(0, 200)}`
  }
  return runDream(root, b.id, cfg, runner, now)
}
