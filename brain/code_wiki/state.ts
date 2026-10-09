import path from 'node:path'
import { type Index, type State, WIKI_DIR, readJson, writeJson, sha } from './core.ts'
import { ensureCacheIgnore } from '../shared/gitignore.ts'

export const statePath = (root: string): string => path.join(root, WIKI_DIR, '.state.json')
export const loadState = (root: string): State => readJson<State>(statePath(root), { version: 1, modules: {}, architectureHash: '' })
export const saveState = (root: string, s: State): void => writeJson(statePath(root), s)
export const ensureIgnore = (root: string): void => ensureCacheIgnore(path.join(root, WIKI_DIR))
export const archHash = (idx: Index): string =>
  sha(Object.values(idx.modules).map(m => `${m.name}>${m.dependsOn.join(',')}`).sort().join('\n'))
