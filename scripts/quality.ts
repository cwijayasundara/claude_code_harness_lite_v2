// The sensors node (spec §5.3): each quality category runs on the branch and on the base (a temporary worktree,
// cached per base SHA in ratchet.json); a category may not rise above the base. Built-in pattern sensors run as at a stop.
import path from 'node:path'
import { ROOT, checkSlug, defaultBase, read, out, fail, type Args } from './core.ts'
import { runCommand } from './runs.ts'
import { withBaseTree } from './basetree.ts'
import { treeStamp } from './stamp.ts'
import { readRatchet, writeRatchet, recordRound, testCaseCount } from './ratchet.ts'
import { loadConfig, runChecks } from './check.ts'
import { branchDiff, showAt, showMany } from './diffs.ts'
import { QUALITY_CATEGORIES, isTest, isSource, formatFindings, warnLines, type FileDiff, type Finding, type QualityCmd, type SensorConfig } from './model.ts'
import { selectScopes, closureRoots, extraScopes, rootError } from './scopes.ts'

export type CategoryResult = { category: string; branch: number | null; base: number | null; status: 'pass' | 'regressed' | 'fail' | 'unmeasured'; note?: string }
const MISSING = 127
// Not a waivable sensor: a falling test count is never waived, so it stays out of SENSOR_NAMES.
const INVARIANT = 'invariant'
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

function countIn(dir: string, cmd: string, how: string, onBase = false): { n: number | null; note?: string } {
  const row = runCommand(cmd, { cwd: dir, timeoutMs: QUALITY_TIMEOUT_MS })
  if (row.exit === MISSING || row.timedOut) return { n: null, note: row.timedOut ? 'timed out' : 'command not found' }
  // On the base a failing run whose output does not parse is a broken tool, not a count of its exit status.
  if (onBase && row.exit !== 0 && how !== 'exit' && (how === 'lines' ? !row.tail.trim() : countFindings(row.tail, 0, how) === null)) return { n: null, note: 'base run failed' }
  const n = countFindings(row.tail, row.exit, how)
  return n === null ? { n: null, note: `could not count (${how})` } : { n }
}

// key: the category, or `<scope>:<category>` for a scope's; cwd: where it runs, relative to the checkout ('.' is the root).
type QualityItem = { key: string; q: QualityCmd; cwd: string }
type QualityPlan = { items: QualityItem[]; sparse?: string[]; warnings: Finding[] }

// What to measure for these changed (source) files: the top-level categories (no scopes, or an unscoped file) plus each
// affected scope's. With sparseBase and every file in a scope, the base checkout only needs the affected scopes' closure.
function qualityPlan(config: SensorConfig, files: string[]): QualityPlan {
  const top = Object.entries(config.quality).filter((e): e is [string, QualityCmd] => Boolean(e[1])).map(([key, q]) => ({ key, q, cwd: '.' }))
  if (!Object.keys(config.scopes).length) return { items: top, warnings: [] }
  // The affected command runs only when it can matter: changed files and a scope with quality commands to choose between.
  const scoped = Object.values(config.scopes).some(s => Object.values(s.quality ?? {}).some(Boolean))
  const extra = files.length && scoped ? extraScopes(config) : []
  const sel = selectScopes(files, config, extra)
  const warnings: Finding[] = extra === null ? [{ sensor: 'unscoped', severity: 'warn', message: `the affected command failed, so every scope ran: ${config.affected}`, fix: 'run the affected command in .rig/sensors.json and fix it' }] : []
  const items: QualityItem[] = sel.unscoped.length ? top : []
  for (const s of Object.values(config.scopes)) {
    if (!sel.affected.includes(s.name)) continue
    for (const [c, q] of Object.entries(s.quality ?? {})) if (q) items.push({ key: `${s.name}:${c}`, q, cwd: s.root })
  }
  const roots = config.sparseBase && !sel.unscoped.length ? closureRoots(config, sel.affected) : []
  // A root of '.' is the whole repository: nothing to leave out.
  const sparse = roots.length && !roots.some(r => path.normalize(r) === '.') ? roots : undefined
  return { items, sparse, warnings }
}

// A scope's directory in this checkout, or the reason it may not be used (missing, or resolving outside the checkout).
function itemDir(top: string, it: QualityItem): { dir: string; error?: string } {
  return { dir: path.join(top, it.cwd), error: path.normalize(it.cwd) === '.' ? undefined : rootError(it.cwd, top) }
}

// The base runs once per base SHA in a throwaway worktree (basetree.ts), sparse over `sparse` when given. Counts are cached
// in ratchet.json per key with the command, counting mode, directory and checkout (full, or sparse over which roots) they
// were measured with; a change to any of them is measured again. Entries from before cwd/mode were kept read as root/full.
function baseCounts(base: string, items: QualityItem[], slug: string, sparse?: string[]): Record<string, number | null> {
  const r = readRatchet(slug)
  const cached = r.baseline.base === base ? r.baseline.quality ?? {} : {}
  const counts: Record<string, number | null> = {}
  const want = sparse ? `sparse:${sparse.join(',')}` : 'full'
  let mode = want
  const todo = items.filter(it => {
    const h = cached[it.key]
    if (h && h.cmd === it.q.cmd && h.count === it.q.count && (h.cwd ?? '.') === it.cwd && (h.mode ?? 'full') === want && typeof h.n === 'number') { counts[it.key] = h.n; return false }
    return true
  })
  if (todo.length) {
    const tree = withBaseTree(base, top => {
      for (const it of todo) {
        const { dir, error } = itemDir(top, it)
        counts[it.key] = error ? null : countIn(dir, it.q.cmd, it.q.count, true).n
      }
    }, { sparse })
    if (!tree.ok) for (const it of todo) counts[it.key] = null
    else if (tree.sparse === false) mode = 'full'
  }
  const store: NonNullable<typeof r.baseline.quality> = {}
  for (const it of items) {
    const n = counts[it.key]
    // A new count records the checkout it actually ran in (a sparse base that fell back to full is 'full'); the defaults
    // (root, full) are left out, so an unscoped repository's entries keep their shape.
    const m = todo.includes(it) ? mode : want
    if (typeof n === 'number') store[it.key] = { cmd: it.q.cmd, count: it.q.count, n, ...(it.cwd !== '.' ? { cwd: it.cwd } : {}), ...(m !== 'full' ? { mode: m } : {}) }
  }
  r.baseline = { ...r.baseline, base, quality: store }
  writeRatchet(slug, r)
  return counts
}

// The test-case count may not fall. Only test files in the diff can change it, so only those are read: the base side in
// one `git cat-file --batch`, the branch side from disk. Untouched files count equally on both sides, so this equals
// comparing the whole trees without reading them.
export function testDelta(base: string, diffs: FileDiff[], config: SensorConfig): { before: number; after: number } {
  const existing = diffs.filter(d => d.status !== 'A' && isTest(d.from ?? d.file, config))
  const atBase = showMany(base, existing.map(d => d.from ?? d.file))
  const before = testCaseCount(existing.map(d => atBase.get(d.from ?? d.file) ?? ''))
  const after = testCaseCount(diffs.filter(d => d.status !== 'D' && !d.binary && isTest(d.file, config)).map(d => read(path.join(ROOT, d.file))))
  return { before, after }
}

// Without scopes the rows are every category in QUALITY_CATEGORIES order, as before; with scopes, only what was measured
// (top-level categories first, in that order, then each scope's).
export function runQuality(slug: string, baseRef: string | null = defaultBase()): { categories: CategoryResult[]; blocks: Finding[]; warnings: Finding[] } {
  const { config, rules } = loadConfig()
  const base = baseRef
  const diffs = branchDiff(base ?? 'HEAD')
  const { items, sparse, warnings } = qualityPlan(config, diffs.map(d => d.file).filter(f => isSource(f, config)))
  const baseN: Record<string, number | null> = base && items.length ? baseCounts(base, items, slug, sparse) : {}
  const measured: CategoryResult[] = items.map(it => {
    const { dir, error } = itemDir(ROOT, it)
    if (error) return { category: it.key, branch: null, base: null, status: 'fail', note: error }
    const b = countIn(dir, it.q.cmd, it.q.count)
    if (b.n === null) return { category: it.key, branch: null, base: null, status: 'fail', note: b.note }
    if (!base) return { category: it.key, branch: b.n, base: null, status: 'unmeasured', note: 'no base' }
    const was = baseN[it.key] ?? null
    if (was === null) return { category: it.key, branch: b.n, base: null, status: 'unmeasured', note: 'base could not be measured' }
    return { category: it.key, branch: b.n, base: was, status: b.n > was ? 'regressed' : 'pass' }
  })
  const undeclared: CategoryResult[] = Object.keys(config.scopes).length ? [] : QUALITY_CATEGORIES.filter(c => !config.quality[c]).map(category => ({ category, branch: null, base: null, status: 'unmeasured', note: 'no command declared' }))
  const rank = (c: string): number => { const i = (QUALITY_CATEGORIES as readonly string[]).indexOf(c); return i < 0 ? QUALITY_CATEGORIES.length : i }
  // A stable sort: scoped keys (rank past the end) keep their declaration order.
  const categories = [...measured, ...undeclared].sort((a, b) => rank(a.category) - rank(b.category))
  const blocks: Finding[] = categories.filter(c => c.status === 'regressed' || c.status === 'fail').map(c => ({
    sensor: `quality.${c.category}`, severity: 'block', message: c.status === 'fail' ? `${c.category} could not run: ${c.note}` : `${c.category} rose from ${c.base} to ${c.branch}`,
    fix: c.status === 'fail' ? 'install the tool or fix the command in .rig/sensors.json quality' : `fix the new ${c.category} findings; the base branch has ${c.base}`,
  }))
  if (base) {
    const { before, after } = testDelta(base, diffs, config)
    if (after < before) blocks.push({ sensor: INVARIANT, severity: 'block', message: `test cases: base ${before} → branch ${after}`, fix: 'restore the removed tests; the test count never drops' })
  }
  // Pattern sensors and waivers only (point 'stop'); traceability, red proof and full commands run at the pr node's ship gate.
  const gate = runChecks({ point: 'stop', diffs, config, rules, slugs: [slug], commands: 'none', budgetMs: 60_000, before: f => showAt(base ?? 'HEAD', f) ?? '', base, ratchet: false })
  blocks.push(...gate.blocks)
  return { categories, blocks, warnings }
}

export function cmdQuality(args: Args): void {
  const given = args.pos[0]
  if (!given) fail('usage: quality <slug>')
  const slug = checkSlug(given)
  const { config } = loadConfig()
  const { categories, blocks, warnings } = runQuality(slug)
  const rows = categories.map(c => `${c.category.padEnd(11)} ${c.status === 'unmeasured' ? `unmeasured${c.note === 'no base' ? ' (no base)' : ''}` : c.status === 'fail' ? `fail (${c.note})` : `base ${c.base} → branch ${c.branch}  ${c.status}`}`)
  const v = recordRound(slug, 'sensors', blocks.map(b => ({ severity: 'high', category: b.sensor, text: `${b.file ?? ''} ${b.message}` })), { cap: config.ratchet.rounds.sensors })
  if (v.verdict === 'done') {
    const r = readRatchet(slug)
    const node = r.nodes.sensors
    const tree = treeStamp()
    if (node && tree) { node.tree = tree; writeRatchet(slug, r) }
  }
  out([...rows, ...(blocks.length ? ['', formatFindings(blocks)] : []), ...(warnings.length ? ['', ...warnLines(warnings)] : []), '', `sensors: ${v.verdict} (${v.reason})`].join('\n'))
  if (blocks.length) process.exitCode = 2
}
