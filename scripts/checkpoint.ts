// A recorded build slice is committed by the script, so a session that dies keeps its finished work: only on sdlc/<slug>, only the
// slice's planned files, never a push, no pre-commit or commit-msg hook (post-commit and the user's core.hooksPath hooks other
// than those still run; the slice's checks just ran).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, git, gitIn, read, planPath, planFiles, isPlanned, toPosix } from './core.ts'
import { matchesAny } from './model.ts'
import { sliceFiles } from './slices.ts'

export type Checkpoint = { ok: true; sha: string | null } | { ok: false; why: string }

// Changed paths in the working tree (staged or not, untracked included), without .rig/ (evidence is committed by `pr`).
// A rename row is `R  new\0old`: the old path is returned right after the new one, so its deletion is committed too.
function dirty(): string[][] {
  const parts = (gitIn(ROOT, ['status', '--porcelain', '-uall', '-z']) ?? '').split('\0').filter(Boolean)
  const rows: string[][] = []
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i] ?? ''
    const group = [row.slice(3)]
    if (/^[RC]/.test(row)) group.push(parts[++i] ?? '')
    rows.push(group.map(toPosix).filter(f => f && !f.startsWith('.rig/')))
  }
  return rows.filter(g => g.length)
}

// Paths are literal (no globs, no :(magic)); the first stderr line is kept for the failure message, all of it to spot a missing identity.
function lit(args: string[], identity = false): { ok: boolean; err: string; full: string } {
  const who = identity ? ['-c', 'user.name=sdlc', '-c', 'user.email=sdlc@localhost'] : []
  try {
    execFileSync('git', ['--literal-pathspecs', ...who, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 })
    return { ok: true, err: '', full: '' }
  } catch (e) {
    const full = String((e as { stderr?: string }).stderr ?? e).trim()
    return { ok: false, err: full.split('\n')[0] ?? '', full }
  }
}

export function commitSlice(slug: string, slice: string): Checkpoint {
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== `sdlc/${slug}`) return { ok: true, sha: null }
  const planned = planFiles(slug)
  const own = sliceFiles(read(planPath(slug)))[slice] ?? []
  const files = dirty().filter(g => isPlanned(g[0] ?? '', planned) && (!own.length || matchesAny(g[0] ?? '', own))).flat()
  if (!files.length) return { ok: true, sha: null }
  // -A stages an unstaged deletion too; a deletion already staged (git rm) is in neither the tree nor the index, so add would fail on it.
  const indexed = new Set((gitIn(ROOT, ['--literal-pathspecs', 'ls-files', '-z', '--', ...files]) ?? '').split('\0'))
  const toAdd = files.filter(f => fs.existsSync(path.join(ROOT, f)) || indexed.has(f))
  const added = toAdd.length ? lit(['add', '-A', '--', ...toAdd]) : { ok: true, err: '', full: '' }
  if (!added.ok) return { ok: false, why: `git add failed: ${added.err}` }
  const msg = `sdlc/${slug}: slice ${slice}`
  // --only (-o) with the pathspec commits just these files, whatever else the person has staged.
  const commit = ['commit', '-q', '--no-verify', '-m', msg, '--only', '--', ...files]
  let r = lit(commit)
  let note = ''
  if (!r.ok && /Please tell me who you are|unable to auto-detect email/.test(r.full)) {
    r = lit(commit, true)
    note = ' (with the sdlc <sdlc@localhost> identity, as no git identity is set)'
  }
  if (!r.ok) return { ok: false, why: `git commit failed: ${r.err}${note}` }
  return { ok: true, sha: git(['rev-parse', '--short', 'HEAD']) }
}
