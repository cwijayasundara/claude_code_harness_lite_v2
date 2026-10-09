import fs from 'node:fs'
import path from 'node:path'
import { WIKI_DIR, sha } from './core.ts'
import { loadConfig } from './config.ts'
import { isSource } from './files.ts'
import { moduleOf } from './modules.ts'
import { loadState, saveState, statePath } from './state.ts'

const real = (p: string): string => { try { return fs.realpathSync(p) } catch { return p } }

// Marks a module's page stale only when a source file differs from what the last refresh saw.
// Loads config and state once for the whole batch. Returns how many files differed.
export function markStaleMany(root: string, files: string[]): number {
  try {
    if (!fs.existsSync(statePath(root))) return 0
    const cfg = loadConfig(root), state = loadState(root), base = real(root)
    let differed = 0, changed = false
    for (const file of files) {
      const rel = (path.isAbsolute(file) ? path.relative(base, real(file)) : file).split(path.sep).join('/')
      if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || !isSource(rel, cfg)) continue
      const s = state.modules[moduleOf(rel, cfg)]
      if (!s) continue
      let cur: string | null = null
      try { cur = sha(fs.readFileSync(path.join(base, rel), 'utf8')) } catch { /* deleted */ }
      if (cur !== null && s.fileHashes?.[rel] === cur) continue
      differed++
      if (s.status !== 'stale') { s.status = 'stale'; changed = true }
    }
    if (changed) saveState(root, state)
    return differed
  } catch { return 0 }
}

export const markStale = (root: string, file: string): boolean => markStaleMany(root, [file]) > 0

export function promptContext(root: string, session: string): string {
  try {
    const indexFile = path.join(root, WIKI_DIR, 'INDEX.md')
    if (!fs.existsSync(indexFile)) return ''
    const marker = path.join(root, WIKI_DIR, '.cache', `injected-${session.replace(/[^\w-]/g, '_')}`)
    if (fs.existsSync(marker)) return ''
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, '')
    return `${fs.readFileSync(indexFile, 'utf8')}\nBefore Glob/Grep for a feature or file, check this index or run \`wiki-find\`; verify against the code.`
  } catch { return '' }
}
