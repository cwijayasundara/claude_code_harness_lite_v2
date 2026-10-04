// Pure helpers shared by the sdlc mod's files. The mod loader follows `$` only into functions declared in
// the same file, so nothing here takes `$`: each file keeps thin local wrappers that pass `$.plugin.root`.
import type { Status } from '../types'

// The core script is TypeScript run by Node's built-in type stripping (Node >= 22.18).
export function sdlcArgv(root: string, ...args: string[]): string[] {
  const script = root.endsWith('/.sdlc/mod') ? `${root}/../bin/sdlc.ts` : `${root}/scripts/sdlc.ts`
  return ['node', '--disable-warning=ExperimentalWarning', script, ...args]
}

export function parseStatus(stdout: string): Status | null {
  try {
    return JSON.parse(stdout) as Status
  } catch {
    return null
  }
}

// Copies of core.ts's slug rule and the graph's node names: the driver puts both into a prompt, so it checks them first.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/
export const NODES: ReadonlySet<string> = new Set(['build', 'diagnose', 'test', 'sensors', 'pr', 'pr-review', 'intent', 'spec', 'plan', 'design', 'notes'])

// Set at session start: true when this copy is the global plugin's and the project vendors its own (.sdlc/mod).
export const mod = { aside: false }
