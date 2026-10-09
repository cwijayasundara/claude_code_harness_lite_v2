import { spawnSync } from 'node:child_process'

export function repoRoot(dir: string): string {
  const t = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', timeout: 5_000 })
  return t.status === 0 && t.stdout.trim() ? t.stdout.trim() : dir
}
