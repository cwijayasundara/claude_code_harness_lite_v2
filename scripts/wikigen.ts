// The code wiki's generated blocks: Mermaid diagrams, link tables and history, spliced between markers so prose is never touched.
import path from 'node:path'
import { skillRef } from './core.ts'
import { cmp, dependents, type Graph } from './wikigraph.ts'

export const SURFACE = /^\s*(?:export|pub |def |class |func |public |interface |type |module\.exports)/
export const STRUCTURAL = ['architecture', 'files', 'entrypoints', 'deps', 'tests'] as const
export const BLOCKS = [...STRUCTURAL, 'why', 'recent'] as const
export const INDEX_BLOCKS = ['system', 'start', 'modules'] as const
export const PROSE = ['In plain words', 'Walk-through'] as const
export type BlockName = (typeof BLOCKS)[number]

const open = (name: string): string => `<!-- rig:gen:${name} -->`
const CLOSE = '<!-- /rig:gen -->'
const blockRe = (name: string): RegExp => new RegExp(`${open(name)}\\n([\\s\\S]*?)\\n?${CLOSE}`)
const marker = (name: string): string => `${open(name)}\n${CLOSE}`

export const blockBody = (page: string, name: string): string | null => blockRe(name).exec(page)?.[1]?.trim() ?? null

// Replace one generated block; a block the page lacks goes before the first later block of `order`, else at the end.
export function spliceBlock(page: string, name: string, body: string, order: readonly string[] = BLOCKS): string {
  const next = `${open(name)}\n${body.trimEnd()}\n${CLOSE}`
  if (blockRe(name).test(page)) return page.replace(blockRe(name), () => next)
  const idx = order.indexOf(name)
  const later = idx < 0 ? [] : order.slice(idx + 1).map(n => page.indexOf(open(n))).filter(i => i >= 0)
  if (later.length) {
    const at = Math.min(...later)
    return `${page.slice(0, at)}${next}\n\n${page.slice(at)}`
  }
  return `${page.trimEnd()}\n\n${next}\n`
}

export const pending = (): string => `_pending: run ${skillRef('wiki')}_`

export function pageSkeleton(title: string): string {
  return [
    `# ${title}`, '', '> _summary pending_', '', '## In plain words', '', pending(), '', marker('architecture'), '',
    '## Walk-through', '', pending(), '', ...['files', 'entrypoints', 'deps', 'tests', 'why', 'recent'].flatMap(n => [marker(n), '']),
  ].join('\n')
}

export function indexSkeleton(title: string): string {
  return [`# ${title}`, '', '## What this is', '', pending(), '', marker('system'), '', marker('start'), '', marker('modules'), '', '## I want to…', '', pending(), ''].join('\n')
}

// The prose headings a page must carry: missing, empty and pending ones are problems.
export function proseProblems(text: string): string[] {
  return PROSE.filter(h => {
    const m = new RegExp(`^##\\s+${h}\\s*\\n([\\s\\S]*?)(?=^##\\s|<!-- rig:gen|$(?![\\s\\S]))`, 'm').exec(text)
    const body = m?.[1]?.trim() ?? ''
    return !body || /^_pending/.test(body)
  })
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export function pageSummary(text: string): string {
  for (const line of text.split('\n')) {
    const m = /^>\s*(.+)$/.exec(line.trim())
    if (m?.[1] && m[1] !== '_summary pending_') return clip(m[1], 100)
  }
  return ''
}

export const label = (page: string): string => path.posix.basename(page, '.md')
const id = (s: string): string => `n_${s.replace(/[^A-Za-z0-9]+/g, '_')}`
const q = (s: string): string => `"${s.replace(/"/g, "'")}"`
const fence = (lines: string[]): string => ['```mermaid', 'flowchart LR', ...lines, '```'].join('\n')

type Edge = { to: string; n: number; dir: 'in' | 'out' }
export function architecture(g: Graph, page: string, max = 12): string {
  const all: Edge[] = [
    ...[...(g.edges.get(page) ?? [])].map(([to, n]): Edge => ({ to, n, dir: 'out' })),
    ...[...dependents(g, page)].map(([to, n]): Edge => ({ to, n, dir: 'in' })),
  ].sort((a, b) => b.n - a.n || cmp(a.to, b.to) || cmp(a.dir, b.dir))
  const uncomputed = g.uncomputed.get(page) ?? []
  const note = uncomputed.length ? `_Edges not computed for ${uncomputed.join(', ')}: add a row to \`IMPORT_TABLE\` in \`scripts/wikigraph.ts\`, or draw them under \`<!-- rig:drawn -->\`._` : ''
  if (!all.length) return ['## Architecture', '', uncomputed.length ? note : '_No imports to or from other modules._'].join('\n')
  const shown = all.slice(0, max)
  const lines = [`  C[${q(label(page))}]`]
  const declared = new Set<string>()
  for (const e of shown) {
    if (!declared.has(e.to)) lines.push(`  ${id(e.to)}[${q(label(e.to))}]`)
    declared.add(e.to)
    lines.push(e.dir === 'out' ? `  C -->|${e.n}| ${id(e.to)}` : `  ${id(e.to)} -->|${e.n}| C`)
  }
  if (all.length > max) lines.push(`  more[${q(`+${all.length - max} more`)}]`, '  C -.- more')
  return ['## Architecture', '', fence(lines), ...(note ? ['', note] : [])].join('\n')
}

// Every module and its edges; above `above` modules, aggregate by directory so the picture stays readable.
export function systemDiagram(g: Graph, pages: string[], groupOf: (page: string) => string, above = 30): string {
  const grouped = pages.length > above
  const key = (p: string): string => (grouped ? groupOf(p) : p)
  const nodeId = (k: string): string => (grouped ? `g_${k.replace(/[^A-Za-z0-9]+/g, '_')}` : id(k))
  const nodeLabel = (k: string): string => (grouped ? k : label(k))
  const keys = [...new Set(pages.map(key))].sort()
  const counts = new Map<string, number>()
  for (const [from, row] of g.edges) {
    if (!pages.includes(from)) continue
    for (const [to, n] of row) {
      if (!pages.includes(to) || key(from) === key(to)) continue
      counts.set(`${key(from)}\t${key(to)}`, (counts.get(`${key(from)}\t${key(to)}`) ?? 0) + n)
    }
  }
  const lines = [
    ...keys.map(k => `  ${nodeId(k)}[${q(nodeLabel(k))}]`),
    ...[...counts].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => {
      const [a = '', b = ''] = k.split('\t')
      return `  ${nodeId(a)} -->|${n}| ${nodeId(b)}`
    }),
  ]
  return fence(lines)
}

export type LinkBase = { kind: 'github'; base: string } | { kind: 'relative' }
export function linkBase(remote: string | null, branch: string): LinkBase {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote ?? '')
  return m ? { kind: 'github', base: `https://github.com/${m[1]}/${m[2]}/blob/${branch}` } : { kind: 'relative' }
}
const enc = (file: string): string => file.split('/').map(encodeURIComponent).join('/')
export function fileLink(lb: LinkBase, file: string, line?: number, fromDir = 'docs/wiki/modules'): string {
  const frag = line ? `#L${line}` : ''
  return lb.kind === 'github' ? `${lb.base}/${enc(file)}${frag}` : `${enc(path.posix.relative(fromDir, file))}${frag}`
}

// Manifest order first, then the most depended-on modules, then by name.
export function startOrder(g: Graph, pages: string[], order: string[]): string[] {
  const degree = (p: string): number => [...dependents(g, p).values()].reduce((a, b) => a + b, 0)
  const first = order.filter(p => pages.includes(p))
  const rest = pages.filter(p => !first.includes(p)).sort((a, b) => degree(b) - degree(a) || cmp(a, b))
  return [...first, ...rest]
}
