// The code wiki's zero-token staleness check: each page records a hash of its module's public surface.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, read, exists, sha, out, git, toPosix, sanctionWrites, type Args } from './core.ts'
import { matchesAny, isSource, isTest, type Finding } from './model.ts'
import { loadConfig } from './check.ts'

export const WIKI_DIR = 'docs/wiki'
const MANIFEST = path.join(ROOT, WIKI_DIR, 'manifest.json')
const SURFACE = /^\s*(?:export|pub |def |class |func |public |interface |type |module\.exports)/
type Page = { globs: string[]; surface?: string }
type Manifest = { pages: Record<string, Page> }

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
const filesFor = (globs: string[], all: string[]): string[] => all.filter(f => matchesAny(f, globs)).sort()

function surfaceOf(files: string[]): string {
  const lines = files.flatMap(f => [`# ${f}`, ...read(path.join(ROOT, f)).split('\n').filter(l => SURFACE.test(l)).map(l => l.trim())])
  return sha(lines.join('\n'))
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
  const uncovered = [...dirs].filter(d => !all.some(f => f.startsWith(`${d}/`) && matchesAny(f, globs))).sort()
  return { stale: stale.sort(), missing: missing.sort(), uncovered }
}

export function wikiFindings(): Finding[] {
  const s = wikiStatus()
  if (!s) return []
  const fix = 'run /sdlc:wiki update (it rewrites only these pages)'
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
    if (!s) return out('no code wiki here: /sdlc:wiki builds it')
    const rows = [...s.stale.map(p => `stale: ${p}`), ...s.missing.map(p => `missing files: ${p}`), ...s.uncovered.map(d => `uncovered: ${d}/`)]
    return out(rows.length ? rows.join('\n') : 'wiki up to date')
  }
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
    let stamped = 0
    for (const [page, p] of Object.entries(m.pages)) {
      if (pages.length && !pages.includes(page)) continue
      p.surface = surfaceOf(filesFor(p.globs ?? [], all))
      stamped++
    }
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n')
    sanctionWrites([toPosix(path.relative(ROOT, MANIFEST))])
    return out(`stamped ${stamped} page(s)`)
  }
  out('usage: wiki status [--json] | wiki stamp [page...]')
}
