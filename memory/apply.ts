import fs from 'node:fs'
import path from 'node:path'
import { hasSecret } from '../shared/secrets.ts'
import { ensureCacheIgnore } from '../shared/gitignore.ts'
import { type MemConfig, cacheDir, memDir } from './config.ts'
import { type Entry, type Store, TOPIC_FILE, allEntries, entries, findEntry, loadStore, newId, serializeTopic, similarity } from './store.ts'
import { buildMemoryMd } from './memorymd.ts'

export type Rejected = { op: unknown; reason: string }
export type ApplyResult = { added: number; updated: number; removed: number; merged: number; rejected: Rejected[] }
export const MAX_TEXT = 240
export const DUP_THRESHOLD = 0.8
const MAX_REJECTED = 200

export function textProblem(t: unknown): string | null {
  if (typeof t !== 'string' || !t.trim()) return 'text missing'
  if (/[\r\n]/.test(t)) return 'text must be one line'
  if (t.trim().length > MAX_TEXT) return `text over ${MAX_TEXT} chars`
  if (/\[source:/i.test(t)) return 'text has metadata'
  if (hasSecret(t)) return 'text contains a secret'
  return null
}

const cleanSource = (s: unknown): string => (typeof s === 'string' ? s.replace(/[^\w.:-]/g, '') : '').slice(0, 80) || 'unknown'
const dupOf = (s: Store, text: string, except = ''): Entry | undefined => allEntries(s).find(e => e.id !== except && similarity(e.text, text) >= DUP_THRESHOLD)

export function applyOps(root: string, cfg: MemConfig, ops: unknown, today: string): ApplyResult {
  const store = loadStore(root)
  const res: ApplyResult = { added: 0, updated: 0, removed: 0, merged: 0, rejected: [] }
  const reject = (op: unknown, reason: string) => { res.rejected.push({ op, reason }) }
  if (!Array.isArray(ops)) reject(ops, 'ops must be an array')
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') { reject(op, 'op must be an object'); continue }
    const o = op as Record<string, any>
    if (o.op !== 'remove') { const p = textProblem(o.text); if (p) { reject(op, p); continue } }
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    if (o.op === 'add') {
      const file = String(o.file ?? '')
      if (!TOPIC_FILE.test(file)) { reject(op, 'bad file name'); continue }
      if (!store.has(file) && store.size >= cfg.maxFiles) { reject(op, 'too many topic files'); continue }
      const dup = dupOf(store, text)
      if (dup) { reject(op, `duplicate of ${dup.id}`); continue }
      const description = typeof o.description === 'string' && !textProblem(o.description) ? o.description.trim().slice(0, 100) : ''
      const topic = store.get(file) ?? { file, description, lines: [] }
      if (entries(topic).length >= cfg.maxEntriesPerFile) { reject(op, 'topic file full'); continue }
      topic.lines.push({ id: newId(text, new Set(allEntries(store).map(e => e.id))), text, source: cleanSource(o.source), added: today })
      store.set(file, topic); res.added++
    } else if (o.op === 'update') {
      const f = findEntry(store, String(o.id))
      if (!f) { reject(op, 'unknown id'); continue }
      const dup = dupOf(store, text, String(o.id))
      if (dup) { reject(op, `duplicate of ${dup.id}`); continue }
      f.topic.lines[f.i] = { ...(f.topic.lines[f.i] as Entry), text }; res.updated++
    } else if (o.op === 'remove') {
      const f = findEntry(store, String(o.id))
      if (!f) { reject(op, 'unknown id'); continue }
      f.topic.lines.splice(f.i, 1); res.removed++
    } else if (o.op === 'merge') {
      const ids = Array.isArray(o.ids) ? [...new Set(o.ids.map(String))] as string[] : []
      const found = ids.map(id => findEntry(store, id))
      if (ids.length < 2 || found.some(f => !f)) { reject(op, 'merge needs 2+ existing ids'); continue }
      const es = found.map(f => f!.topic.lines[f!.i] as Entry)
      const keep = es.reduce((a, b) => b.added < a.added ? b : a)
      const sources = [...new Set(es.flatMap(e => e.source.split(',')).map(s => s.trim()).filter(Boolean))].join(',').slice(0, 200)
      for (const e of es) if (e !== keep) { const f = findEntry(store, e.id)!; f.topic.lines.splice(f.i, 1) }
      const k = findEntry(store, keep.id)!
      k.topic.lines[k.i] = { ...keep, text, source: sources }; res.merged++
    } else reject(op, 'unknown op')
  }
  if (res.added + res.updated + res.removed + res.merged > 0) writeStore(root, store)
  if (res.rejected.length) appendRejected(root, res.rejected)
  return res
}

// Stage every file first, then rename; a failure while staging leaves .sdlc/memory untouched
export function writeStore(root: string, s: Store): void {
  const dir = memDir(root), stage = path.join(cacheDir(root), `stage-${process.pid}`)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  try {
    const files: [string, string][] = [...s.values()].filter(t => entries(t).length || fs.existsSync(path.join(dir, t.file))).map(t => [t.file, serializeTopic(t)])
    files.push(['MEMORY.md', buildMemoryMd(s)])
    for (const [f, c] of files) fs.writeFileSync(path.join(stage, f), c)
    for (const [f] of files) if (fs.existsSync(path.join(dir, f)) && !fs.statSync(path.join(dir, f)).isFile()) throw new Error(`${f} is not a file`)
    for (const [f] of files) fs.renameSync(path.join(stage, f), path.join(dir, f))
  } finally { fs.rmSync(stage, { recursive: true, force: true }) }
  ensureCacheIgnore(dir)
}

function appendRejected(root: string, rs: Rejected[]): void {
  const f = path.join(cacheDir(root), 'rejected.jsonl')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  let old: string[] = []
  try { old = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { /* first rejection */ }
  const ts = new Date().toISOString()
  fs.writeFileSync(f, [...old, ...rs.map(r => JSON.stringify({ ts, ...r }))].slice(-MAX_REJECTED).join('\n') + '\n')
  ensureCacheIgnore(memDir(root))
}
