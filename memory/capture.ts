import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson, sha } from '../shared/json.ts'
import { redact } from '../shared/secrets.ts'
import { ensureCacheIgnore } from '../shared/gitignore.ts'
import { cacheDir, memDir } from './config.ts'

export type Kind = 'cmd-fail' | 'cmd-fixed' | 'churn' | 'tool-error' | 'correction'
export type Signal = { id: string; ts: string; session_id: string; transcript_path: string; transcript_line: number; kind: Kind; data: Record<string, string>; dreamed: boolean }
export type CaptureEvent = 'post-bash' | 'tool-fail' | 'post-edit' | 'prompt'
export const MAX_SIGNALS = 500
const TRIM_AT = 600
const PAIR_WINDOW_MS = 120_000
const DAY = 86_400_000

const signalsPath = (root: string): string => path.join(cacheDir(root), 'signals.jsonl')

export function readSignals(root: string): Signal[] {
  let text = ''
  try { text = fs.readFileSync(signalsPath(root), 'utf8') } catch { return [] }
  return text.split('\n').flatMap(l => {
    try { const s = JSON.parse(l); return s && typeof s.id === 'string' && typeof s.kind === 'string' ? [s as Signal] : [] } catch { return [] }
  })
}

export function writeSignals(root: string, all: Signal[]): void {
  const f = signalsPath(root)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const keep = all.slice(-MAX_SIGNALS)
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, keep.map(s => JSON.stringify(s)).join('\n') + (keep.length ? '\n' : ''))
  fs.renameSync(tmp, f)
}

// O_APPEND keeps concurrent sessions from clobbering each other; only trimming rewrites the file
export function appendSignal(root: string, s: Signal): void {
  const f = signalsPath(root)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.appendFileSync(f, JSON.stringify(s) + '\n')
  const all = readSignals(root)
  if (all.length > TRIM_AT) writeSignals(root, all)
}

export function markDreamed(root: string, ids: Set<string>): void {
  writeSignals(root, readSignals(root).map(s => ids.has(s.id) ? { ...s, dreamed: true } : s))
}

export function pruneSignals(root: string, now: Date): void {
  const all = readSignals(root)
  const kept = all.filter(s => !(now.getTime() - Date.parse(s.ts) > (s.dreamed ? DAY : 7 * DAY)))
  if (kept.length !== all.length) writeSignals(root, kept)
}

const CORRECTION = /^\s*(no\b|nope\b|don'?t\b|do not\b|stop\b|wrong\b)|\bthat'?s (wrong|not right|incorrect)\b|\binstead\b|\buse \S+,? not \S+|\bnot what i (asked|meant|wanted)\b/i
const TRIVIAL = /^(ls|cat|pwd|echo|grep|rg|find|head|tail|which|cd|wc|git (status|diff|log|show))\b/

export const isCorrection = (p: string): boolean => CORRECTION.test(p)
export const cmdKey = (cmd: string): string => cmd.trim().split(/\s+/).filter(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)).slice(0, 2).join(' ')

const clip = (v: unknown, n: number): string => redact(typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).slice(0, n)

function exitCode(r: unknown): number {
  if (!r || typeof r !== 'object') return 0
  const o = r as Record<string, unknown>
  for (const k of ['exit_code', 'exitCode', 'returnCode', 'code']) if (typeof o[k] === 'number') return o[k] as number
  return 0
}

function transcriptLines(p: string): number {
  try { return (fs.readFileSync(p, 'utf8').match(/\n/g) ?? []).length } catch { return 0 }
}

function hasAssistant(p: string): boolean {
  try { return /"type"\s*:\s*"assistant"/.test(fs.readFileSync(p, 'utf8')) } catch { return false }
}

function bumpEdits(root: string, session: string, file: string): number {
  const f = path.join(cacheDir(root), 'edits.json')
  const raw = readJson<unknown>(f, {})
  const all = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, number>>
  const s = all[session] ?? {}
  s[file] = (s[file] ?? 0) + 1
  delete all[session]; all[session] = s
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k]
  writeJson(f, all)
  return s[file]
}

export function capture(root: string, event: CaptureEvent, input: Record<string, any>, now = new Date()): Signal | null {
  ensureCacheIgnore(memDir(root))
  const session_id = typeof input.session_id === 'string' ? input.session_id : 'unknown'
  const transcript_path = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  const ts = now.toISOString()
  const make = (kind: Kind, data: Record<string, string>): Signal => ({
    id: sha(`${ts}|${session_id}|${kind}|${JSON.stringify(data)}`).slice(0, 12),
    ts, session_id, transcript_path, transcript_line: transcriptLines(transcript_path), kind, data, dreamed: false,
  })
  const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
  let sig: Signal | null = null
  if (event === 'post-bash' || (event === 'tool-fail' && tool === 'Bash')) {
    const cmd = clip(input.tool_input?.command, 300)
    if (!cmd) return null
    const r = input.tool_response
    if (event === 'tool-fail' || exitCode(r) !== 0) {
      sig = make('cmd-fail', { cmd, exit: String(exitCode(r) || 1), error: clip(input.error ?? (r && typeof r === 'object' ? r.stderr : r), 300) })
    } else {
      const all = readSignals(root)
      const paired = new Set(all.filter(s => s.kind === 'cmd-fixed').map(s => s.data.fail))
      const fail = all.filter(s => s.kind === 'cmd-fail' && s.session_id === session_id && !paired.has(s.id)).at(-1)
      const near = fail !== undefined && now.getTime() - Date.parse(fail.ts) <= PAIR_WINDOW_MS && !TRIVIAL.test(cmd.trim())
      if (fail && (cmdKey(fail.data.cmd) === cmdKey(cmd) || near)) sig = make('cmd-fixed', { cmd, failed: fail.data.cmd, error: fail.data.error, fail: fail.id })
    }
  } else if (event === 'tool-fail') {
    sig = make('tool-error', { tool: clip(tool, 60), error: clip(input.error ?? input.tool_response, 300) })
  } else if (event === 'post-edit') {
    const file = input.tool_input?.file_path
    if (typeof file !== 'string' || !file) return null
    const rel = path.relative(root, path.resolve(root, file))
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    if (bumpEdits(root, session_id, rel) === 3) sig = make('churn', { file: clip(rel, 200), edits: '3' })
  } else if (event === 'prompt') {
    const p = input.prompt
    if (typeof p === 'string' && isCorrection(p) && hasAssistant(transcript_path)) sig = make('correction', { prompt: clip(p, 500) })
  }
  if (sig) appendSignal(root, sig)
  return sig
}
