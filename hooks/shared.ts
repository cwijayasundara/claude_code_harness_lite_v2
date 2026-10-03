// Pure helpers shared by the sdlc mod's files. The mod loader follows `$` only into functions declared in
// the same file, so nothing here takes `$`: each file keeps thin local wrappers that pass `$.plugin.root`.
import type { Status } from '../types'

// The core script is TypeScript run by Node's built-in type stripping (Node >= 22.18).
export function sdlcArgv(root: string, ...args: string[]): string[] {
  return ['node', '--disable-warning=ExperimentalWarning', `${root}/scripts/sdlc.ts`, ...args]
}

export function parseStatus(stdout: string): Status | null {
  try {
    return JSON.parse(stdout) as Status
  } catch {
    return null
  }
}
