import fs from 'node:fs'
import path from 'node:path'
import { WIKI_DIR } from './core.ts'
import { loadConfig } from './config.ts'
import { moduleOf } from './modules.ts'
import { loadState, saveState, statePath } from './state.ts'

export function markStale(root: string, file: string): boolean {
  try {
    const rel = path.isAbsolute(file) ? path.relative(root, file) : file
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.startsWith(`${WIKI_DIR}/`)) return false
    if (!fs.existsSync(statePath(root))) return false
    const state = loadState(root)
    const m = moduleOf(rel.split(path.sep).join('/'), loadConfig(root))
    const s = state.modules[m]
    if (!s) return false
    if (s.status !== 'stale') { s.status = 'stale'; saveState(root, state) }
    return true
  } catch { return false }
}

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
