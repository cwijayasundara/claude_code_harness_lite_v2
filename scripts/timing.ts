// Work, span and idle from intervals (commands and subagent lanes) and point events. Everything is measured between the first and
// last recorded moment, never to "now", so a laptop left open adds nothing.
export type Interval = [number, number]
export type Timing = { workMs: number; spanMs: number; idleMs: number; lastAt: number | null }

function merge(items: Interval[]): Interval[] {
  const sorted = items.map((i): Interval => [i[0], i[1]]).sort((a, b) => a[0] - b[0])
  const out: Interval[] = []
  for (const [s, e] of sorted) {
    const last = out.at(-1)
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

export function timing(intervals: Interval[], stamps: number[], idleGapMs: number): Timing {
  const all: Interval[] = [...intervals, ...stamps.map((t): Interval => [t, t])]
  if (!all.length) return { workMs: 0, spanMs: 0, idleMs: 0, lastAt: null }
  const workMs = merge(intervals).reduce((n, [s, e]) => n + (e - s), 0)
  const merged = merge(all)
  let idleMs = 0
  for (let i = 1; i < merged.length; i++) {
    const gap = (merged[i]?.[0] ?? 0) - (merged[i - 1]?.[1] ?? 0)
    if (gap > idleGapMs) idleMs += gap
  }
  const first = merged[0]?.[0] ?? 0
  const lastAt = merged.at(-1)?.[1] ?? 0
  return { workMs, spanMs: lastAt - first, idleMs, lastAt }
}
