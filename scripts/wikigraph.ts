// The module graph the wiki draws: import statements read through a per-language table, resolved to files, folded into modules.
import path from 'node:path'
import { matchesAny } from './model.ts'

export type ImportRow = { exts: string[]; resolve: 'relative' | 'dotted'; patterns: RegExp[] }
// Language knowledge lives in this table, not in code. Add a row to compute edges for another language.
export const IMPORT_TABLE: ImportRow[] = [
  { exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'], resolve: 'relative', patterns: [
    /\bfrom\s+['"]([^'"\n]+)['"]/g,
    /\bimport\s+['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ] },
  { exts: ['.py'], resolve: 'dotted', patterns: [
    /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import\b/gm,
    /^[ \t]*import[ \t]+([\w.]+)/gm,
  ] },
]
// Code in a language with no row above: its modules get no computed edges and the page says so.
export const CODE_EXTS = ['.go', '.java', '.kt', '.rb', '.rs', '.cs', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.scala', '.ex', '.exs', '.lua', '.sh']

export type RawImport = { spec: string; line: number }
export type Resolved = { kind: 'file'; file: string } | { kind: 'external'; name: string } | { kind: 'unresolved' }
export type Graph = {
  moduleOf: Map<string, string>
  imports: Map<string, string[]> // file → internal files it imports, sorted
  edges: Map<string, Map<string, number>> // module → module → import count
  external: Map<string, Map<string, number>> // module → package → import count
  unresolved: Map<string, string[]> // module → internal-looking specifiers that matched no file
  uncomputed: Map<string, string[]> // module → extensions with no table row
}

const rowFor = (file: string): ImportRow | undefined => IMPORT_TABLE.find(r => r.exts.includes(path.posix.extname(file)))

// Block comments keep their newlines (so line numbers survive); whole-line comments are dropped.
function stripComments(text: string, ext: string): string {
  if (ext === '.py') return text.replace(/^[ \t]*#.*$/gm, '')
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, '')
}

export function importsOf(file: string, text: string): RawImport[] {
  const row = rowFor(file)
  if (!row) return []
  const clean = stripComments(text, path.posix.extname(file))
  const found: RawImport[] = []
  for (const re of row.patterns) {
    for (const m of clean.matchAll(re)) {
      const spec = m[1] ?? ''
      if (spec) found.push({ spec, line: clean.slice(0, m.index ?? 0).split('\n').length })
    }
  }
  return found.sort((a, b) => a.line - b.line || cmp(a.spec, b.spec))
}

// Plain code-unit order: localeCompare depends on the machine's locale and would make generated output differ between machines.
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']
const JS_SWAP: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

function externalName(spec: string): Resolved {
  if (spec.startsWith('node:')) return { kind: 'external', name: '' } // a builtin is not a dependency worth listing
  const parts = spec.split('/')
  return { kind: 'external', name: spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '') }
}

function resolveRelative(from: string, spec: string, files: Set<string>): Resolved {
  if (!spec.startsWith('.')) return externalName(spec)
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  const ext = path.posix.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  const candidates = [base, ...JS_EXTS.map(e => base + e), ...(JS_SWAP[ext] ?? []).map(e => stem + e), ...JS_EXTS.map(e => `${base}/index${e}`)]
  const hit = candidates.find(c => files.has(c))
  return hit ? { kind: 'file', file: hit } : { kind: 'unresolved' }
}

const pyCandidates = (dir: string, parts: string[]): string[] => {
  if (!parts.length) return [path.posix.join(dir, '__init__.py')]
  const base = path.posix.join(dir, ...parts)
  return [`${base}.py`, `${base}/__init__.py`]
}

function resolveDotted(from: string, spec: string, files: Set<string>): Resolved {
  const dots = /^\.*/.exec(spec)?.[0].length ?? 0
  const rest = spec.slice(dots).split('.').filter(Boolean)
  if (dots > 0) {
    let dir = path.posix.dirname(from)
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir)
    const hit = pyCandidates(dir, rest).find(c => files.has(c))
    return hit ? { kind: 'file', file: hit } : { kind: 'unresolved' }
  }
  for (const root of ['', 'src']) {
    for (let n = rest.length; n >= 1; n--) {
      const hit = pyCandidates(root, rest.slice(0, n)).find(c => files.has(c))
      if (hit) return { kind: 'file', file: hit }
    }
  }
  return { kind: 'external', name: rest[0] ?? '' }
}

export function resolveImport(from: string, spec: string, files: Set<string>): Resolved {
  const row = rowFor(from)
  if (!row) return { kind: 'unresolved' }
  return row.resolve === 'relative' ? resolveRelative(from, spec, files) : resolveDotted(from, spec, files)
}

const bump = (m: Map<string, Map<string, number>>, a: string, b: string): void => {
  const row = m.get(a) ?? new Map<string, number>()
  row.set(b, (row.get(b) ?? 0) + 1)
  m.set(a, row)
}
const addUnique = (m: Map<string, string[]>, a: string, v: string): void => {
  const list = m.get(a) ?? []
  if (!list.includes(v)) list.push(v)
  m.set(a, list)
}

// A module is a manifest page; a file belongs to the first page (by name) whose globs match it.
export function buildGraph(pages: Record<string, { globs: string[] }>, files: string[], readFile: (f: string) => string): Graph {
  const set = new Set(files)
  const sorted = [...files].sort()
  const moduleOf = new Map<string, string>()
  for (const page of Object.keys(pages).sort()) {
    for (const f of sorted) if (!moduleOf.has(f) && matchesAny(f, pages[page]?.globs ?? [])) moduleOf.set(f, page)
  }
  const g: Graph = { moduleOf, imports: new Map(), edges: new Map(), external: new Map(), unresolved: new Map(), uncomputed: new Map() }
  for (const f of sorted) {
    const mod = moduleOf.get(f)
    const ext = path.posix.extname(f)
    if (!rowFor(f)) {
      if (mod && CODE_EXTS.includes(ext)) addUnique(g.uncomputed, mod, ext)
      continue
    }
    for (const imp of importsOf(f, readFile(f))) {
      const r = resolveImport(f, imp.spec, set)
      if (r.kind === 'file') {
        addUnique(g.imports, f, r.file)
        const to = moduleOf.get(r.file)
        if (mod && to && to !== mod) bump(g.edges, mod, to)
      } else if (r.kind === 'external') {
        if (mod && r.name) bump(g.external, mod, r.name)
      } else if (mod) addUnique(g.unresolved, mod, imp.spec)
    }
  }
  for (const m of [g.imports, g.unresolved, g.uncomputed]) for (const list of m.values()) list.sort()
  return g
}

export const dependents = (g: Graph, mod: string): Map<string, number> => {
  const found = new Map<string, number>()
  for (const [from, row] of g.edges) {
    const n = row.get(mod)
    if (n) found.set(from, n)
  }
  return found
}
