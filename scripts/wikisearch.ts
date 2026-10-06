// Zero-token search over the wiki: pages, entry-point symbols and file paths, ranked by weighted term hits.
import { cmp } from './wikigraph.ts'

export type Doc = { page: string; text: string; symbols: { ref: string; text: string }[]; files: string[] }
export type Hit = { ref: string; text: string }
export type PageHit = { page: string; score: number; hits: Hit[] }

const MAX_QUERY = 200
const MAX_TERMS = 20

// The query is untrusted: it is capped first, then only split and compared as plain text (never built into a RegExp).
export const termsOf = (query: string): string[] => [...new Set(query.slice(0, MAX_QUERY).toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1))].slice(0, MAX_TERMS)

// Title 3, headings 2, symbols 2, body 1 per occurrence (at most 5), path 1; ties break by page name.
export function searchDocs(docs: Doc[], query: string, limit = 5, dir = 'docs/wiki'): PageHit[] {
  const terms = termsOf(query)
  if (!terms.length) return []
  const ranked = docs.map((d): PageHit => {
    const lines = d.text.split('\n')
    const title = (lines.find(l => /^#\s/.test(l)) ?? '').toLowerCase()
    const headings = lines.filter(l => /^#{2,}\s/.test(l)).map(l => l.toLowerCase())
    const body = d.text.toLowerCase()
    let score = 0
    for (const t of terms) {
      if (title.includes(t)) score += 3
      if (headings.some(h => h.includes(t))) score += 2
      if (d.symbols.some(s => s.text.toLowerCase().includes(t))) score += 2
      score += Math.min(5, body.split(t).length - 1)
      if (d.page.toLowerCase().includes(t) || d.files.some(f => f.toLowerCase().includes(t))) score += 1
    }
    const matches = (s: string): boolean => terms.some(t => s.toLowerCase().includes(t))
    const symbolHits = d.symbols.filter(s => matches(s.text)).slice(0, 2)
    const pageHits = lines.map((text, i) => ({ ref: `${dir}/${d.page}:${i + 1}`, text: text.trim() })).filter(h => h.text && matches(h.text)).slice(0, 3)
    return { page: d.page, score, hits: [...symbolHits, ...pageHits].map(h => ({ ref: h.ref, text: h.text.slice(0, 120) })) }
  })
  return ranked.filter(r => r.score > 0).sort((a, b) => b.score - a.score || cmp(a.page, b.page)).slice(0, limit)
}
