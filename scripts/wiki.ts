import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { WIKI_DIR, writeJson } from './core.ts'
import { loadConfig } from './config.ts'
import { buildIndex } from './indexer.ts'
import { planRefresh } from './planner.ts'
import { applyWiki } from './apply.ts'
import { ensureIgnore, loadState } from './state.ts'
import { findIn } from './find.ts'
import { markStaleMany, promptContext } from './mark.ts'
import { checkRig, MIN_RIG } from './rigcontract.ts'

const args = process.argv.slice(2)
const ri = args.indexOf('--root')
const root = path.resolve(ri >= 0 ? args.splice(ri, 2)[1] : process.cwd())
const [cmd, ...rest] = args

function readStdin(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return {} }
}

function repoRoot(dir: string): string {
  const t = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', timeout: 5_000 })
  return t.status === 0 && t.stdout.trim() ? t.stdout.trim() : dir
}

function hook(event: string): void {
  const input = readStdin()
  const r = repoRoot(typeof input.cwd === 'string' ? input.cwd : root)
  if (event === 'post-edit') markStaleMany(r, [String(input.tool_input?.file_path ?? '')])
  else if (event === 'stop') {
    const d = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: r, encoding: 'utf8', timeout: 10_000 })
    if (d.status === 0) markStaleMany(r, d.stdout.split('\n').filter(Boolean).map(f => path.join(r, f)))
  } else if (event === 'session-start') {
    if (fs.existsSync(path.join(r, WIKI_DIR, 'INDEX.md'))) console.log('A code wiki exists: read .sdlc/wiki/INDEX.md first to locate files and features, then verify in code.')
  } else if (event === 'prompt-submit') {
    const ctx = promptContext(r, String(input.session_id ?? 'default'))
    if (ctx) console.log(ctx)
  }
}

try {
  const cfg = loadConfig(root)
  if (cmd === 'hook') hook(rest[0])
  else if (cmd === 'index') { ensureIgnore(root); const idx = buildIndex(root, cfg); writeJson(path.join(root, WIKI_DIR, '.cache/index.json'), idx); console.log(`${Object.keys(idx.modules).length} modules`) }
  else if (cmd === 'plan') {
    const plan = planRefresh(buildIndex(root, cfg), loadState(root), cfg)
    console.log(rest.includes('--json') ? JSON.stringify(plan, null, 2) : `prose: ${plan.prose.map(t => t.module).join(', ') || '-'}\npending: ${plan.pending.map(t => t.module).join(', ') || '-'}\narchitecture: ${plan.architecture}`)
  } else if (cmd === 'apply') {
    const r = applyWiki(root, cfg, buildIndex(root, cfg))
    console.log(`written: ${r.written.length}, kept: ${r.kept.length}, pending: ${r.pending.length}`)
    for (const [m, ps] of Object.entries(r.problems)) console.log(`problem ${m}: ${ps.join('; ')}`)
  } else if (cmd === 'find') {
    const idx = buildIndex(root, cfg)
    for (const h of findIn(idx, loadState(root), rest.join(' '))) console.log(`${h.kind} ${h.name} ${h.file} ${h.page}${h.stale ? ' (stale)' : ''}`)
  } else if (cmd === 'status') {
    const s = loadState(root)
    const vals = Object.values(s.modules)
    console.log(`fresh: ${vals.filter(m => m.status === 'fresh').length}\nstale: ${vals.filter(m => m.status === 'stale').length}`)
    const rig = checkRig(root)
    console.log(`rig: ${rig.present ? rig.version ?? 'unknown' : 'none'} (${rig.supported ? 'supported' : `unsupported: needs >= ${MIN_RIG}`})`)
  } else console.log('usage: wiki.ts <index|plan|apply|find|status|hook> [--root dir]')
} catch (e) {
  if (cmd !== 'hook') { console.error(String(e)); process.exitCode = 1 }
}
