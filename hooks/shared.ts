// Pure helpers shared by the sdlc mod's files. The mod loader follows `$` only into functions declared in
// the same file, so nothing here takes `$`: each file keeps thin local wrappers that pass `$.plugin.root`.
import type { FlowStep, Status, Story, TurnPoint } from '../types'

// The core script is TypeScript run by Node's built-in type stripping (Node >= 22.18).
export function sdlcArgv(root: string, ...args: string[]): string[] {
  const script = root.endsWith('/.sdlc/mod') ? `${root}/../bin/sdlc.ts` : `${root}/scripts/sdlc.ts`
  return ['node', '--disable-warning=ExperimentalWarning', script, ...args]
}

export function parseStatus(stdout: string): Status | null {
  try {
    return JSON.parse(stdout) as Status
  } catch {
    return null
  }
}

// Copies of core.ts's slug rule and the graph's node names: the driver puts both into a prompt, so it checks them first.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/
export const NODES: ReadonlySet<string> = new Set(['build', 'diagnose', 'test', 'sensors', 'pr', 'pr-review', 'intent', 'spec', 'plan', 'design', 'notes'])

// The change STATE.md names, read as core.ts's frontmatter does (the last `change:` row wins): undefined with no such row (the
// script then guesses), else the slug or null.
export function stateChange(text: string): string | null | undefined {
  const row = [...(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').matchAll(/^change:\s*(.*)$/gm)].at(-1)
  const slug = row?.[1]?.replace(/^["']|["']$/g, '').trim() ?? ''
  return row ? (SLUG_RE.test(slug) ? slug : null) : undefined
}

// Set at session start: true when this copy is the global plugin's and the project vendors its own (.sdlc/mod).
export const mod = { aside: false }

// Pure display helpers for the band and the mission-control pane: no `$`, so both files can use them.
const SPARKS = '▁▂▃▄▅▆▇█'

export const money = (v = 0): string => `$${v.toFixed(v < 100 ? 2 : 0)}`

export const kilo = (n = 0): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export const spark = (values: number[]): string => {
  const top = Math.max(0, ...values)
  return values.map(v => (top <= 0 ? SPARKS[0] : SPARKS[Math.min(7, Math.floor((v / top) * 7.999))])).join('')
}

export const gauge = (frac: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round((Number.isFinite(frac) ? frac : 0) * width)))
  return `▕${'█'.repeat(filled)}${'░'.repeat(width - filled)}▏`
}

export const heat = (frac: number): 'green' | 'yellow' | 'red' => (frac >= 0.9 ? 'red' : frac >= 0.6 ? 'yellow' : 'green')

// Dollars per main turn (the ledger delta register.ts already computes, so a /clear reset never shows as a negative).
export const spendPerTurn = (turns: TurnPoint[]): number[] => turns.filter(t => t.main).map(t => Math.max(0, t.usd))

export function tokenMix(turns: TurnPoint[]): { out: number; fresh: number; cw: number; cr: number; hit: number } {
  const sum = (k: 'in' | 'out' | 'cr' | 'cw'): number => turns.reduce((a, t) => a + t[k], 0)
  const [fresh, out, cr, cw] = [sum('in'), sum('out'), sum('cr'), sum('cw')]
  const input = fresh + cr + cw
  return { out, fresh, cw, cr, hit: input ? cr / input : 0 }
}

// A stacked bar of segments, each at least one cell when non-zero, summing exactly to `width`.
export function stack(parts: number[], width: number): number[] {
  const total = parts.reduce((a, b) => a + b, 0)
  if (total <= 0) return parts.map(() => 0)
  const cells = parts.map(p => (p > 0 ? Math.max(1, Math.round((p / total) * width)) : 0))
  const biggest = cells.indexOf(Math.max(...cells))
  cells[biggest] = Math.max(1, (cells[biggest] ?? 0) + width - cells.reduce((a, b) => a + b, 0))
  return cells
}

export type Subway = { cells: { text: string; state: FlowStep['state'] }[]; marker: string; loop: string; loopHot: boolean }

const SEP = ' ─ '
const GLYPH = { done: '●', current: '◉', gate: '◈', todo: '○' } as const
const LOOP_NODES = new Set(['test', 'sensors', 'diagnose'])

// The SDLC drawn as a line of stations. Wider than `columns`: only the current station keeps its name.
// The fix loop is an arc under build..sensors labelled with its round; `marker` points at the current station.
export function subway(flow: FlowStep[], story: Story | null | undefined, columns: number): Subway {
  const full = flow.map(f => `${GLYPH[f.state]} ${f.label}`)
  const width = full.reduce((a, c) => a + c.length, 0) + SEP.length * Math.max(0, flow.length - 1)
  const texts = flow.map((f, i) => (width <= columns || f.state === 'current' || f.state === 'gate' ? full[i] ?? '' : GLYPH[f.state]))
  const starts: number[] = []
  let at = 0
  for (const t of texts) { starts.push(at); at += t.length + SEP.length }
  const here = flow.findIndex(f => f.state === 'current' || f.state === 'gate')
  const marker = here < 0 ? '' : ' '.repeat(starts[here] ?? 0) + (flow[here]?.state === 'gate' ? '▲ waiting for you' : '▲ you are here')
  const from = flow.findIndex(f => f.label === 'build' || f.label === 'diagnose')
  const to = flow.reduce((a, f, i) => (LOOP_NODES.has(f.label) ? i : a), -1)
  let loop = ''
  if (story && story.cap > 0 && from >= 0 && to > from) {
    const span = (starts[to] ?? 0) + (texts[to]?.length ?? 0) - (starts[from] ?? 0)
    const label = ` ⟲ ${story.round}/${story.cap} `
    const dashes = Math.max(0, span - 2 - label.length)
    loop = ' '.repeat(starts[from] ?? 0) + '╰' + '─'.repeat(Math.floor(dashes / 2)) + label + '─'.repeat(Math.ceil(dashes / 2)) + '╯'
  }
  return { cells: flow.map((f, i) => ({ text: texts[i] ?? '', state: f.state })), marker, loop, loopHot: !!story && story.cap > 0 && story.round >= story.cap }
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null | undefined

export const KEEP_TURNS = 48

export const turnPoint = (usage: Usage, isAgent: boolean, usd: number): TurnPoint =>
  ({ main: !isAgent, in: usage?.input_tokens ?? 0, out: usage?.output_tokens ?? 0, cr: usage?.cache_read_input_tokens ?? 0, cw: usage?.cache_creation_input_tokens ?? 0, usd })
