import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Config, globToRegExp } from './config.ts'
import { WIKI_DIR } from './core.ts'
import { SECRET_PATH } from '../shared/secrets.ts'

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|py|go|java)$/
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '__pycache__', '.venv', 'vendor'])

function gitFiles(root: string): string[] | null {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null
}

function walk(root: string, rel = ''): string[] {
  const out: string[] = []
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) out.push(...walk(root, p)) } else out.push(p)
  }
  return out
}

// Minimal .gitignore support for directories that are not git repos: plain names, dir/, *.ext, anchored /paths.
function gitignoreRes(root: string): RegExp[] {
  let text = ''
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8') } catch { return [] }
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('!')).flatMap(l => {
    const anchored = l.startsWith('/')
    const p = l.replace(/^\//, '').replace(/\/$/, '')
    return (anchored ? [p, `${p}/**`] : [p, `${p}/**`, `**/${p}`, `**/${p}/**`]).map(globToRegExp)
  })
}

export function isSource(rel: string, cfg: Config): boolean {
  return SOURCE.test(rel) && !SECRET_PATH.test(rel) && !rel.startsWith(`${WIKI_DIR}/`)
    && !rel.split('/').some(s => SKIP_DIR.has(s)) && !cfg.ignore.some(g => globToRegExp(g).test(rel))
}

export function listFiles(root: string, cfg: Config): string[] {
  const tracked = gitFiles(root)
  const gi = tracked ? [] : gitignoreRes(root)
  return (tracked ?? walk(root))
    .filter(f => isSource(f, cfg) && !gi.some(re => re.test(f)))
    .filter(f => { try { return !fs.lstatSync(path.join(root, f)).isSymbolicLink() } catch { return false } })   // also drops tracked files deleted from the working tree
    .sort()
}
