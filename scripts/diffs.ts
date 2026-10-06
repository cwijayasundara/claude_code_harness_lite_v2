// What changed: turn baselines and git diffs (tracked and untracked files) in the pure diff model.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, read, sha, now, git, withLock, writeAtomic } from './core.ts'
import { parseUnifiedDiff, type FileDiff } from './model.ts'

export type Snapshot = { sha: string; at: string; untracked: Record<string, string> }
type Baselines = { main?: Snapshot; agents: Record<string, Snapshot> }

const BASELINE = path.join(SDLC, '.baseline')
// Past this a file is not read at all (a hook must not run out of memory or time, which would switch the gate off): it is flagged, and the size sensor blocks.
const MAX_SCAN_BYTES = 20_000_000
const tooBig = (rel: string): boolean => { try { return fs.statSync(path.join(ROOT, rel)).size > MAX_SCAN_BYTES } catch { return false } }
const DIFF = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M']

const untrackedFiles = (): string[] => (git(['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean)

// Size, mtime and ctime, never contents, so tens of thousands of untracked files are not all read on every hook. ctime cannot be set
// from userland, so an edit that keeps the size and restores the mtime (touch -r) still changes the fingerprint.
function fingerprint(rel: string): string {
  try {
    const st = fs.statSync(path.join(ROOT, rel))
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`
  } catch {
    return 'gone'
  }
}

// `git stash create` records tracked changes (staged and unstaged) without touching the tree.
// It ignores untracked files, so those are fingerprinted separately.
export function snapshot(): Snapshot | null {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!head) return null
  // stash create needs a committer identity; give it a fixed one. '' means a clean tree (use HEAD); null is a real failure,
  // and no baseline beats a wrong one that would blame earlier uncommitted edits on this turn.
  const stash = git(['-c', 'user.name=sdlc', '-c', 'user.email=sdlc@localhost', 'stash', 'create'])
  if (stash === null) return null
  return { sha: stash || head, at: now(), untracked: Object.fromEntries(untrackedFiles().map(f => [f, fingerprint(f)])) }
}

function readAll(): Baselines {
  try {
    const all = JSON.parse(read(BASELINE)) as Baselines
    return { main: all.main, agents: all.agents ?? {} }
  } catch {
    return { agents: {} }
  }
}

export const readBaseline = (agentId?: string): Snapshot | null => (agentId ? readAll().agents[agentId] : readAll().main) ?? null

// A new main turn starts fresh; a subagent's baseline is added beside the main one.
export function writeBaseline(snap: Snapshot, agentId?: string): void {
  withLock(BASELINE, () => {
    const all: Baselines = agentId ? readAll() : { agents: {} }
    if (agentId) all.agents[agentId] = snap
    else all.main = snap
    writeAtomic(BASELINE, JSON.stringify(all))
  })
}

function addedFile(rel: string): FileDiff {
  if (tooBig(rel)) return { file: rel, status: 'A', added: [], removed: [], binary: true, oversize: true }
  const text = read(path.join(ROOT, rel))
  if (text.includes('\0')) return { file: rel, status: 'A', added: [], removed: [], binary: true }
  return { file: rel, status: 'A', added: text.replace(/\n$/, '').split('\n').map((t, i) => ({ n: i + 1, text: t })), removed: [] }
}

// A file untracked at the snapshot and committed unchanged during the turn shows as added against the snapshot's
// commit, but the turn did not change it.
const unchangedSinceSnap = (snap: Snapshot, d: FileDiff): boolean => d.status === 'A' && snap.untracked[d.file] !== undefined && snap.untracked[d.file] === fingerprint(d.file)

export function turnDiff(snap: Snapshot): FileDiff[] {
  const tracked = parseUnifiedDiff(git([...DIFF, snap.sha]) ?? '').filter(d => !unchangedSinceSnap(snap, d))
  const fresh = untrackedFiles().filter(f => snap.untracked[f] !== fingerprint(f))
  return [...tracked, ...fresh.map(addedFile)]
}

export function fileDiff(snap: Snapshot, rel: string): FileDiff[] {
  if (untrackedFiles().includes(rel)) return snap.untracked[rel] === fingerprint(rel) ? [] : [addedFile(rel)]
  return parseUnifiedDiff(git([...DIFF, snap.sha, '--', rel]) ?? '').filter(d => !unchangedSinceSnap(snap, d))
}

export const branchDiff = (base: string): FileDiff[] => [...parseUnifiedDiff(git([...DIFF, base]) ?? ''), ...untrackedFiles().map(addedFile)]

// What `git commit` would record: the index against HEAD (no HEAD yet means everything staged is new).
export const stagedDiff = (): FileDiff[] => parseUnifiedDiff(git([...DIFF, '--cached']) ?? '')
export const showStaged = (rel: string): string | null => git(['show', `:${rel}`])

export const showAt = (ref: string, rel: string): string | null => git(['show', `${ref}:${rel}`])

export function fileLines(files: string[], textOf: (rel: string) => string = rel => read(path.join(ROOT, rel))): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of files) {
    if (tooBig(f)) continue
    const text = textOf(f)
    if (text) counts[f] = text.replace(/\n$/, '').split('\n').length
  }
  return counts
}

export const diffHash = (diffs: FileDiff[]): string => sha(JSON.stringify(diffs))
