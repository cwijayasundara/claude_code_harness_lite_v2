import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type TS from 'typescript'
import { type Index, type FileInfo, type ModuleInfo, type Sym, sha } from './core.ts'
import type { Config } from './config.ts'
import { listFiles } from './files.ts'
import { moduleOf } from './modules.ts'

type Ts = typeof TS

function loadTs(root: string): Ts | null {
  for (const base of [path.join(root, 'package.json'), import.meta.filename]) {
    try { return createRequire(base)('typescript') as Ts } catch { /* try next */ }
  }
  return null
}

const langOf = (f: string): FileInfo['lang'] =>
  /\.tsx?$/.test(f) ? 'ts' : /\.py$/.test(f) ? 'py' : /\.go$/.test(f) ? 'go' : /\.java$/.test(f) ? 'java' : 'js'

function regexImports(lang: FileInfo['lang'], text: string): string[] {
  const out: string[] = []
  const grab = (re: RegExp) => { for (const m of text.matchAll(re)) out.push(m[1] ?? m[2]) }
  if (lang === 'ts' || lang === 'js') grab(/(?:import|export)[^'"\n;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)
  else if (lang === 'py') grab(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)
  else if (lang === 'java') grab(/^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?;/gm)
  else grab(/^\s*(?:import\s+)?"([^"]+)"\s*$/gm)
  return out.filter(Boolean)
}

function extractTs(ts: Ts, file: string, text: string): { symbols: Sym[]; imports: string[]; ok: boolean } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const ok = ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length === 0
  const symbols: Sym[] = [], imports: string[] = []
  const docOf = (n: TS.Node): string => {
    const r = ts.getLeadingCommentRanges(text, n.getFullStart())?.at(-1)
    if (!r) return ''
    return text.slice(r.pos, r.end).replace(/^\/\*+|\*+\/$/g, '').split('\n').map(l => l.replace(/^\s*(\*|\/\/)\s?/, '').trim()).filter(Boolean)[0] ?? ''
  }
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) imports.push(st.moduleSpecifier.text)
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const e of st.exportClause.elements) symbols.push({ name: e.name.text, kind: 'other', signature: `export { ${e.name.text} }`, doc: '' })
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    const doc = docOf(st)
    if (ts.isFunctionDeclaration(st) && st.name) {
      const end = st.body ? st.body.getStart() : st.getEnd()
      symbols.push({ name: st.name.text, kind: 'function', signature: text.slice(st.getStart(), end).trim().replace(/;$/, ''), doc })
    } else if (ts.isClassDeclaration(st) && st.name) symbols.push({ name: st.name.text, kind: 'class', signature: `export class ${st.name.text}`, doc })
    else if (ts.isInterfaceDeclaration(st)) symbols.push({ name: st.name.text, kind: 'interface', signature: `export interface ${st.name.text}`, doc })
    else if (ts.isTypeAliasDeclaration(st)) symbols.push({ name: st.name.text, kind: 'type', signature: `export type ${st.name.text}`, doc })
    else if (ts.isEnumDeclaration(st)) symbols.push({ name: st.name.text, kind: 'enum', signature: `export enum ${st.name.text}`, doc })
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) symbols.push({ name: d.name.text, kind: 'const', signature: `export const ${d.name.text}`, doc })
  }
  return { symbols, imports, ok }
}

function resolve(spec: string, from: string, lang: FileInfo['lang'], set: Set<string>, all: string[]): string | null {
  if ((lang === 'ts' || lang === 'js') && spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
    const stem = base.replace(/\.(m|c)?jsx?$/, '')
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`, `${stem}.ts`, `${stem}.tsx`])
      if (set.has(c)) return c
    return null
  }
  if (lang === 'py') {
    const p = spec.replace(/\./g, '/')
    return all.find(f => f === `${p}.py` || f.endsWith(`/${p}.py`) || f === `${p}/__init__.py` || f.endsWith(`/${p}/__init__.py`)) ?? null
  }
  if (lang === 'java') {
    const p = spec.replace(/\./g, '/')
    return all.find(f => f === `${p}.java` || f.endsWith(`/${p}.java`)) ?? null
  }
  if (lang === 'go') return all.find(f => path.posix.dirname(f).endsWith(spec) && f.endsWith('.go')) ?? null
  return null
}

export function buildIndex(root: string, cfg: Config, opts: { noTypescript?: boolean } = {}): Index {
  const ts = opts.noTypescript ? null : loadTs(root)
  const paths = listFiles(root, cfg)
  const set = new Set(paths)
  const files: Record<string, FileInfo> = {}
  for (const p of paths) {
    const text = fs.readFileSync(path.join(root, p), 'utf8')
    const lang = langOf(p)
    let symbols: Sym[] = [], imports: string[], structureOnly = true
    if (ts && (lang === 'ts' || lang === 'js')) {
      const r = extractTs(ts, p, text)
      imports = r.ok ? r.imports : regexImports(lang, text)
      if (r.ok) { symbols = r.symbols; structureOnly = false }
    } else imports = regexImports(lang, text)
    files[p] = { path: p, module: moduleOf(p, cfg), hash: sha(text), lang, structureOnly, symbols, imports }
  }
  const modules: Record<string, ModuleInfo> = {}
  for (const f of Object.values(files)) {
    const m = (modules[f.module] ??= { name: f.module, files: [], hash: '', sigHash: '', structureOnly: true, dependsOn: [], usedBy: [] })
    m.files.push(f.path)
    if (!f.structureOnly) m.structureOnly = false
  }
  const deps: Record<string, Set<string>> = {}
  for (const f of Object.values(files)) for (const spec of f.imports) {
    const target = resolve(spec, f.path, f.lang, set, paths)
    const tm = target && files[target].module
    if (tm && tm !== f.module) (deps[f.module] ??= new Set()).add(tm)
  }
  for (const m of Object.values(modules)) {
    m.files.sort()
    m.hash = sha(m.files.map(p => `${p}:${files[p].hash}`).join('\n'))
    m.sigHash = sha(m.files.flatMap(p => files[p].symbols.map(s => `${p}:${s.name}:${s.signature}`)).sort().join('\n'))
    m.dependsOn = [...(deps[m.name] ?? [])].sort()
  }
  for (const m of Object.values(modules)) for (const d of m.dependsOn) modules[d].usedBy.push(m.name)
  for (const m of Object.values(modules)) m.usedBy.sort()
  return { generated: new Date().toISOString(), modules, files }
}
