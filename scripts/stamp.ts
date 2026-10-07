// The tree stamp: one fingerprint of everything a verdict depends on, so a later gate can ask "is this the tree that was
// verified?" instead of running the same commands again. Local evidence only: CI never reads a stamp.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, SDLC, CHANGES, git, read, sha, frontmatter } from './core.ts'
import { readRatchet } from './ratchet.ts'

// What `git write-tree` would record for the working tree (tracked and untracked files, ignored ones left out) with
// .sdlc/ removed: harness evidence changes with every run, and the same content has the same stamp before and after a
// commit. The two config files are folded in separately because they sit inside .sdlc/. Null when there is no commit.
export function treeStamp(): string | null {
  if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'])) return null
  const index = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (!index) return null
  const tmp = path.join(os.tmpdir(), `rig-index-${process.pid}-${Math.random().toString(36).slice(2)}`)
  try {
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, tmp)
      // Keep the real index's mtime: git decides whether a same-second, same-size edit is "racily clean" by comparing entry
      // times with the index file's time, and a fresh copy would make a stale cached blob look trustworthy.
      const st = fs.statSync(index)
      fs.utimesSync(tmp, st.atime, st.mtime)
    }
    const run = (args: string[]): string => execFileSync('git', args, { cwd: ROOT, env: { ...process.env, GIT_INDEX_FILE: tmp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim()
    run(['add', '-A', '--', '.', ':(exclude).sdlc'])
    run(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '.sdlc'])
    return sha([run(['write-tree']), sha(read(path.join(SDLC, 'sensors.json'))), sha(read(path.join(SDLC, 'rules.json')))].join('|'))
  } catch {
    return null
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// verification.md was written by sdlc, passed, and was stamped on exactly this tree. fullCovered: its declared full
// commands also passed there, so ship and push need not run them again.
export function verificationFresh(slug: string): { fullCovered: boolean } {
  const { data } = frontmatter(read(path.join(CHANGES, slug, 'verification.md')))
  const now = treeStamp()
  const fresh = data.generated === 'sdlc' && data.result === 'pass' && Boolean(data.tree) && now !== null && data.tree === now
  return { fullCovered: fresh && data.full === 'pass' }
}

// The sensors node finished clean on exactly this tree.
export function sensorsFresh(slug: string): boolean {
  const node = readRatchet(slug).nodes.sensors
  const now = treeStamp()
  return node?.status === 'done' && Boolean(node.tree) && now !== null && node.tree === now
}
