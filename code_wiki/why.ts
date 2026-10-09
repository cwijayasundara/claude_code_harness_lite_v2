import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export type Why = { slug: string; intent: string; linked: boolean }
export type Change = Why & { files: Set<string> }

const git = (root: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 })
  return r.status === 0 ? r.stdout : ''
}

function intentOf(root: string, slug: string): { intent: string; linked: boolean } {
  try {
    const text = fs.readFileSync(path.join(root, '.sdlc/changes', slug, 'intent.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
    const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? ''
    return { intent: line.replace(/^#+\s*/, '') || slug, linked: true }
  } catch { return { intent: slug, linked: false } }
}

// One pass over git history for every rig change; callers filter per module with pick().
export function loadChanges(root: string): Change[] {
  const dir = path.join(root, '.sdlc/changes')
  if (!fs.existsSync(dir)) return []
  const out: Change[] = []
  for (const slug of fs.readdirSync(dir).sort()) {
    if (!/^[\w.-]+$/.test(slug)) continue
    const files = new Set<string>()
    for (const sha of git(root, ['log', '--format=%H', '--', `.sdlc/changes/${slug}`]).split('\n').filter(Boolean))
      for (const f of git(root, ['show', '--name-only', '--format=', sha]).split('\n')) if (f && !f.startsWith('.sdlc/')) files.add(f)
    out.push({ slug, ...intentOf(root, slug), files })
  }
  return out
}

export const pick = (changes: Change[], files: string[]): Why[] =>
  changes.filter(c => files.some(f => c.files.has(f))).map(({ slug, intent, linked }) => ({ slug, intent, linked }))

export const changesFor = (root: string, files: string[]): Why[] => pick(loadChanges(root), files)
