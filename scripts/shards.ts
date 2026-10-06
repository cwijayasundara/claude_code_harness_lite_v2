// Review shards: a diff split so that no reviewer reads more than it can hold (the same bounds as the official
// code-modernization plugin's shard builder: at most 25 files and 5,000 changed lines).
import { checkSlug, defaultBase, fail, out, type Args } from './core.ts'
import { activeSlug } from './graph.ts'
import { loadConfig } from './check.ts'
import { branchDiff } from './diffs.ts'
import { matchesAny } from './model.ts'

export type Shard = { name: string; files: string[]; lines: number }
export const MAX_SHARD_FILES = 25
export const MAX_SHARD_LINES = 5000

// Files in path order (so a directory stays together), packed greedily. A file larger than the line bound gets a shard
// of its own: nothing is ever dropped.
export function makeShards(files: { file: string; lines: number }[], maxFiles = MAX_SHARD_FILES, maxLines = MAX_SHARD_LINES): Shard[] {
  const shards: Shard[] = []
  let cur: Shard | null = null
  for (const f of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    if (!cur || cur.files.length >= maxFiles || cur.lines + f.lines > maxLines) {
      cur = { name: '', files: [], lines: 0 }
      shards.push(cur)
    }
    cur.files.push(f.file)
    cur.lines += f.lines
  }
  shards.forEach((s, i) => {
    const dirs = [...new Set(s.files.map(f => f.split('/')[0] ?? '.'))]
    s.name = `${String(i + 1).padStart(2, '0')}-${dirs.slice(0, 3).join('+')}${dirs.length > 3 ? '+' : ''}`
  })
  return shards
}

export function cmdShards(args: Args): void {
  const slug = args.pos[0] ? checkSlug(args.pos[0]) : activeSlug()
  if (!slug) fail('usage: shards <slug> [--json]')
  const { config } = loadConfig()
  const base = defaultBase() ?? 'HEAD'
  const files = branchDiff(base)
    .filter(d => !d.binary && !d.file.startsWith('.sdlc/') && !matchesAny(d.file, config.ignore))
    .map(d => ({ file: d.file, lines: d.added.length + d.removed.length }))
  const shards = makeShards(files)
  if (args.opt.json) return out(JSON.stringify({ base, shards }))
  out(shards.map(s => `${s.name}: ${s.files.length} file(s), ${s.lines} changed line(s)`).join('\n') || 'no changed files to review')
}
