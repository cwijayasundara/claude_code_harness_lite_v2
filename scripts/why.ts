import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export type Why = { slug: string; intent: string }

const git = (root: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : ''
}

function intentLine(root: string, slug: string): string {
  try {
    const text = fs.readFileSync(path.join(root, '.sdlc/changes', slug, 'intent.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
    const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? ''
    return line.replace(/^#+\s*/, '') || slug
  } catch { return slug }
}

export function changesFor(root: string, files: string[]): Why[] {
  const dir = path.join(root, '.sdlc/changes')
  if (!fs.existsSync(dir)) return []
  const wanted = new Set(files)
  const out: Why[] = []
  for (const slug of fs.readdirSync(dir).sort()) {
    const shas = git(root, ['log', '--format=%H', '--', `.sdlc/changes/${slug}`]).split('\n').filter(Boolean)
    const touched = new Set<string>()
    for (const s of shas) for (const f of git(root, ['show', '--name-only', '--format=', s]).split('\n')) if (f && !f.startsWith('.sdlc/')) touched.add(f)
    if ([...touched].some(f => wanted.has(f))) out.push({ slug, intent: intentLine(root, slug) })
  }
  return out
}
