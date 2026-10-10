import fs from 'node:fs'
import path from 'node:path'
import { type Index, type State, WIKI_DIR, readJson, safeName } from './core.ts'
import type { Config } from './config.ts'
import { composePage, getBlock, keepBlocks } from './compose.ts'
import { parseProse, parseNarrative } from './prose.ts'
import { validatePage } from './validate.ts'
import { loadChanges, pick } from './why.ts'
import { archHash, ensureIgnore, loadState, saveState } from './state.ts'
import { buildIndexMd } from './indexmd.ts'

export type ApplyResult = { written: string[]; kept: string[]; pending: string[]; problems: Record<string, string[]> }
export const pagePath = (module: string): string => `modules/${safeName(module)}.md`

export function applyWiki(root: string, _cfg: Config, idx: Index, opts: { generated?: string } = {}): ApplyResult {
  ensureIgnore(root)
  const wiki = path.join(root, WIKI_DIR)
  const stage = path.join(wiki, '.cache/stage')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'modules'), { recursive: true })
  const generated = opts.generated ?? new Date().toISOString().slice(0, 10)
  const state = loadState(root)
  const next: State = { version: 1, modules: {}, architectureHash: archHash(idx) }
  const res: ApplyResult = { written: [], kept: [], pending: [], problems: {} }
  const changes = loadChanges(root)
  const known = new Set(Object.keys(idx.modules).map(pagePath))
  // links are validated relative to the wiki dir: 'modules/x.md', or '../changes/<slug>/intent.md' (= .rig/changes/...)
  const exists = (rel: string): boolean => known.has(rel) || fs.existsSync(path.join(wiki, rel))

  for (const mod of Object.values(idx.modules)) {
    const file = pagePath(mod.name)
    const oldFile = path.join(wiki, file)
    const old = fs.existsSync(oldFile) ? fs.readFileSync(oldFile, 'utf8') : null
    const rawProse = readJson<unknown>(path.join(wiki, '.cache/prose', `${mod.name}.json`), null)
    const prose = parseProse(rawProse)
    if (rawProse !== null && prose === null) res.problems[mod.name] = ['prose rejected: wrong shape, too long, or contains markup markers']
    const prev = state.modules[mod.name]
    const fresh = mod.structureOnly || prose !== null
    const stale = !fresh && (!prev || prev.hash !== mod.hash || prev.status === 'stale')
    const text = composePage({ mod, idx, prose, old, stale, why: pick(changes, mod.files), generated })
    if (text === null) { res.pending.push(mod.name); continue }
    const problems = validatePage(text, old, 'modules', exists)
    if (problems.length) {
      res.problems[mod.name] = [...(res.problems[mod.name] ?? []), ...problems]
      if (prev) next.modules[mod.name] = prev
      if (old) res.kept.push(mod.name); else res.pending.push(mod.name)
      continue
    }
    fs.writeFileSync(path.join(stage, file), text)
    if (fresh) {
      next.modules[mod.name] = { hash: mod.hash, sigHash: mod.sigHash, status: 'fresh', generated, fileHashes: Object.fromEntries(mod.files.map(f => [f, idx.files[f].hash])) }
      res.written.push(mod.name)
    } else {
      next.modules[mod.name] = { hash: prev?.hash ?? mod.hash, sigHash: prev?.sigHash ?? mod.sigHash, status: stale ? 'stale' : 'fresh', generated: prev?.generated ?? generated, fileHashes: prev?.fileHashes }
      res.kept.push(mod.name)
      if (stale) res.pending.push(mod.name)
    }
  }
  return swapIn(root, wiki, stage, idx, res, next)
}

function swapIn(root: string, wiki: string, stage: string, idx: Index, res: ApplyResult, next: State): ApplyResult {
  fs.mkdirSync(path.join(wiki, 'modules'), { recursive: true })
  for (const f of fs.readdirSync(path.join(stage, 'modules'))) fs.renameSync(path.join(stage, 'modules', f), path.join(wiki, 'modules', f))
  writeArchitecture(wiki, idx)
  saveState(root, next)
  const alive = new Set(Object.keys(idx.modules).map(m => `${safeName(m)}.md`))
  for (const f of fs.readdirSync(path.join(wiki, 'modules'))) {
    if (alive.has(f)) continue
    const file = path.join(wiki, 'modules', f)
    try {
      // human notes in a removed module's page are moved aside, never silently dropped
      if (fs.statSync(file).isFile() && keepBlocks(fs.readFileSync(file, 'utf8')).length) {
        fs.mkdirSync(path.join(wiki, 'orphaned'), { recursive: true })
        fs.renameSync(file, path.join(wiki, 'orphaned', f))
        continue
      }
    } catch { /* fall through to removal */ }
    fs.rmSync(file, { recursive: true, force: true })
  }
  const purposeOf = (m: string): string => {
    try { return getBlock(fs.readFileSync(path.join(wiki, pagePath(m)), 'utf8'), 'purpose') ?? '' } catch { return '' }
  }
  fs.writeFileSync(path.join(wiki, 'INDEX.md'), buildIndexMd(idx, next, purposeOf))
  fs.rmSync(path.join(wiki, '.cache/prose'), { recursive: true, force: true })   // prose is single-use: never reused for a later change
  fs.rmSync(stage, { recursive: true, force: true })
  return res
}

function writeArchitecture(wiki: string, idx: Index): void {
  const file = path.join(wiki, 'architecture.md')
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const fromWriter = parseNarrative(readJson<unknown>(path.join(wiki, '.cache/prose/_architecture.json'), null))
  const narrative = fromWriter ?? getBlock(old, 'narrative') ?? '_Narrative pending._'
  const mods = Object.values(idx.modules)
  const edges = mods.flatMap(m => m.dependsOn.map(d => `  ${m.name} --> ${d}`))
  const lone = mods.filter(m => !m.dependsOn.length && !m.usedBy.length).map(m => `  ${m.name}`)
  const links = mods.map(m => m.name).sort().map(m => `- [${m}](modules/${safeName(m)}.md)`).join('\n')
  fs.writeFileSync(file, `# Architecture\n\n\`\`\`mermaid\n${['graph LR', ...edges, ...lone].join('\n')}\n\`\`\`\n\n<!-- narrative -->\n${narrative}\n<!-- /narrative -->\n\n## Modules\n${links}\n`)
}
