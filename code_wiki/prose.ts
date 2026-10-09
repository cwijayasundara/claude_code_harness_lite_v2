import type { Prose } from './compose.ts'

// Prose is untrusted model output. It is schema-checked before it can reach a page.
const DIAGRAM = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey)\b/
const unsafeText = (s: string): boolean => /<!--|-->|```/.test(s) || /^\s{0,3}#{1,6}\s/m.test(s)

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.length <= max && !unsafeText(t) ? t : null
}

export function parseProse(raw: unknown): Prose | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const purpose = text(r.purpose, 600), how = text(r.how, 2400)
  if (!purpose || !how) return null
  if (r.mermaid === undefined) return { purpose, how }
  const m = typeof r.mermaid === 'string' ? r.mermaid.trim() : ''
  if (!m || m.length > 2400 || /```|<!--/.test(m) || !DIAGRAM.test(m)) return null
  return { purpose, how, mermaid: m }
}

export const parseNarrative = (raw: unknown): string | null =>
  raw && typeof raw === 'object' ? text((raw as Record<string, unknown>).narrative, 1200) : null
