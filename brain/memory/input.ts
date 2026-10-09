import fs from 'node:fs'
import path from 'node:path'
import { redact } from '../shared/secrets.ts'
import { memDir } from './config.ts'
import type { Signal } from './capture.ts'
import type { Batch } from './trigger.ts'

export const RADIUS = 20
export const MAX_INPUT_CHARS = 120_000
const BLOCK_CHARS = 400

const clip = (s: string, n: number): string => s.length > n ? `${s.slice(0, n)}…` : s

function block(b: any): string {
  if (b?.type === 'text') return String(b.text ?? '')
  if (b?.type === 'tool_use') return `[${b.name} ${JSON.stringify(b.input ?? {})}]`
  if (b?.type === 'tool_result') return `[result ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')}]`
  return ''
}

export function renderLine(line: string): string {
  let o: any
  try { o = JSON.parse(line) } catch { return '' }
  if (!o || (o.type !== 'user' && o.type !== 'assistant')) return ''
  const c = o.message?.content
  const parts: string[] = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(block) : []
  const text = parts.map(p => clip(redact(p).replace(/\s+/g, ' ').trim(), BLOCK_CHARS)).filter(Boolean).join(' ')
  return text ? `${o.type}: ${text}` : ''
}

export function transcriptWindow(lines: string[], at: number, radius = RADIUS): string[] {
  return lines.slice(Math.max(0, at - radius), at + radius).map(renderLine).filter(Boolean)
}

const renderSignal = (s: Signal, win: string[]): string =>
  `### ${s.kind} (session: ${s.session_id}, ${s.ts})\n${Object.entries(s.data).map(([k, v]) => `${k}: ${redact(String(v))}`).join('\n')}\ncontext:\n${win.map(l => `  ${l}`).join('\n') || '  (transcript unavailable)'}\n`

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024

// Only absolute, regular, bounded .jsonl files are read; anything else is unavailable.
function readTranscript(p: string): string[] {
  try {
    if (!path.isAbsolute(p) || !p.endsWith('.jsonl')) return []
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > MAX_TRANSCRIPT_BYTES) return []
    return fs.readFileSync(p, 'utf8').split('\n')
  } catch { return [] }
}

function memorySection(root: string, max: number): string {
  let names: string[] = []
  try { names = fs.readdirSync(memDir(root)).filter(f => f.endsWith('.md')).sort() } catch { /* no memory yet */ }
  const text = names.map(f => { try { return `### ${f}\n${fs.readFileSync(path.join(memDir(root), f), 'utf8')}` } catch { return '' } }).join('\n')
  return clip(redact(text || '(empty)'), max)
}

export function buildDreamInput(root: string, batch: Batch, maxChars = MAX_INPUT_CHARS): { text: string; used: string[] } {
  const head = '## Signals\n'
  const memHead = '## Current memory\n'
  // mem is bounded to half the cap; the whole text is `${head}${blocks}\n${mem}`
  const mem = `${memHead}${memorySection(root, Math.max(0, Math.floor(maxChars / 2) - memHead.length - 1))}\n`
  // reserve the '(none)' placeholder width so the bound holds in the empty case too
  const budget = maxChars - head.length - mem.length - 1 - '(none)'.length
  const files = new Map<string, string[]>()
  const linesOf = (p: string): string[] => {
    if (!files.has(p)) files.set(p, readTranscript(p))
    return files.get(p)!
  }
  const blocks: string[] = [], used: string[] = []
  let size = 0 // sum of block lengths plus the joining newlines between them
  // newest first so the oldest are the ones dropped at the cap
  for (const s of [...batch.signals].reverse()) {
    const b = renderSignal(s, transcriptWindow(linesOf(s.transcript_path), s.transcript_line))
    const cost = b.length + (blocks.length ? 1 : 0)
    if (size + cost <= budget) {
      blocks.unshift(b); used.unshift(s.id); size += cost
      continue
    }
    // newest block alone does not fit: keep a clipped copy rather than dropping everything
    const room = budget - size - (blocks.length ? 1 : 0)
    if (blocks.length === 0 && room > 1) { blocks.unshift(clip(b, room - 1)); used.unshift(s.id) }
    break
  }
  return { text: `${head}${blocks.join('\n') || '(none)'}\n${mem}`, used }
}
