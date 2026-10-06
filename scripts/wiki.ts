// The code wiki's zero-token staleness check: each page records a hash of its module's public surface.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, read, exists, sha, out, fail, git, toPosix, sanctionWrites, listChanges, frontmatter, planFiles, CHANGES, planPath, optString, skillRef, type Args } from './core.ts'
import { matchesAny, isSource, isTest, type Finding } from './model.ts'
import { loadConfig } from './check.ts'
import { buildGraph, cmp } from './wikigraph.ts'
import { BLOCKS, STRUCTURAL, INDEX_BLOCKS, SURFACE, spliceBlock, blockBody, pageSkeleton, indexSkeleton, pageSummary, label, linkBase, startOrder, renderBlock, renderSystem, renderStart, renderModules, type Ctx, type ChangeRow, type CommitRow } from './wikigen.ts'

export const WIKI_DIR = 'docs/wiki'
const MANIFEST = path.join(ROOT, WIKI_DIR, 'manifest.json')
const CITATION = /[\w./-]+\.\w+:\d+/
type Page = { globs: string[]; surface?: string }
type Manifest = { pages: Record<string, Page>; skip?: string[]; notes?: string[]; order?: string[] }
const MANIFEST_KEYS = ['pages', 'skip', 'notes', 'order']
const MAX_NOTE = 10_000
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

function readManifest(): Manifest | null {
  if (!exists(MANIFEST)) return null
  try {
    const m = JSON.parse(read(MANIFEST)) as Manifest
    return m && typeof m.pages === 'object' ? m : null
  } catch {
    return null
  }
}

const tracked = (): string[] => (git(['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean)
const filesFor = (globs: string[], all: string[]): string[] => all.filter(f => matchesAny(f, globs)).sort(cmp)

// Only regular files are read: a tracked symlink (even one pointing inside the repo) would pull outside or duplicated text into the wiki, so it is skipped.
const isRegularFile = (abs: string): boolean => fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile() ?? false
const readRegular = (abs: string): string => (isRegularFile(abs) ? read(abs) : '')

function surfaceOf(files: string[]): string {
  const lines = files.filter(f => isRegularFile(path.join(ROOT, f))).flatMap(f => [`# ${f}`, ...read(path.join(ROOT, f)).split('\n').filter(l => SURFACE.test(l)).map(l => l.trim())])
  return sha(lines.join('\n'))
}

const SAFE_KEY = /^(?!index\.md$)[^\\\x00-\x1f\x7f:*?"<>|]+\.md$/
const safeKey = (k: string): boolean => SAFE_KEY.test(k) && !k.startsWith('/') && k.split('/').every(s => s !== '' && s !== '.' && s !== '..')
// Every path under docs/wiki (pages and index.md alike) is made here: no symlink may sit anywhere between the repo root and the target.
export function safeWikiPath(rel: string): string | null {
  const root = path.resolve(ROOT)
  const base = path.resolve(root, WIKI_DIR)
  const target = path.resolve(base, rel)
  if (!target.startsWith(base + path.sep)) return null
  try {
    let anc = path.dirname(target)
    while (!fs.existsSync(anc) && anc !== root) anc = path.dirname(anc)
    if (fs.realpathSync(anc) !== path.join(fs.realpathSync(root), path.relative(root, anc))) return null
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return null
  } catch {
    return null
  }
  return target
}
const safePagePath = (page: string): string | null => (safeKey(page) ? safeWikiPath(page) : null)

// Create parent directories only after the check, re-check just before, and refuse a symlink as the last component.
function writeSafe(rel: string, text: string): void {
  const file = `${WIKI_DIR}/${rel}`
  const target = safeWikiPath(rel)
  if (!target) fail(`${file}: not a safe path under ${WIKI_DIR}/`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (safeWikiPath(rel) !== target) fail(`${file}: not a safe path under ${WIKI_DIR}/`)
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o644)
  try {
    fs.writeSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
}

export function manifestErrors(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['manifest.json must be a JSON object']
  const m = raw as Record<string, unknown>
  const errors = Object.keys(m).filter(k => !MANIFEST_KEYS.includes(k)).map(k => `unknown key "${k}"`)
  const pages = m.pages
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) errors.push('pages must be an object of page → { globs }')
  else {
    const lowered = new Map<string, string>()
    for (const [name, p] of Object.entries(pages as Record<string, unknown>)) {
      if (!safeKey(name)) { errors.push(`page "${name}": not a safe relative .md path`); continue }
      const clash = lowered.get(name.toLowerCase())
      if (name.toLowerCase() === 'index.md') errors.push(`page "${name}": collides case-insensitively with the reserved index.md`)
      else if (clash !== undefined) errors.push(`page "${name}": collides case-insensitively with "${clash}"`)
      else lowered.set(name.toLowerCase(), name)
      const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
      if (!isStrings(o.globs)) errors.push(`page ${name}: globs must be a list of strings`)
      for (const k of Object.keys(o)) if (k !== 'globs' && k !== 'surface') errors.push(`page ${name}: unknown key "${k}"`)
    }
  }
  for (const key of ['skip', 'notes', 'order'] as const) if (key in m && !isStrings(m[key])) errors.push(`${key} must be a list of strings`)
  if (isStrings(m.notes)) m.notes.forEach((n, i) => { if (n.length > MAX_NOTE) errors.push(`notes[${i}] is longer than ${MAX_NOTE} characters`) })
  if (isStrings(m.order) && pages && typeof pages === 'object') for (const p of m.order) if (!(p in (pages as object))) errors.push(`order: ${p} is not a page`)
  return errors
}
const readRaw = (): unknown => { try { return JSON.parse(read(MANIFEST)) } catch { return null } }

const INDEX = 'index.md'
const pagePath = (page: string): string => safePagePath(page) ?? fail(`page "${page}": not a safe relative .md path`)
const commitRows = (files: string[], n: number): CommitRow[] => {
  if (!files.length) return []
  const raw = git(['--literal-pathspecs', 'log', `-n${n}`, '--format=%h%x09%cs%x09%s', '--', ...files.slice(0, 200)]) ?? ''
  return raw.split('\n').filter(Boolean).map(l => { const [sha = '', date = '', ...s] = l.split('\t'); return { sha, date, subject: s.join('\t') } })
}
function changeRows(): ChangeRow[] {
  const rows: ChangeRow[] = []
  for (const slug of listChanges()) {
    const intent = path.join(CHANGES, slug, 'intent.md')
    if (!isRegularFile(intent)) continue
    const plan = (() => { try { return isRegularFile(planPath(slug)) ? planFiles(slug) : [] } catch { return [] } })()
    const { data, body } = frontmatter(read(intent))
    const summary = /^##\s+Problem\s*\n+([^\n]+)/m.exec(body)?.[1] ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? slug
    rows.push({ slug, type: data.type ?? 'chore', summary: summary.trim(), created: data.created ?? '', plan })
  }
  return rows
}
function makeCtx(m: Manifest): Ctx {
  // Symlinks, directories and missing files drop out entirely (see isRegularFile).
  const files = tracked().filter(f => !f.startsWith(`${WIKI_DIR}/`) && isRegularFile(path.join(ROOT, f)))
  const cache = new Map<string, string>()
  const readFile = (f: string): string => { let t = cache.get(f); if (t === undefined) cache.set(f, (t = readRegular(path.join(ROOT, f)))); return t }
  const branch = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '') ?? 'main'
  return {
    pages: m.pages, files, graph: buildGraph(m.pages, files, readFile), link: linkBase(git(['remote', 'get-url', 'origin']), branch),
    config: loadConfig().config, read: readFile, changes: changeRows(), commits: commitRows,
  }
}

export type Planned = { file: string; before: string; text: string; names: readonly string[] }
export function planBuild(m: Manifest): Planned[] {
  const ctx = makeCtx(m)
  const pages = Object.keys(m.pages).sort(cmp)
  const planned: Planned[] = pages.map(page => {
    const before = read(pagePath(page))
    let text = before || pageSkeleton(label(page))
    for (const name of BLOCKS) text = spliceBlock(text, name, renderBlock(ctx, page, name))
    return { file: `${WIKI_DIR}/${page}`, before, text, names: STRUCTURAL }
  })
  const groupOf = (p: string): string => (m.pages[p]?.globs[0] ?? p).replace(/^\.\//, '').split('/')[0] ?? p
  const summaryOf = (p: string): string => pageSummary(read(pagePath(p)))
  const before = read(safeWikiPath(INDEX) ?? fail(`${WIKI_DIR}/${INDEX}: not a safe path under ${WIKI_DIR}/`))
  let text = before || indexSkeleton(path.basename(ROOT))
  text = spliceBlock(text, 'system', renderSystem(ctx.graph, pages, groupOf), INDEX_BLOCKS)
  text = spliceBlock(text, 'start', renderStart(startOrder(ctx.graph, pages, m.order ?? []), summaryOf), INDEX_BLOCKS)
  text = spliceBlock(text, 'modules', renderModules(pages, summaryOf), INDEX_BLOCKS)
  return [...planned, { file: `${WIKI_DIR}/${INDEX}`, before, text, names: INDEX_BLOCKS }]
}
export const driftOf = (p: Planned): string[] => p.names.filter(n => blockBody(p.before, n) !== blockBody(p.text, n))

function cmdBuild(args: Args): void {
  if (!exists(MANIFEST)) return out(`no code wiki here: ${skillRef('wiki')} builds it`)
  if (!safeWikiPath(INDEX) || !safeWikiPath('manifest.json')) fail(`${WIKI_DIR}: not a safe path (a symlink between the repo root and the wiki)`)
  const errors = manifestErrors(readRaw())
  if (errors.length) fail(`docs/wiki/manifest.json: ${errors.join('; ')}`)
  const m = readManifest()
  if (!m) return out(`no code wiki here: ${skillRef('wiki')} builds it`)
  for (const page of Object.keys(m.pages)) if (!safePagePath(page)) fail(`docs/wiki/manifest.json: page "${page}": not a safe relative .md path`)
  const plan = planBuild(m)
  if (args.opt.check) {
    const rows = plan.flatMap(p => driftOf(p).map(n => `generated: ${p.file} (${n})`))
    out(rows.length ? rows.join('\n') : 'wiki generated blocks up to date')
    if (rows.length) process.exitCode = 1
    return
  }
  const changed = plan.filter(p => p.text !== p.before)
  for (const p of changed) writeSafe(p.file.slice(WIKI_DIR.length + 1), p.text)
  out(changed.length ? `wrote ${changed.length} file(s):\n${changed.map(p => `  ${p.file}`).join('\n')}` : 'wiki up to date')
}

export function wikiStatus(): { stale: string[]; missing: string[]; uncovered: string[] } | null {
  const m = readManifest()
  if (!m) return null
  const all = tracked()
  const { config } = loadConfig()
  const stale: string[] = []
  const missing: string[] = []
  for (const [page, p] of Object.entries(m.pages)) {
    const files = filesFor(p.globs ?? [], all)
    if (!files.length) missing.push(page)
    else if (p.surface !== surfaceOf(files)) stale.push(page)
  }
  const globs = Object.values(m.pages).flatMap(p => p.globs ?? [])
  const dirs = new Set(all.filter(f => f.includes('/') && isSource(f, config) && !isTest(f, config) && !f.startsWith('.')).map(f => f.split('/')[0] ?? ''))
  const skip = new Set(m.skip ?? [])
  const uncovered = [...dirs].filter(d => !skip.has(d) && !all.some(f => f.startsWith(`${d}/`) && matchesAny(f, globs))).sort()
  return { stale: stale.sort(), missing: missing.sort(), uncovered }
}

export function wikiFindings(): Finding[] {
  const s = wikiStatus()
  if (!s) return []
  const fix = 'run /rig:wiki update (it rewrites only these pages)'
  const warn = (file: string, message: string): Finding => ({ sensor: 'wiki-stale', severity: 'warn', file, message, fix })
  return [
    ...s.stale.map(p => warn(`${WIKI_DIR}/${p}`, 'the module\'s public surface changed since this page was written')),
    ...s.missing.map(p => warn(`${WIKI_DIR}/${p}`, 'its globs match no files')),
    ...s.uncovered.map(d => warn(d, 'no wiki page covers this directory')),
  ]
}

export function cmdWiki(args: Args): void {
  const [sub, ...pages] = args.pos
  if (sub === 'status') {
    const s = wikiStatus()
    if (args.opt.json) return out(JSON.stringify(s ?? { stale: [], missing: [], uncovered: [], none: true }))
    if (!s) return out('no code wiki here: /rig:wiki builds it')
    const rows = [...s.stale.map(p => `stale: ${p}`), ...s.missing.map(p => `missing files: ${p}`), ...s.uncovered.map(d => `uncovered: ${d}/`)]
    return out(rows.length ? rows.join('\n') : 'wiki up to date')
  }
  if (sub === 'build') return cmdBuild(args)
  if (sub === 'stamp') {
    const m = readManifest()
    if (!m) return out('no docs/wiki/manifest.json to stamp')
    const unknown = pages.filter(n => !(n in m.pages))
    if (unknown.length) {
      process.stderr.write(`unknown page(s): ${unknown.join(', ')}\n`)
      process.exitCode = 1
      return
    }
    const all = tracked()
    // Outside a repository there are no files to hash, so every page would be stamped with the empty-input hash.
    if (!all.length) {
      process.stderr.write('no files to stamp against: this directory is not a git repository (or is empty); run git init first\n')
      process.exitCode = 1
      return
    }
    let stamped = 0
    const uncited: string[] = []
    for (const [page, p] of Object.entries(m.pages)) {
      if (pages.length && !pages.includes(page)) continue
      // A page that cites no `path:line` is not a map an engineer can follow; it stays unstamped (stale) until fixed.
      if (!CITATION.test(read(path.join(ROOT, WIKI_DIR, page)))) {
        uncited.push(page)
        continue
      }
      p.surface = surfaceOf(filesFor(p.globs ?? [], all))
      stamped++
    }
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n')
    sanctionWrites([toPosix(path.relative(ROOT, MANIFEST))])
    if (uncited.length) {
      process.stderr.write(`uncited page(s): ${uncited.join(', ')}: cite each claim as path:line, then stamp again\n`)
      process.exitCode = 1
    }
    return out(`stamped ${stamped} page(s)`)
  }
  out('usage: wiki status [--json] | build [--check] | stamp [page...]')
}
