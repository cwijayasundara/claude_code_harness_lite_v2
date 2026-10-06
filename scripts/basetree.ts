// The one way to look at the base commit: a throwaway worktree with the dependency directories linked in, always removed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, gitIn } from './core.ts'

// Directories the base checkout borrows from the working checkout, so project tools can run there.
export const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor']

export type BaseTree<T> = { ok: true; value: T } | { ok: false; error: string }

// Runs fn in a checkout of `base`, then removes it. With `sparse` (directories relative to the root) only those directories
// and the root-level files are written, so a large repository's base checkout stays small.
export function withBaseTree<T>(base: string, fn: (dir: string) => T, o: { sparse?: string[]; prefix?: string } = {}): BaseTree<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), o.prefix ?? 'rig-base-'))
  const sparse = o.sparse?.length ? o.sparse : null
  try {
    if (gitIn(ROOT, ['worktree', 'add', '--detach', '-q', ...(sparse ? ['--no-checkout'] : []), dir, base]) === null) return { ok: false, error: `could not create a worktree at ${base}` }
    if (sparse && (gitIn(dir, ['sparse-checkout', 'set', '--cone', ...sparse]) === null || gitIn(dir, ['checkout', '-q', '-f', 'HEAD']) === null)) return { ok: false, error: 'could not sparse-checkout the base' }
    for (const d of DEP_DIRS) {
      const from = path.join(ROOT, d)
      const to = path.join(dir, d)
      if (!fs.existsSync(from) || fs.existsSync(to)) continue
      try { fs.symlinkSync(from, to, 'junction') } catch (e) { return { ok: false, error: `could not link ${d} into the base worktree: ${(e as Error).message}` } }
    }
    return { ok: true, value: fn(dir) }
  } finally {
    gitIn(ROOT, ['worktree', 'remove', '--force', dir])
    fs.rmSync(dir, { recursive: true, force: true })
    gitIn(ROOT, ['worktree', 'prune'])
  }
}
