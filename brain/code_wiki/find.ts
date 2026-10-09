import type { Index, State } from './core.ts'

export type Hit = { kind: 'module' | 'symbol'; name: string; file: string; page: string; stale: boolean; score: number }

const tokens = (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)

export function findIn(idx: Index, state: State, query: string, limit = 8): Hit[] {
  const ts = tokens(query)
  const hits: Hit[] = []
  for (const m of Object.values(idx.modules)) {
    const page = `.sdlc/wiki/modules/${m.name}.md`
    const stale = state.modules[m.name]?.status === 'stale'
    const modScore = ts.filter(t => m.name.toLowerCase().includes(t)).length * 3
      + ts.filter(t => m.files.some(f => f.toLowerCase().includes(t))).length * 2
    if (modScore) hits.push({ kind: 'module', name: m.name, file: m.files[0], page, stale, score: modScore })
    for (const f of m.files) for (const s of idx.files[f].symbols) {
      const sc = ts.filter(t => s.name.toLowerCase().includes(t)).length * 3
      if (sc) hits.push({ kind: 'symbol', name: s.name, file: f, page, stale, score: sc })
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit)
}
