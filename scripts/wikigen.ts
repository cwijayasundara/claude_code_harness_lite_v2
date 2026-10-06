// The code wiki's generated blocks: Mermaid diagrams, link tables and history, spliced between markers so prose is never touched.
import path from 'node:path'
import { isPlanned, skillRef } from './core.ts'
import { matchesAny, type SensorConfig } from './model.ts'
import { cmp, dependents, type Graph } from './wikigraph.ts'

export const SURFACE = /^\s*(?:export|pub |def |class |func |public |interface |type |module\.exports)/
export const STRUCTURAL = ['architecture', 'files', 'entrypoints', 'deps', 'tests'] as const
export const BLOCKS = [...STRUCTURAL, 'why', 'recent'] as const
export const INDEX_BLOCKS = ['system', 'start', 'modules'] as const
export const PROSE = ['In plain words', 'Walk-through'] as const
export type BlockName = (typeof BLOCKS)[number]

const open = (name: string): string => `<!-- rig:gen:${name} -->`
const CLOSE = '<!-- /rig:gen -->'
const blockRe = (name: string): RegExp => new RegExp(`${open(name)}\\r?\\n([\\s\\S]*?)\\r?\\n?${CLOSE}`)
const marker = (name: string): string => `${open(name)}\n${CLOSE}`

export const blockBody = (page: string, name: string): string | null => blockRe(name).exec(page)?.[1]?.trim() ?? null

// Repo text that spells a marker (a commit subject, a comment, a string) must not end or open a block: `<!--` before rig:gen becomes `&lt;!--`.
const inert = (body: string): string => body.replace(/<!--(?=\s*\/?\s*rig:gen)/g, '&lt;!--')

// Replace one generated block; a block the page lacks goes before the first later block of `order`, else at the end.
export function spliceBlock(page: string, name: string, body: string, order: readonly string[] = BLOCKS): string {
  const next = `${open(name)}\n${inert(body).trimEnd()}\n${CLOSE}`
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

export { printable } from './model.ts'
export const label = (page: string): string => path.posix.basename(page, '.md')
const id = (s: string): string => `n_${s.replace(/[^A-Za-z0-9]+/g, '_')}`
const q = (s: string): string => `"${s.replace(/"/g, "'")}"`
// Readable ids can collide ("é.md" and "é!.md" both lose their letters); the first key in cmp order keeps the plain id, later ones get _2, _3, skipping any id another key's plain id owns.
export function uniqueIds(keys: string[], base: (k: string) => string): Map<string, string> {
  const sorted = [...new Set(keys)].sort(cmp)
  const taken = new Set(sorted.map(base))
  const owned = new Set<string>()
  const out = new Map<string, string>()
  for (const k of sorted) {
    let v = base(k)
    for (let n = 2; owned.has(v); n++) {
      v = `${base(k)}_${n}`
      while (taken.has(v)) v = `${base(k)}_${++n}`
    }
    owned.add(v)
    out.set(k, v)
  }
  return out
}
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
  const ids = uniqueIds(shown.map(e => e.to), id)
  const lines = [`  C[${q(label(page))}]`]
  const declared = new Set<string>()
  for (const e of shown) {
    if (!declared.has(e.to)) lines.push(`  ${ids.get(e.to)}[${q(label(e.to))}]`)
    declared.add(e.to)
    lines.push(e.dir === 'out' ? `  C -->|${e.n}| ${ids.get(e.to)}` : `  ${ids.get(e.to)} -->|${e.n}| C`)
  }
  if (all.length > max) lines.push(`  more[${q(`+${all.length - max} more`)}]`, '  C -.- more')
  return ['## Architecture', '', fence(lines), ...(note ? ['', note] : [])].join('\n')
}

// Every module and its edges; above `above` modules, aggregate by directory so the picture stays readable.
export function systemDiagram(g: Graph, pages: string[], groupOf: (page: string) => string, above = 30): string {
  const grouped = pages.length > above
  const key = (p: string): string => (grouped ? groupOf(p) : p)
  const nodeLabel = (k: string): string => (grouped ? k : label(k))
  const keys = [...new Set(pages.map(key))].sort()
  const ids = uniqueIds(keys, k => (grouped ? `g_${k.replace(/[^A-Za-z0-9]+/g, '_')}` : id(k)))
  const nodeId = (k: string): string => ids.get(k) ?? id(k)
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

export type ChangeRow = { slug: string; type: string; summary: string; created: string; plan: string[] }
export type CommitRow = { sha: string; date: string; subject: string }
export type Ctx = {
  pages: Record<string, { globs: string[] }>
  files: string[] // tracked files, docs/wiki excluded
  graph: Graph
  link: LinkBase
  config: SensorConfig
  read: (file: string) => string
  changes: ChangeRow[]
  commits: (files: string[], n: number) => CommitRow[]
}

const filesOf = (ctx: Ctx, page: string): string[] => ctx.files.filter(f => ctx.graph.moduleOf.get(f) === page)
const isTestFile = (ctx: Ctx, f: string): boolean => matchesAny(f, ctx.config.tests)
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\s+/g, ' ').trim()
const pageDir = (page: string): string => path.posix.join('docs/wiki', path.posix.dirname(page))
const linkTo = (ctx: Ctx, page: string, file: string, line?: number): string => fileLink(ctx.link, file, line, pageDir(page))
const lineCount = (text: string): number => (text ? text.replace(/\n$/, '').split('\n').length : 0)

// The first line of real descriptive text in a leading comment, as the file's one-line role.
const NOT_COMMENT = /^#\s*(?:!|include\b|define\b|pragma\b|if|else|endif|undef\b|error\b)/
const DIRECTIVE = /^(?:eslint|@ts-|prettier|istanbul|-\*-|@(?:param|returns?|type|typedef|license|fileoverview)\b|(?:copyright|license)\b)/i
function role(text: string): string {
  for (const line of text.split('\n').slice(0, 8)) {
    const t = line.trim()
    if (NOT_COMMENT.test(t)) continue
    const marker = /^(?:\/\/+|\/\*+|#+|--|;;|\*+(?!\/))/.exec(t)
    if (!marker) continue
    const body = t.slice(marker[0].length).replace(/\*+\/\s*$/, '').trim()
    if (!body || !/[\p{L}\p{N}]/u.test(body) || DIRECTIVE.test(body)) continue
    return body
  }
  return ''
}

const section = (title: string, empty: string, rows: string[]): string => [`## ${title}`, '', ...(rows.length ? rows : [empty])].join('\n')

export function renderFiles(ctx: Ctx, page: string): string {
  const src = filesOf(ctx, page).filter(f => !isTestFile(ctx, f))
  const rows = src.slice(0, 40).map(f => {
    const text = ctx.read(f)
    return `| [\`${cell(f)}\`](${linkTo(ctx, page, f)}) | ${cell(clip(role(text), 80))} | ${lineCount(text)} |`
  })
  const body = rows.length ? ['| File | Role | Lines |', '|---|---|---|', ...rows, ...(src.length > 40 ? [`| _+${src.length - 40} more_ | | |`] : [])] : []
  return section('Key files', '_No source files match the module globs._', body)
}

export function renderEntrypoints(ctx: Ctx, page: string): string {
  const rows: string[] = []
  for (const f of filesOf(ctx, page).filter(f => !isTestFile(ctx, f))) {
    ctx.read(f).split('\n').forEach((line, i) => {
      if (SURFACE.test(line)) rows.push(`| \`${cell(clip(line.trim(), 90))}\` | [${cell(f)}:${i + 1}](${linkTo(ctx, page, f, i + 1)}) |`)
    })
  }
  const body = rows.length ? ['| Symbol | Where |', '|---|---|', ...rows.slice(0, 60), ...(rows.length > 60 ? [`| _+${rows.length - 60} more_ | |`] : [])] : []
  return section('Entry points', '_No exported symbols found._', body)
}

export function renderDeps(ctx: Ctx, page: string): string {
  const rel = (to: string): string => path.posix.relative(path.posix.dirname(page), to)
  const item = ([to, n]: [string, number]): string => `- [${label(to)}](${rel(to)}) · ${n} import${n === 1 ? '' : 's'}`
  const ranked = (m: Map<string, number>): [string, number][] => [...m].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
  const out = ranked(ctx.graph.edges.get(page) ?? new Map())
  const inn = ranked(dependents(ctx.graph, page))
  const ext = ranked(ctx.graph.external.get(page) ?? new Map()).slice(0, 5)
  return [
    '## Depends on / used by', '',
    '**Depends on**', '', ...(out.length ? out.map(item) : ['_No other module._']), '',
    '**Used by**', '', ...(inn.length ? inn.map(item) : ['_No other module._']), '',
    '**External packages** (top 5)', '', ...(ext.length ? ext.map(([n, c]) => `- \`${n}\` · ${c}`) : ['_None._']),
  ].join('\n')
}

const TEST_NAME = [/\b(?:test|it|describe)\s*\(\s*['"`]([^'"`\n]+)['"`]/, /^\s*(?:async\s+)?def\s+(test_\w+)/]
export function renderTests(ctx: Ctx, page: string): string {
  const mine = new Set(filesOf(ctx, page))
  const tests = ctx.files.filter(f => isTestFile(ctx, f) && (mine.has(f) || (ctx.graph.imports.get(f) ?? []).some(t => mine.has(t))))
  const rows = tests.slice(0, 20).map(f => {
    const names: string[] = []
    for (const line of ctx.read(f).split('\n')) for (const re of TEST_NAME) { const n = re.exec(line)?.[1]; if (n && names.length < 8) names.push(n) }
    return `- [\`${cell(f)}\`](${linkTo(ctx, page, f)})${names.length ? `: ${names.map(n => cell(clip(n, 60))).join('; ')}` : ''}`
  })
  return section('Tests', '_No test file found for this module._', rows)
}

// Why the module looks the way it does: the recorded changes whose plan touches it, then commits that name no recorded change.
export function renderWhy(ctx: Ctx, page: string): string {
  const mine = filesOf(ctx, page)
  const rel = (slug: string): string => path.posix.relative(pageDir(page), `.sdlc/changes/${slug}/intent.md`)
  const changes = ctx.changes
    .filter(c => c.plan.length && mine.some(f => isPlanned(f, c.plan)))
    .sort((a, b) => cmp(b.created, a.created) || cmp(a.slug, b.slug))
    .slice(0, 8)
  const rows = changes.map(c => `- [${c.slug}](${rel(c.slug)}) · ${c.type} · ${cell(clip(c.summary, 120))}`)
  const room = 8 - rows.length
  const commits = room > 0 ? ctx.commits(mine, 20).filter(c => !changes.some(ch => c.subject.includes(ch.slug))).slice(0, room) : []
  rows.push(...commits.map(c => `- \`${c.sha}\` · commit · ${cell(clip(c.subject, 120))}`))
  return section('Why it looks like this', '_No recorded change touches this module yet._', rows)
}

export function renderRecent(ctx: Ctx, page: string): string {
  return section('Recent changes', '_No commits yet._', ctx.commits(filesOf(ctx, page), 10).map(c => `- \`${c.sha}\` ${c.date} · ${cell(clip(c.subject, 100))}`))
}

export function renderBlock(ctx: Ctx, page: string, name: BlockName): string {
  switch (name) {
    case 'architecture': return architecture(ctx.graph, page)
    case 'files': return renderFiles(ctx, page)
    case 'entrypoints': return renderEntrypoints(ctx, page)
    case 'deps': return renderDeps(ctx, page)
    case 'tests': return renderTests(ctx, page)
    case 'why': return renderWhy(ctx, page)
    case 'recent': return renderRecent(ctx, page)
  }
}

export const renderSystem = (g: Graph, pages: string[], groupOf: (page: string) => string): string => ['## System map', '', systemDiagram(g, pages, groupOf)].join('\n')
export const renderStart = (order: string[], summaryOf: (page: string) => string): string =>
  ['## Start here', '', ...order.map((p, i) => `${i + 1}. [${label(p)}](${p})${summaryOf(p) ? `: ${summaryOf(p)}` : ''}`)].join('\n')
export const renderModules = (pages: string[], summaryOf: (page: string) => string): string =>
  ['## Modules', '', '| Module | What it does | Page |', '|---|---|---|', ...pages.map(p => `| ${label(p)} | ${cell(summaryOf(p)) || '—'} | [${p}](${p}) |`)].join('\n')
