// The one way to look at the base commit: a throwaway worktree with the dependency directories linked in, always removed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, gitIn } from './core.ts'

// Directories the base checkout borrows from the working checkout, so project tools can run there.
export const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor']

export type BaseTree<T> = { ok: true; value: T; sparse?: boolean } | { ok: false; error: string }

// A sparse root is written into a pattern file, never passed to git as an argument: a plain relative directory only (no
// option dash, glob character, leading ':' or '..' segment). Anything else makes the base a full checkout.
const SAFE_ROOT = /^[A-Za-z0-9._][A-Za-z0-9._/ -]*$/
export const safeRoot = (r: string): boolean => SAFE_ROOT.test(r) && !r.split('/').includes('..')

// Cone patterns for the roots: root-level files, each root, and each parent's own files (as `git sparse-checkout set --cone`).
export function conePatterns(roots: string[]): string[] {
  const dirs = new Set<string>()
  const parents = new Set<string>()
  for (const r of roots) {
    const parts = r.split('/').filter(p => p && p !== '.')
    for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join('/'))
    if (parts.length) dirs.add(parts.join('/'))
  }
  return ['/*', '!/*/', ...[...parents].sort().flatMap(p => [`/${p}/`, `!/${p}/*/`]), ...[...dirs].sort().map(d => `/${d}/`)]
}

// Populates a --no-checkout worktree sparsely without touching any config: the patterns go into the worktree's own
// private sparse-checkout file and sparse mode is switched on for the one checkout command only (-c, not `sparse-checkout
// set`, which writes extensions.worktreeConfig into the main repository's config). false: not done, check out in full.
function sparseCheckout(dir: string, roots: string[]): boolean {
  if (!roots.every(safeRoot)) return false
  const rel = gitIn(dir, ['rev-parse', '--git-path', 'info/sparse-checkout'])
  if (!rel) return false
  try {
    const file = path.resolve(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, conePatterns(roots).join('\n') + '\n')
  } catch { return false }
  return gitIn(dir, ['-c', 'core.sparseCheckout=true', '-c', 'core.sparseCheckoutCone=true', 'checkout', '-q', '-f', 'HEAD']) !== null
}

// Runs fn in a checkout of `base`, then removes it. With `sparse` (directories relative to the root) only those directories
// and the root-level files are written, so a large repository's base checkout stays small; if that cannot be done the
// checkout is full. With sparse requested, the result's sparse says which one fn saw.
export function withBaseTree<T>(base: string, fn: (dir: string) => T, o: { sparse?: string[]; prefix?: string } = {}): BaseTree<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), o.prefix ?? 'rig-base-'))
  const sparse = o.sparse?.length ? o.sparse : null
  try {
    if (gitIn(ROOT, ['worktree', 'add', '--detach', '-q', ...(sparse ? ['--no-checkout'] : []), dir, base]) === null) return { ok: false, error: `could not create a worktree at ${base}` }
    const isSparse = sparse !== null && sparseCheckout(dir, sparse)
    if (sparse && !isSparse && gitIn(dir, ['checkout', '-q', '-f', 'HEAD']) === null) return { ok: false, error: 'could not check out the base' }
    for (const d of DEP_DIRS) {
      const from = path.join(ROOT, d)
      const to = path.join(dir, d)
      if (!fs.existsSync(from) || fs.existsSync(to)) continue
      try { fs.symlinkSync(from, to, 'junction') } catch (e) { return { ok: false, error: `could not link ${d} into the base worktree: ${(e as Error).message}` } }
    }
    return { ok: true, value: fn(dir), ...(sparse ? { sparse: isSparse } : {}) }
  } finally {
    gitIn(ROOT, ['worktree', 'remove', '--force', dir])
    fs.rmSync(dir, { recursive: true, force: true })
    gitIn(ROOT, ['worktree', 'prune'])
  }
}
