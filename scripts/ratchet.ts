// Loop state for the build, test, sensors and pr-review nodes: rounds, finding hashes, caps, stalls and budgets.
// Written only by sdlc.ts (ratchet.json and events.jsonl are evidence), so a model cannot reset its own counter.
import fs from 'node:fs'
import path from 'node:path'
import { CHANGES, EVIDENCE_NAME_RE, SLUG_RE, checkSlug, USAGE, now, read, sha, readJsonl, out, fail, type Args, type UsageRow } from './core.ts'
import { loadConfig } from './check.ts'
import type { RatchetNode } from './model.ts'

export type NodeState = { rounds: number; hashes: string[][]; status: 'open' | 'done' }
export type Ratchet = { version?: number; nodes: Partial<Record<RatchetNode, NodeState>>; slices: Record<string, NodeState>; baseline: { tests?: number; base?: string; quality?: Record<string, { cmd: string; count: string; n: number }> }; blocked?: { node: string; reason: string; at: string; kind?: BlockKind }; credits?: Partial<Record<RatchetNode, number>> }
export type BlockKind = 'cap' | 'stall' | 'budget' | 'level' | 'gate' | 'other'
export type Event = { at: string; node: string; verdict: string; round?: number; reason?: string; kind?: string; tool?: string; target?: string; usd?: number }
export type ReviewFinding = { severity: string; category: string; text: string }
export type RoundVerdict = { verdict: 'continue' | 'done' | 'blocked'; reason: string }

const file = (slug: string, name: string): string => {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid change name ${slug}`)
  return path.join(CHANGES, slug, name)
}
const empty = (): Ratchet => ({ nodes: {}, slices: {}, baseline: {} })
const fresh = (): NodeState => ({ rounds: 0, hashes: [], status: 'open' })
const BLOCKING = new Set(['critical', 'high'])

export function readRatchet(slug: string): Ratchet {
  try { return { ...empty(), ...(JSON.parse(read(file(slug, 'ratchet.json'))) as Partial<Ratchet>) } } catch { return empty() }
}
export const writeRatchet = (slug: string, r: Ratchet): void => fs.writeFileSync(file(slug, 'ratchet.json'), JSON.stringify(r, null, 2) + '\n')
export const appendEvent = (slug: string, e: Omit<Event, 'at'>): void => fs.appendFileSync(file(slug, 'events.jsonl'), JSON.stringify({ at: now(), ...e }) + '\n')
export const readEvents = (slug: string): Event[] => readJsonl<Event>(file(slug, 'events.jsonl'))

export function parseReviewFindings(text: string): ReviewFinding[] {
  return [...text.matchAll(/^\s*-\s*\[severity:\s*(\w+)\]\s*\[category:\s*([\w-]+)\]\s*(.+)$/gim)]
    .map(m => ({ severity: (m[1] ?? '').toLowerCase(), category: (m[2] ?? '').toLowerCase(), text: (m[3] ?? '').replace(/\(confidence \d+\)\s*$/, '').trim() }))
}

const slicesIn = (slug: string): string[] => {
  const ids = [...read(file(slug, 'plan.md')).matchAll(/^###\s+Task\s+(\d+)\b/gm)].map(m => m[1] ?? '')
  return ids.length ? ids : ['1']
}

// The first block stays: a later one of another kind is only logged, so clearing it can never drop the earlier cause.
function setBlock(r: Ratchet, node: string, reason: string, kind: BlockKind): boolean {
  // gate and level blocks are re-derived by their node, so a severe kind (cap, stall, budget, other) replaces them; never the reverse.
  const held = r.blocked?.kind ?? 'other'
  const soft = (k: BlockKind): boolean => k === 'gate' || k === 'level'
  if (r.blocked && held !== kind && !(soft(held) && !soft(kind))) return false
  r.blocked = { node, reason, at: now(), kind }
  return true
}

export function block(slug: string, node: string, reason: string, kind: BlockKind = 'other'): void {
  const r = readRatchet(slug)
  const set = setBlock(r, node, reason, kind)
  if (set) writeRatchet(slug, r)
  appendEvent(slug, { node, verdict: 'blocked', reason: set ? reason : `${reason} (also blocked; ${r.blocked?.kind ?? 'other'} block kept)` })
}

export function unblock(slug: string, reason?: string, kind?: BlockKind): void {
  const r = readRatchet(slug)
  if (!r.blocked || (kind && (r.blocked.kind ?? 'other') !== kind)) return
  delete r.blocked
  writeRatchet(slug, r)
  appendEvent(slug, { node: 'any', verdict: 'unblocked', ...(reason ? { reason } : {}) })
}

// One loop round. Only critical/high findings keep a loop going; their hashes detect a stall (one came back).
export function recordRound(slug: string, node: RatchetNode, findings: ReviewFinding[], o: { cap: number; slice?: string }): RoundVerdict {
  const r = readRatchet(slug)
  const state = (node === 'build' ? r.slices[o.slice ?? '1'] : r.nodes[node]) ?? fresh()
  const hashes = findings.filter(f => BLOCKING.has(f.severity)).map(f => sha(`${f.category}|${f.text}`))
  const previous = state.hashes.at(-1) ?? []
  state.hashes.push(hashes)
  let result: RoundVerdict
  let kind: BlockKind = 'cap'
  if (!hashes.length) {
    state.status = 'done'
    result = { verdict: 'done', reason: 'no critical or high findings' }
  } else if (hashes.some(h => previous.includes(h))) {
    result = { verdict: 'blocked', reason: 'stall: the same finding came back after a fix round' }
    kind = 'stall'
  } else if (state.rounds >= o.cap) {
    result = { verdict: 'blocked', reason: `cap: ${o.cap} fix rounds used and ${hashes.length} finding(s) remain` }
    kind = 'cap'
  } else {
    state.rounds += 1
    result = { verdict: 'continue', reason: `${hashes.length} finding(s) to fix (round ${state.rounds}/${o.cap})` }
  }
  if (node === 'build') {
    r.slices[o.slice ?? '1'] = state
    if (slicesIn(slug).every(id => r.slices[id]?.status === 'done')) r.nodes.build = { ...(r.nodes.build ?? fresh()), status: 'done' }
  } else r.nodes[node] = state
  if (result.verdict === 'blocked') setBlock(r, node, result.reason, kind)
  writeRatchet(slug, r)
  appendEvent(slug, { node: node === 'build' ? `build#${o.slice ?? '1'}` : node, verdict: result.verdict, round: state.rounds, reason: result.reason })
  return result
}

// Raw main-row spend. Money is read from 'main' rows only; no other row kind can raise or lower it.
export function rawSpendUsd(slug: string, node?: string): number {
  return readJsonl<UsageRow>(USAGE).filter(u => u.kind === 'main' && u.change === slug && (!node || u.stage === node)).reduce((s, u) => s + (typeof u.usd === 'number' && Number.isFinite(u.usd) ? Math.max(0, u.usd) : 0), 0)
}

// Spend net of the credits a person granted with /sdlc-approve <slug> budget (kept in ratchet.json, never in usage.jsonl).
export function spendUsd(slug: string, node?: string): number {
  const credits = readRatchet(slug).credits ?? {}
  const credit = node ? credits[node as RatchetNode] ?? 0 : Object.values(credits).reduce((s, c) => s + c, 0)
  return Number(Math.max(0, rawSpendUsd(slug, node) - credit).toFixed(4))
}

const TEST_CASE = /(?:^|[^\w.])(?:it|test)(?:\.each\([^)]*\))?\s*\(|^\s*def test_\w+|^\s*func Test\w+|^\s*@Test\b/gm
export const testCaseCount = (texts: string[]): number => texts.reduce((n, t) => n + (t.match(TEST_CASE)?.length ?? 0), 0)

// The reviewer reply file must really live in the change folder (symlinks resolved) and not be evidence.
function readFrom(slug: string, from: string): string {
  const dir = path.join(CHANGES, slug)
  let real: string
  let root: string
  try { real = fs.realpathSync(path.resolve(from)); root = fs.realpathSync(dir) } catch { return fail(`--from ${from}: no such file`) }
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(real).isFile()) fail(`--from must be a file inside .sdlc/changes/${slug}/`)
  if (EVIDENCE_NAME_RE.test(path.basename(real)) || /^(?:verification|impact|pr)\.(?:md|json)$/.test(path.basename(real))) fail('--from cannot be an evidence file')
  return fs.readFileSync(real, 'utf8')
}

export function cmdRatchet(args: Args): void {
  const [sub, slug, node] = args.pos
  if (!sub || !slug) fail('usage: ratchet (record <slug> <node> [--slice N] | show <slug> | spend <slug>)')
  checkSlug(slug)
  if (sub === 'show') return out(JSON.stringify(readRatchet(slug), null, 2))
  if (sub === 'spend') {
    const byNode: Record<string, number> = {}
    for (const u of readJsonl<UsageRow>(USAGE).filter(u => u.kind === 'main' && u.change === slug)) byNode[u.stage ?? '(none)'] = Number(((byNode[u.stage ?? '(none)'] ?? 0) + (typeof u.usd === 'number' && Number.isFinite(u.usd) ? Math.max(0, u.usd) : 0)).toFixed(4))
    return out(JSON.stringify({ total: spendUsd(slug), byNode }))
  }
  if (sub !== 'record' || !node) fail('usage: ratchet record <slug> <build|test|sensors|pr-review> [--slice N] (--from <file in the change folder> | < reviewer reply)')
  const { config } = loadConfig()
  if (!Object.hasOwn(config.ratchet.rounds, node)) fail(`unknown ratchet node ${node}`)
  const n = node as RatchetNode
  // sensors and test are recorded internally by `quality` and `verify-report`; a model-written verdict must not certify them.
  if (n === 'sensors' || n === 'test') fail(`the ${n} node is recorded only by sdlc.ts quality / verify-report`)
  let slice = typeof args.opt.slice === 'string' ? args.opt.slice : undefined
  if (n === 'build') {
    const ids = slicesIn(slug)
    slice ??= ids.length === 1 ? ids[0] : undefined
    if (!slice) fail(`--slice is required: plan.md has ${ids.join(', ')}`)
    if (!ids.includes(slice)) fail(`unknown slice ${slice}; plan.md has ${ids.join(', ')}`)
  }
  const from = args.opt.from
  if (from === true) fail('--from needs a file path')
  const text = typeof from === 'string' ? readFrom(slug, from) : process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8')
  const findings = parseReviewFindings(text)
  const verdictLine = /^\s*verdict:\s*(pass|changes-needed)\b/im.exec(text)?.[1]?.toLowerCase()
  if (!verdictLine && !findings.length) fail('no reviewer verdict: expected a "verdict: pass|changes-needed" line or finding lines in the reply; nothing recorded')
  if (verdictLine === 'changes-needed' && !findings.some(f => BLOCKING.has(f.severity))) fail('changes-needed but no critical or high finding lines parsed: restate findings in the reviewer line format; nothing recorded')
  out(JSON.stringify(recordRound(slug, n, findings, { cap: config.ratchet.rounds[n], slice })))
}
