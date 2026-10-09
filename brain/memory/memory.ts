import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from '../shared/git.ts'
import { loadMemConfig } from './config.ts'
import { type CaptureEvent, capture, pruneSignals, readSignals } from './capture.ts'
import { BATCH_ID, loadDreamState, maybeStartDream } from './trigger.ts'
import { dreamNow, log, runDream } from './dream.ts'
import { applyOps } from './apply.ts'
import { allEntries, loadStore, searchEntries } from './store.ts'
import { sessionContext } from './session.ts'
import { seedMemory } from './seed.ts'

const args = process.argv.slice(2)
const ri = args.indexOf('--root')
const given = ri >= 0 ? args.splice(ri, 2)[1] : undefined
const root = given ? path.resolve(given) : repoRoot(process.cwd())
const [cmd, ...rest] = args
const CAPTURE: Record<string, CaptureEvent> = { 'post-bash': 'post-bash', 'tool-fail': 'tool-fail', 'post-edit': 'post-edit', prompt: 'prompt' }

function readStdin(): Record<string, any> {
  try { const v = JSON.parse(fs.readFileSync(0, 'utf8')); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

function hook(event: string): void {
  if (process.env.RIG_BRAIN_DREAMING === '1') return
  const input = readStdin()
  const r = repoRoot(typeof input.cwd === 'string' ? input.cwd : root)
  const cfg = loadMemConfig(r)
  if (!cfg.enabled) return
  if (event === 'session-start') {
    pruneSignals(r, new Date())
    const c = sessionContext(r)
    if (c) console.log(c)
  } else if (event === 'stop') {
    const msg = maybeStartDream(r, cfg, import.meta.filename)
    if (msg.startsWith('dream started')) log(r, msg)
  } else if (CAPTURE[event]) capture(r, CAPTURE[event], input)
}

try {
  if (cmd === 'hook') hook(rest[0])
  else if (cmd === 'dream') {
    const cfg = loadMemConfig(root)
    if (rest[0] === '--now') console.log(dreamNow(root, cfg))
    else if (BATCH_ID.test(rest[0] ?? '')) console.log(runDream(root, rest[0], cfg))
    else console.log('usage: memory.ts dream <batch-id>|--now')
  } else if (cmd === 'find') {
    const hits = searchEntries(loadStore(root), rest)
    console.log(hits.length ? hits.map(h => `${h.entry.id} ${h.file} ${h.entry.text}`).join('\n') : 'no matches')
  } else if (cmd === 'forget') {
    if (!rest[0]) { console.log('usage: memory.ts forget <id>'); process.exit(0) }
    const res = applyOps(root, loadMemConfig(root), [{ op: 'remove', id: rest[0] }], new Date().toISOString().slice(0, 10))
    console.log(res.removed ? `removed ${rest[0]}` : `not found: ${rest[0]}`)
  } else if (cmd === 'seed') {
    const file = rest.find(a => !a.startsWith('--'))
    const ops = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
    const r = seedMemory(root, ops, new Date().toISOString().slice(0, 10), { placeholders: rest.includes('--placeholders') })
    console.log(`seeded: ${r.added} added, ${r.rejected.length} rejected${r.rejected.length ? ` (${r.rejected.map(x => x.reason).join('; ')})` : ''}`)
  } else if (cmd === 'status') {
    const st = loadDreamState(root)
    console.log(`enabled: ${loadMemConfig(root).enabled}\nentries: ${allEntries(loadStore(root)).length}\npending signals: ${readSignals(root).filter(s => !s.dreamed).length}\nlast dream: ${st.last || 'never'}`)
  } else console.log('usage: memory.ts <hook|dream|find|forget|seed|status> [--root dir]')
} catch (e) {
  if (cmd !== 'hook') { console.error(String(e)); process.exitCode = 1 }
  else try { log(root, `hook ${rest[0]} failed: ${(e as Error).message ?? e}`) } catch { /* logging never throws */ }
}
