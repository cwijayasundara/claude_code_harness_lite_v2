import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const git = (dir: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })

export function makeRepo(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigbrain-'))
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
    fs.writeFileSync(path.join(dir, p), c)
  }
  if (opts.git !== false) { git(dir, 'init', '-q', '-b', 'main'); commitAll(dir, 'init') }
  return dir
}

export function commitAll(dir: string, msg: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg)
}
