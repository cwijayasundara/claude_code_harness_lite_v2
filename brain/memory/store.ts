import fs from 'node:fs'
import path from 'node:path'
import { sha } from '../shared/json.ts'
import { memDir } from './config.ts'

export type Entry = { id: string; text: string; source: string; added: string }
export type Topic = { file: string; description: string; lines: (Entry | string)[] }
export type Store = Map<string, Topic>

export const DEFAULT_TOPICS: Record<string, string> = {
  'commands.md': 'Build, test and run invocations that work',
  'gotchas.md': 'Traps, environment quirks, flaky things',
  'dead-ends.md': 'Approaches tried and ruled out, and why',
  'conventions.md': 'Repo norms learned from user corrections',
}
export const TOPIC_FILE = /^[a-z0-9-]+\.md$/
// memory.md would collide with MEMORY.md on case-insensitive filesystems
export const isTopicFile = (f: string): boolean => TOPIC_FILE.test(f) && f.toLowerCase() !== 'memory.md'
const LINE = /^- (.+) \[source: ([^;\]]*); added: (\d{4}-\d{2}-\d{2}); id: (m-[0-9a-f]{6,16})\]$/

export const isEntry = (l: Entry | string): l is Entry => typeof l !== 'string'
export const entryLine = (e: Entry): string => `- ${e.text} [source: ${e.source}; added: ${e.added}; id: ${e.id}]`
export const entries = (t: Topic): Entry[] => t.lines.filter(isEntry)
export const allEntries = (s: Store): Entry[] => [...s.values()].flatMap(entries)

export function parseTopic(file: string, text: string): Topic {
  let description = DEFAULT_TOPICS[file] ?? ''
  const lines: (Entry | string)[] = []
  for (const [i, l] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    if (i === 0 && l.startsWith('# ')) continue
    if (i <= 1 && l.startsWith('> ')) { description = l.slice(2).trim(); continue }
    const m = LINE.exec(l)
    lines.push(m ? { text: m[1], source: m[2], added: m[3], id: m[4] } : l)
  }
  while (lines.length && lines[0] === '') lines.shift()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { file, description, lines }
}

export function serializeTopic(t: Topic): string {
  const body = t.lines.map(l => isEntry(l) ? entryLine(l) : l).join('\n')
  return `# ${t.file.replace(/\.md$/, '')}\n> ${t.description}\n\n${body}${body ? '\n' : ''}`
}

export function loadStore(root: string): Store {
  const s: Store = new Map()
  for (const [file, description] of Object.entries(DEFAULT_TOPICS)) s.set(file, { file, description, lines: [] })
  let names: string[] = []
  try { names = fs.readdirSync(memDir(root)) } catch { return s }
  for (const f of names.sort()) {
    if (!isTopicFile(f)) continue
    try { s.set(f, parseTopic(f, fs.readFileSync(path.join(memDir(root), f), 'utf8'))) } catch { /* unreadable: skip */ }
  }
  return s
}

export function findEntry(s: Store, id: string): { topic: Topic; i: number } | null {
  for (const topic of s.values()) {
    const i = topic.lines.findIndex(l => isEntry(l) && l.id === id)
    if (i >= 0) return { topic, i }
  }
  return null
}

export const normalize = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function similarity(a: string, b: string): number {
  const x = new Set(normalize(a).split(' ').filter(Boolean)), y = new Set(normalize(b).split(' ').filter(Boolean))
  if (!x.size && !y.size) return 1
  let inter = 0
  for (const w of x) if (y.has(w)) inter++
  return inter / (x.size + y.size - inter)
}

export function newId(text: string, taken: Set<string>): string {
  const h = sha(normalize(text))
  for (let n = 6; n <= 16; n++) if (!taken.has(`m-${h.slice(0, n)}`)) return `m-${h.slice(0, n)}`
  for (let i = 1; ; i++) { const id = `m-${sha(`${text}#${i}`).slice(0, 6)}`; if (!taken.has(id)) return id }
}

export function searchEntries(s: Store, terms: string[]): { file: string; entry: Entry }[] {
  const ts = terms.map(t => t.toLowerCase()).filter(Boolean)
  return [...s.values()].flatMap(t => entries(t).filter(e => ts.length > 0 && ts.every(w => `${t.file} ${e.text}`.toLowerCase().includes(w))).map(entry => ({ file: t.file, entry })))
}
