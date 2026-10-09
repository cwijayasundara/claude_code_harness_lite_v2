import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export type Sym = { name: string; kind: string; signature: string; doc: string }
export type FileInfo = { path: string; module: string; hash: string; lang: 'ts' | 'js' | 'py' | 'go' | 'java'; structureOnly: boolean; symbols: Sym[]; imports: string[] }
export type ModuleInfo = { name: string; files: string[]; hash: string; sigHash: string; structureOnly: boolean; dependsOn: string[]; usedBy: string[] }
export type Index = { generated: string; modules: Record<string, ModuleInfo>; files: Record<string, FileInfo> }
export type ModState = { hash: string; sigHash: string; status: 'fresh' | 'stale'; generated: string }
export type State = { version: 1; modules: Record<string, ModState>; architectureHash: string }

export const WIKI_DIR = '.sdlc/wiki'

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return fallback }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export function safeName(s: string): string {
  const n = s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return n || 'module'
}
