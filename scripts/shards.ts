// Review shards: a diff split so that no reviewer reads more than it can hold (the same bounds as the official
// code-modernization plugin's shard builder: at most 25 files and 5,000 changed lines).
import { checkSlug, defaultBase, fail, out, type Args } from './core.ts'
import { activeSlug } from './graph.ts'
import { loadConfig } from './check.ts'
import { branchDiff } from './diffs.ts'
import { matchesAny } from './model.ts'
import { scopeOf } from './scopes.ts'

export type Shard = { name: string; files: string[]; lines: number }
export const MAX_SHARD_FILES = 25
export const MAX_SHARD_LINES = 5000

// Files in key order, then path order (so a group stays together), packed greedily. The key (keyOf, by default the top-level
// directory; a scope name when scopes are declared) also names the shard. A file larger than the line bound gets a shard
// of its own: nothing is ever dropped.
export function makeShards(files: { file: string; lines: number }[], maxFiles = MAX_SHARD_FILES, maxLines = MAX_SHARD_LINES, keyOf: (file: string) => string = f => f.split('/')[0] ?? '.'): Shard[] {
  const shards: Shard[] = []
  let cur: Shard | null = null
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  for (const f of [...files].sort((a, b) => order(keyOf(a.file), keyOf(b.file)) || order(a.file, b.file))) {
    if (!cur || cur.files.length >= maxFiles || cur.lines + f.lines > maxLines) {
      cur = { name: '', files: [], lines: 0 }
      shards.push(cur)
    }
    cur.files.push(f.file)
    cur.lines += f.lines
  }
  shards.forEach((s, i) => {
    const keys = [...new Set(s.files.map(keyOf))]
    s.name = `${String(i + 1).padStart(2, '0')}-${keys.slice(0, 3).join('+')}${keys.length > 3 ? '+' : ''}`
  })
  return shards
}

export function cmdShards(args: Args): void {
  const slug = args.pos[0] ? checkSlug(args.pos[0]) : activeSlug()
  if (!slug) fail('usage: shards <slug> [--json]')
  const { config } = loadConfig()
  const base = defaultBase() ?? 'HEAD'
  const files = branchDiff(base)
    .filter(d => !d.binary && !d.file.startsWith('.rig/') && !matchesAny(d.file, config.ignore))
    .map(d => ({ file: d.file, lines: d.added.length + d.removed.length }))
  const keyOf = Object.keys(config.scopes).length ? (f: string): string => { const g = scopeOf(f, config); return g ? config.scopes[g]?.name ?? '(unscoped)' : '(unscoped)' } : undefined
  const shards = makeShards(files, MAX_SHARD_FILES, MAX_SHARD_LINES, keyOf)
  if (args.opt.json) return out(JSON.stringify({ base, shards }))
  out(shards.map(s => `${s.name}: ${s.files.length} file(s), ${s.lines} changed line(s)`).join('\n') || 'no changed files to review')
}
