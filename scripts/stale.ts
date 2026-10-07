// What status flags without storing anything: artifacts older than the ones they derive from, a verification made on another tree,
// open questions, and slices too big for one implementer. Pure over files and git.
import fs from 'node:fs'
import path from 'node:path'
import { CHANGES, read, frontmatter, exists, isShipped } from './core.ts'
import { openQuestions } from './model.ts'
import { treeStamp } from './stamp.ts'
import { sliceFiles } from './slices.ts'

const mtime = (p: string): number => { try { return fs.statSync(p).mtimeMs } catch { return 0 } }
const TOLERANCE_MS = 1000

// currentTree: undefined computes it when needed; null means unavailable. A shipped change is history, never stale.
export function staleness(slug: string, currentTree?: string | null): string[] {
  if (isShipped(slug)) return []
  const dir = path.join(CHANGES, slug)
  const out: string[] = []
  const older = (a: string, b: string): boolean => exists(path.join(dir, a)) && exists(path.join(dir, b)) && mtime(path.join(dir, a)) + TOLERANCE_MS < mtime(path.join(dir, b))
  if (older('design.md', 'intent.md')) out.push(`${slug}: design.md is older than intent.md: it may not reflect the intent`)
  if (older('plan.md', 'design.md')) out.push(`${slug}: plan.md is older than design.md: it may not reflect the design`)
  const v = frontmatter(read(path.join(dir, 'verification.md'))).data
  if (v.tree) {
    const now = currentTree === undefined ? treeStamp() : currentTree
    if (now !== null && now !== v.tree) out.push(`${slug}: verification.md was made on a different tree: run the test node again`)
  }
  return out
}

export function openItems(slug: string): string[] {
  return ['intent.md', 'spec.md', 'design.md', 'plan.md'].flatMap(f => openQuestions(read(path.join(CHANGES, slug, f))).map(q => `${slug}/${f}: ${q}`))
}

export function sliceWarnings(slug: string, planText: string, max = 5): string[] {
  return Object.entries(sliceFiles(planText)).filter(([, files]) => files.length > max)
    .map(([id, files]) => `${slug}: slice ${id} lists ${files.length} files (limit ${max}): split it so one implementer can hold it`)
}

// Staleness for many changes with the tree stamped at most once, and only if an unshipped change has a stamped verification.
export function stalenessAll(slugs: string[]): string[] {
  const live = slugs.filter(s => !isShipped(s))
  const stamped = live.some(s => frontmatter(read(path.join(CHANGES, s, 'verification.md'))).data.tree)
  const tree = stamped ? treeStamp() : null
  return live.flatMap(s => staleness(s, tree))
}
