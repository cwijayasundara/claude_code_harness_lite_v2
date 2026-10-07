// A recorded build slice is committed by the script, so a session that dies keeps its finished work: only on sdlc/<slug>, only the
// slice's planned files, never a push, no hooks (the slice's checks just ran).
import { ROOT, git, gitIn, read, planPath, planFiles, isPlanned, toPosix } from './core.ts'
import { matchesAny } from './model.ts'
import { sliceFiles } from './slices.ts'

export type Checkpoint = { ok: true; sha: string | null } | { ok: false; why: string }

// Changed paths in the working tree (staged or not, untracked included), without .sdlc/ (evidence is committed by `pr`).
function dirty(): string[] {
  const parts = (gitIn(ROOT, ['status', '--porcelain', '-uall', '-z']) ?? '').split('\0').filter(Boolean)
  const files: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i] ?? ''
    files.push(row.replace(/^[ MADRCUT?!]{1,2} /, ''))
    if (/^[RC]/.test(row)) i++
  }
  return files.map(toPosix).filter(f => !f.startsWith('.sdlc/'))
}

export function commitSlice(slug: string, slice: string): Checkpoint {
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== `sdlc/${slug}`) return { ok: true, sha: null }
  const planned = planFiles(slug)
  const own = sliceFiles(read(planPath(slug)))[slice] ?? []
  const files = dirty().filter(f => isPlanned(f, planned) && (!own.length || matchesAny(f, own)))
  if (!files.length) return { ok: true, sha: null }
  if (gitIn(ROOT, ['add', '--', ...files]) === null) return { ok: false, why: 'git add failed' }
  const msg = `sdlc/${slug}: slice ${slice}`
  // --only (-o) with the pathspec commits just these files, whatever else the person has staged.
  const done = gitIn(ROOT, ['commit', '-q', '--no-verify', '-m', msg, '--only', '--', ...files]) !== null
    || gitIn(ROOT, ['-c', 'user.name=sdlc', '-c', 'user.email=sdlc@localhost', 'commit', '-q', '--no-verify', '-m', msg, '--only', '--', ...files]) !== null
  if (!done) return { ok: false, why: 'git commit failed (is signing configured and unavailable?)' }
  return { ok: true, sha: git(['rev-parse', '--short', 'HEAD']) }
}
