export { sha, readJson, writeJson } from '../shared/json.ts'

export type Sym = { name: string; kind: string; signature: string; doc: string }
export type FileInfo = { path: string; module: string; hash: string; lang: 'ts' | 'js' | 'py' | 'go' | 'java'; structureOnly: boolean; symbols: Sym[]; imports: string[] }
export type ModuleInfo = { name: string; files: string[]; hash: string; sigHash: string; structureOnly: boolean; dependsOn: string[]; usedBy: string[] }
export type Index = { generated: string; modules: Record<string, ModuleInfo>; files: Record<string, FileInfo> }
export type ModState = { hash: string; sigHash: string; status: 'fresh' | 'stale'; generated: string; fileHashes?: Record<string, string> }
export type State = { version: 1; modules: Record<string, ModState>; architectureHash: string }

export const WIKI_DIR = '.sdlc/wiki'

export function safeName(s: string): string {
  const n = s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return n || 'module'
}
