// What changed: turn baselines and git diffs (tracked and untracked files) in the pure diff model.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, read, sha, now, git } from './core.ts'
import { parseUnifiedDiff, type FileDiff } from './model.ts'

export type Snapshot = { sha: string; at: string; untracked: Record<string, string> }
type Baselines = { main?: Snapshot; agents: Record<string, Snapshot> }

const BASELINE = path.join(SDLC, '.baseline')
const MAX_HASHED_BYTES = 2_000_000
const DIFF = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M']

// The harness's own state under .sdlc/ is not the user's change.
const untrackedFiles = (): string[] => (git(['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(f => f && !f.startsWith('.sdlc/'))

function fingerprint(rel: string): string {
  try {
    const st = fs.statSync(path.join(ROOT, rel))
    return st.size > MAX_HASHED_BYTES ? `${st.size}:${st.mtimeMs}` : sha(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  } catch {
    return 'gone'
  }
}

// `git stash create` records tracked changes (staged and unstaged) without touching the tree.
// It ignores untracked files, so those are fingerprinted separately.
export function snapshot(): Snapshot | null {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!head) return null
  return { sha: git(['stash', 'create']) || head, at: now(), untracked: Object.fromEntries(untrackedFiles().map(f => [f, fingerprint(f)])) }
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
  const all: Baselines = agentId ? readAll() : { agents: {} }
  if (agentId) all.agents[agentId] = snap
  else all.main = snap
  fs.writeFileSync(BASELINE, JSON.stringify(all))
}

function addedFile(rel: string): FileDiff {
  const text = read(path.join(ROOT, rel))
  if (text.includes('\0')) return { file: rel, status: 'A', added: [], removed: [], binary: true }
  return { file: rel, status: 'A', added: text.replace(/\n$/, '').split('\n').map((t, i) => ({ n: i + 1, text: t })), removed: [] }
}

export function turnDiff(snap: Snapshot): FileDiff[] {
  const tracked = parseUnifiedDiff(git([...DIFF, snap.sha]) ?? '')
  const fresh = untrackedFiles().filter(f => snap.untracked[f] !== fingerprint(f))
  return [...tracked, ...fresh.map(addedFile)]
}

export function fileDiff(snap: Snapshot, rel: string): FileDiff[] {
  if (untrackedFiles().includes(rel)) return snap.untracked[rel] === fingerprint(rel) ? [] : [addedFile(rel)]
  return parseUnifiedDiff(git([...DIFF, snap.sha, '--', rel]) ?? '')
}

export const branchDiff = (base: string): FileDiff[] => [...parseUnifiedDiff(git([...DIFF, base]) ?? ''), ...untrackedFiles().map(addedFile)]

export const showAt = (ref: string, rel: string): string | null => git(['show', `${ref}:${rel}`])

export function fileLines(files: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of files) {
    const text = read(path.join(ROOT, f))
    if (text) counts[f] = text.replace(/\n$/, '').split('\n').length
  }
  return counts
}

export const diffHash = (diffs: FileDiff[]): string => sha(JSON.stringify(diffs))
