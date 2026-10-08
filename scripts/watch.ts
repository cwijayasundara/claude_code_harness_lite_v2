// `sdlc.ts watch`: the deterministic band detector (playbook p.49-50). For each band in .sdlc/sensors.json it runs the query, appends the
// point to .sdlc/watch/<id>.jsonl and prints a tier from Western Electric rules: 0 nothing, 1 log, 2 diagnose, 3 act. No model.
// A failed query records a miss and is tier 0: fail closed on action, open on observation. Dismissals tune the band: every breach
// intent for it a person closed (.sdlc/intent/breach-<id>-<date>.md, status: closed) widens each threshold by the band's step, in σ,
// up to 2σ in all.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SDLC, ROOT, MIN_SAMPLE, exists, readJsonl, now, out, fail, type Args } from './core.ts'
import { loadConfig } from './check.ts'
import { inboxEntries } from './inbox.ts'

export const WATCH = path.join(SDLC, 'watch')
type Row = { at: string; value?: number; miss?: true; tier?: number; rule?: string }
export type Verdict = { id: string; tier: 0 | 1 | 2 | 3; value: number | null; mean: number | null; sd: number | null; rule: string; breach: string | null; tools: string; routes: string[] }
const SPAN = 8 // the longest rule's run: the baseline excludes it, so a drift cannot hide inside its own mean
const MAX_WIDEN = 2 // σ: dismissals tune a band but can never silence it

// The query's number: plain, or with `count`, the share of a JSON list's items holding that value. Anything else is no point.
export function pointOf(stdout: string, count?: string): number | null {
  const text = stdout.trim()
  if (count === undefined) return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text) ? Number(text) : null
  try {
    const items: unknown = JSON.parse(text)
    if (!Array.isArray(items) || !items.length) return null
    return items.filter(i => typeof i === 'object' && i !== null && Object.values(i).includes(count)).length / items.length
  } catch {
    return null
  }
}

// The tier for the newest point of `series` (oldest first). The baseline is up to `window` points before the last SPAN.
// `minSd` floors σ in the metric's units. A constant baseline with no floor has no scale: any change is at most tier 2 (diagnose, never act).
export function evaluate(series: number[], window: number, widen = 0, minSd = 0): { tier: 0 | 1 | 2 | 3; mean: number | null; sd: number | null; rule: string } {
  const base = series.slice(0, -SPAN).slice(-window)
  if (base.length < MIN_SAMPLE) return { tier: 0, mean: null, sd: null, rule: `learning: ${base.length} of ${MIN_SAMPLE} baseline points` }
  const mean = base.reduce((a, b) => a + b, 0) / base.length
  const spread = Math.max(Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length), minSd)
  if (spread === 0) return series.slice(-SPAN).some(v => v !== mean) ? { tier: 2, mean, sd: 0, rule: 'constant baseline: set minSd to tune this band' } : { tier: 0, mean, sd: 0, rule: 'within band' }
  const sd = spread
  const z = series.slice(-SPAN).map(v => (v - mean) / sd)
  const beyond = (k: number, n: number, of: number): boolean => z.length >= of && [1, -1].some(s => z.slice(-of).filter(x => x * s > k + widen).length >= n)
  const at = (tier: 0 | 1 | 2 | 3, rule: string) => ({ tier, mean, sd, rule })
  if (beyond(3, 1, 1)) return at(3, 'one point beyond 3σ')
  if (beyond(2, 2, 3)) return at(2, 'two of three beyond 2σ')
  if (beyond(1, 4, 5)) return at(1, 'four of five beyond 1σ')
  if (beyond(0, SPAN, SPAN)) return at(1, 'eight in a row on one side')
  return at(0, 'within band')
}

export const dismissals = (id: string): number => inboxEntries().filter(e => e.status === 'closed' && new RegExp(`^breach-${id}-\\d{8}\\.md$`).test(e.file)).length

function append(file: string, row: Row): void {
  if (exists(file) && fs.lstatSync(file).isSymbolicLink()) fail(`${path.relative(ROOT, file)} is a symlink; not writing through it`)
  fs.appendFileSync(file, JSON.stringify(row) + '\n')
}

export function cmdWatch(args: Args): void {
  const { config, errors } = loadConfig()
  if (errors.length) fail(`.sdlc/sensors.json: ${errors.join('; ')}`)
  if (!config.bands.length) return out(args.opt.json ? '[]' : 'no bands in .sdlc/sensors.json: declare one to watch a metric')
  fs.mkdirSync(WATCH, { recursive: true })
  const day = now().slice(0, 10).replaceAll('-', '')
  const verdicts = config.bands.map((b): Verdict => {
    const file = path.join(WATCH, `${b.id}.jsonl`)
    const r = spawnSync('sh', ['-c', b.query], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    const value = r.status === 0 ? pointOf(r.stdout ?? '', b.count) : null
    const base = { id: b.id, tools: b.tools, routes: b.routes }
    if (value === null) {
      append(file, { at: now(), miss: true })
      return { ...base, tier: 0, value: null, mean: null, sd: null, rule: 'query failed: no point recorded', breach: null }
    }
    const series = [...readJsonl<Row>(file).flatMap(p => (typeof p.value === 'number' ? [p.value] : [])), value]
    const e = evaluate(series, b.window, Math.min(MAX_WIDEN, b.step * dismissals(b.id)), b.minSd)
    append(file, { at: now(), value, tier: e.tier, rule: e.rule })
    return { ...base, value, ...e, breach: e.tier >= 2 ? `breach-${b.id}-${day}` : null }
  })
  if (args.opt.json) return out(JSON.stringify(verdicts))
  out(verdicts.map(v => `${v.id}: tier ${v.tier} (${v.value ?? 'no value'}; ${v.rule})${v.breach ? ` → ${v.breach}` : ''}`).join('\n'))
}

// Bands whose query failed on the last two runs.
export function watchWarnings(): string[] {
  if (!exists(WATCH)) return []
  return fs.readdirSync(WATCH).filter(f => f.endsWith('.jsonl')).flatMap(f => {
    const last = readJsonl<Row>(path.join(WATCH, f)).slice(-2)
    return last.length === 2 && last.every(r => r.miss) ? [`watch: ${f.replace(/\.jsonl$/, '')} query failed on the last two runs`] : []
  })
}
