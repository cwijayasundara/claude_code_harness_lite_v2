// Story points: a tier default, or an explicit value the person set. The explicit value lives in ratchet.json (written
// only by sdlc.ts); intent.md shows it for people but is model-writable, so it is never read back.
import { isShipped, checkSlug, out, fail, MIN_SAMPLE, type Args } from './core.ts'
import { loadChange } from './graph.ts'
import { loadConfig } from './check.ts'
import { readRatchet, writeRatchet, rawSpendUsd } from './ratchet.ts'
import { CHANGES } from './core.ts'
import fs from 'node:fs'
import path from 'node:path'

export type Points = { points: number; source: 'tier' | 'set' }

export function pointsOf(slug: string): Points {
  const set = readRatchet(slug).points
  if (typeof set === 'number' && Number.isInteger(set) && set > 0) return { points: set, source: 'set' }
  return { points: loadConfig().config.points[loadChange(slug).tier], source: 'tier' }
}

export function setPoints(slug: string, n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error('points must be a positive integer')
  const r = readRatchet(slug)
  r.points = n
  writeRatchet(slug, r)
  const intent = path.join(CHANGES, slug, 'intent.md')
  if (fs.existsSync(intent)) {
    const text = fs.readFileSync(intent, 'utf8')
    fs.writeFileSync(intent, /^points: .*$/m.test(text) ? text.replace(/^points: .*$/m, `points: ${n}`) : text.replace(/^---\n([\s\S]*?)\n---/, `---\n$1\npoints: ${n}\n---`))
  }
}

export const parsePoints = (v: string | true | undefined): number => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isInteger(n) || n <= 0) fail('points must be a positive integer')
  return n
}

const WEEK_MS = 7 * 86_400_000

// Velocity and cost per point over the window, from the changes that shipped in it; unmeasured below MIN_SAMPLE.
export function pointsMetrics(slugs: string[], days: number): { n: number; shipped_points: number; velocity_per_week: number | null; cost_per_point: number | null } {
  const since = Date.now() - days * 86_400_000
  const shipped = slugs.filter(s => {
    if (!isShipped(s)) return false
    try { return Date.parse((JSON.parse(fs.readFileSync(path.join(CHANGES, s, 'ship.json'), 'utf8')) as { at?: string }).at ?? '') >= since } catch { return false }
  })
  const total = shipped.reduce((n, s) => n + pointsOf(s).points, 0)
  if (shipped.length < MIN_SAMPLE) return { n: shipped.length, shipped_points: total, velocity_per_week: null, cost_per_point: null }
  const usd = shipped.reduce((n, s) => n + rawSpendUsd(s), 0)
  return {
    n: shipped.length, shipped_points: total,
    velocity_per_week: Number((total / (days * 86_400_000 / WEEK_MS)).toFixed(2)),
    cost_per_point: usd > 0 ? Number((usd / total).toFixed(2)) : null,
  }
}

export function cmdPoints(args: Args): void {
  const slug = checkSlug(args.pos[0] ?? '')
  if (args.pos[1] !== undefined) {
    try { setPoints(slug, Number(args.pos[1])) } catch { fail('points must be a positive integer') }
  }
  const p = pointsOf(slug)
  out(args.opt.json ? JSON.stringify(p) : `${slug}: ${p.points} points (${p.source})`)
}
