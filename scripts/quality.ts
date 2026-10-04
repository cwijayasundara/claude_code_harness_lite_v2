// The sensors node (spec §5.3): each quality category runs on the branch and on the base (a temporary worktree,
// cached per base SHA in ratchet.json); a category may not rise above the base. Built-in pattern sensors run as at a stop.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, defaultBase, git, gitIn, read, out, fail, type Args } from './core.ts'
import { runCommand } from './runs.ts'
import { readRatchet, writeRatchet, recordRound, testCaseCount } from './ratchet.ts'
import { loadConfig, runChecks } from './check.ts'
import { branchDiff, showAt } from './diffs.ts'
import { QUALITY_CATEGORIES, isTest, formatFindings, type Finding } from './model.ts'

export type CategoryResult = { category: string; branch: number | null; base: number | null; status: 'pass' | 'regressed' | 'fail' | 'unmeasured'; note?: string }
const MISSING = 127
const QUALITY_TIMEOUT_MS = 300_000

export function countFindings(output: string, exit: number, how: string): number | null {
  if (how === 'exit') return exit === 0 ? 0 : 1
  if (how === 'lines') return output.split('\n').filter(l => l.trim()).length
  try {
    let v: unknown = JSON.parse(output)
    for (const k of how.replace(/^json:/, '').split('.')) v = (v as Record<string, unknown>)[k]
    return typeof v === 'number' ? v : null
  } catch { return null }
}

function countIn(dir: string, cmd: string, how: string): { n: number | null; note?: string } {
  const row = runCommand(cmd, { cwd: dir, timeoutMs: QUALITY_TIMEOUT_MS })
  if (row.exit === MISSING || row.timedOut) return { n: null, note: row.timedOut ? 'timed out' : 'command not found' }
  const n = countFindings(row.tail, row.exit, how)
  return n === null ? { n: null, note: `could not count (${how})` } : { n }
}

// The base runs once per base SHA in a throwaway worktree (always removed and pruned) and is cached in ratchet.json.
function baseCounts(base: string, categories: [string, { cmd: string; count: string }][], slug: string): Record<string, number | null> {
  const r = readRatchet(slug)
  const cached = r.baseline.base === base ? r.baseline.quality : undefined
  if (cached && categories.every(([c]) => c in cached)) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-base-'))
  const counts: Record<string, number | null> = {}
  try {
    if (gitIn(ROOT, ['worktree', 'add', '--detach', '-q', dir, base]) === null) return Object.fromEntries(categories.map(([c]) => [c, null]))
    for (const [c, q] of categories) counts[c] = countIn(dir, q.cmd, q.count).n
  } finally {
    gitIn(ROOT, ['worktree', 'remove', '--force', dir])
    fs.rmSync(dir, { recursive: true, force: true })
    gitIn(ROOT, ['worktree', 'prune'])
  }
  r.baseline = { ...r.baseline, base, quality: counts as Record<string, number> }
  writeRatchet(slug, r)
  return counts
}

function testCount(ref: string | null): number {
  const { config } = loadConfig()
  const files = (ref ? git(['ls-tree', '-r', '--name-only', ref]) : git(['ls-files', '--cached', '--others', '--exclude-standard'])) ?? ''
  const tests = files.split('\n').filter(f => f && isTest(f, config))
  return testCaseCount(tests.map(f => (ref ? showAt(ref, f) ?? '' : read(path.join(ROOT, f)))))
}

export function runQuality(slug: string): { categories: CategoryResult[]; blocks: Finding[] } {
  const { config, rules } = loadConfig()
  const base = defaultBase()
  const declared = Object.entries(config.quality).filter((e): e is [string, { cmd: string; count: string }] => Boolean(e[1]))
  const baseN = base && declared.length ? baseCounts(base, declared, slug) : {}
  const categories: CategoryResult[] = QUALITY_CATEGORIES.map(category => {
    const q = config.quality[category]
    if (!q) return { category, branch: null, base: null, status: 'unmeasured', note: 'no command declared' }
    const b = countIn(ROOT, q.cmd, q.count)
    if (b.n === null) return { category, branch: null, base: null, status: 'fail', note: b.note }
    if (!base) return { category, branch: b.n, base: null, status: 'unmeasured', note: 'no base' }
    const was = (baseN as Record<string, number | null>)[category] ?? null
    if (was === null) return { category, branch: b.n, base: null, status: 'unmeasured', note: 'base could not be measured' }
    return { category, branch: b.n, base: was, status: b.n > was ? 'regressed' : 'pass' }
  })
  const blocks: Finding[] = categories.filter(c => c.status === 'regressed' || c.status === 'fail').map(c => ({
    sensor: `quality.${c.category}`, severity: 'block', message: c.status === 'fail' ? `${c.category} could not run: ${c.note}` : `${c.category} rose from ${c.base} to ${c.branch}`,
    fix: c.status === 'fail' ? 'install the tool or fix the command in .sdlc/sensors.json quality' : `fix the new ${c.category} findings; the base branch has ${c.base}`,
  }))
  if (base) {
    const before = testCount(base)
    const after = testCount(null)
    if (after < before) blocks.push({ sensor: 'invariant', severity: 'block', message: `test cases: base ${before} → branch ${after}`, fix: 'restore the removed tests; the test count never drops' })
  }
  // Pattern sensors and waivers only (point 'stop'); traceability, red proof and full commands run at the pr node's ship gate.
  const gate = runChecks({ point: 'stop', diffs: branchDiff(base ?? 'HEAD'), config, rules, slugs: [slug], commands: 'none', budgetMs: 60_000, before: f => showAt(base ?? 'HEAD', f) ?? '', base, ratchet: false })
  blocks.push(...gate.blocks)
  return { categories, blocks }
}

export function cmdQuality(args: Args): void {
  const slug = args.pos[0]
  if (!slug) fail('usage: quality <slug>')
  const { config } = loadConfig()
  const { categories, blocks } = runQuality(slug)
  const rows = categories.map(c => `${c.category.padEnd(11)} ${c.status === 'unmeasured' ? `unmeasured${c.note === 'no base' ? ' (no base)' : ''}` : c.status === 'fail' ? `fail (${c.note})` : `base ${c.base} → branch ${c.branch}  ${c.status}`}`)
  const v = recordRound(slug, 'sensors', blocks.map(b => ({ severity: 'high', category: b.sensor, text: `${b.file ?? ''} ${b.message}` })), { cap: config.ratchet.rounds.sensors })
  out([...rows, ...(blocks.length ? ['', formatFindings(blocks)] : []), '', `sensors: ${v.verdict} (${v.reason})`].join('\n'))
  if (blocks.length) process.exitCode = 2
}
