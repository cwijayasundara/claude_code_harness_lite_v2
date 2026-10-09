import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Config, globToRegExp } from './config.ts'
import { WIKI_DIR } from './core.ts'

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|py|go|java)$/
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '__pycache__', '.venv', 'vendor'])
const SECRET = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*)$/

function gitFiles(root: string): string[] | null {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null
}

function walk(root: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) out.push(...walk(root, p)) } else out.push(p)
  }
  return out
}

export function listFiles(root: string, cfg: Config): string[] {
  const all = gitFiles(root) ?? walk(root)
  const ignored = cfg.ignore.map(globToRegExp)
  return all
    .filter(f => SOURCE.test(f) && !SECRET.test(f) && !f.startsWith(`${WIKI_DIR}/`))
    .filter(f => !f.split('/').some(s => SKIP_DIR.has(s)))
    .filter(f => !ignored.some(re => re.test(f)))
    .filter(f => fs.existsSync(path.join(root, f)))   // git still lists tracked files deleted from the working tree
    .sort()
}
