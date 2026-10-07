// Evals: the agent's configuration (CLAUDE.md, .claude/**, guides, rules) regression-tested by a person before it merges.
// Each .sdlc/evals/<id>.json is a prompt plus deterministic checks, run with `claude -p` in a throwaway worktree: the code at
// the eval's `base` (default HEAD), the configuration and the eval's own `files` from HEAD. Verdicts come from exit codes and
// files, never from what the model says it did. Nothing in rig blocks on the result: a person reads it.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SDLC, CHANGES, exists, read, now, out, fail, git, gitIn, optString, readJsonl, frontmatter, listChanges, isShipped, planVerification, sanctionWrites, type Args } from './core.ts'
import { loadConfig } from './check.ts'
import { runCommand } from './runs.ts'
import { withBaseTree } from './basetree.ts'
import { matchesAny } from './model.ts'

export const EVALS = path.join(SDLC, 'evals')
export const RESULTS = path.join(EVALS, 'results.jsonl')
export const CONFIG_PATHS = ['CLAUDE.md', '.claude', '.sdlc/guides', '.sdlc/rules.json', '.sdlc/sensors.json']

export type Check = { kind: 'command'; cmd: string } | { kind: 'file-contains'; path: string; text: string } | { kind: 'file-absent'; path: string } | { kind: 'skill-loaded'; name: string }
export type Eval = { id: string; prompt: string; checks: Check[]; allowedTools?: string; base?: string; files?: string[]; source?: string }
type CheckResult = { kind: string; ok: boolean; detail: string }
export type EvalResult = { at: string; run: string; id: string; pass: boolean; error?: string; checks: CheckResult[]; ms: number }
export type Summary = { run: string; passed: number; total: number; errors: number; rate: number; verdict: 'pass' | 'fail' | 'unmeasured' }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

// A definition the runner cannot trust is an error for that file, never a silent skip.
export function parseEval(text: string, id: string): Eval | string {
  let v: unknown
  try { v = JSON.parse(text) } catch { return `${id}: not valid JSON` }
  if (!isObj(v) || !str(v.prompt) || !Array.isArray(v.checks) || v.checks.length === 0) return `${id}: needs a prompt and at least one check`
  const checks: Check[] = []
  for (const c of v.checks) {
    if (isObj(c) && c.kind === 'command' && str(c.cmd)) checks.push({ kind: 'command', cmd: c.cmd })
    else if (isObj(c) && c.kind === 'file-contains' && str(c.path) && str(c.text)) checks.push({ kind: 'file-contains', path: c.path, text: c.text })
    else if (isObj(c) && c.kind === 'file-absent' && str(c.path)) checks.push({ kind: 'file-absent', path: c.path })
    else if (isObj(c) && c.kind === 'skill-loaded' && str(c.name)) checks.push({ kind: 'skill-loaded', name: c.name })
    else return `${id}: unknown or incomplete check ${JSON.stringify(c).slice(0, 80)}`
  }
  const files = Array.isArray(v.files) ? v.files.filter(str) : []
  return { id, prompt: v.prompt, checks, ...(str(v.allowedTools) ? { allowedTools: v.allowedTools } : {}), ...(str(v.base) ? { base: v.base } : {}), ...(files.length ? { files } : {}), ...(str(v.source) ? { source: v.source } : {}) }
}

// The skills the session invoked: with --output-format stream-json, assistant messages carry the tool_use blocks.
export function skillsLoaded(stream: string): string[] {
  const names: string[] = []
  for (const line of stream.split('\n')) {
    let ev: unknown
    try { ev = JSON.parse(line) } catch { continue }
    const content = isObj(ev) && ev.type === 'assistant' && isObj(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : []
    for (const b of content) if (isObj(b) && b.type === 'tool_use' && b.name === 'Skill' && isObj(b.input) && str(b.input.skill)) names.push(b.input.skill)
  }
  return names
}

// A relative path that stays inside the worktree, else null: a check never reads outside the code under test.
const inside = (dir: string, rel: string): string | null => {
  const p = path.resolve(dir, rel)
  return !path.isAbsolute(rel) && p.startsWith(dir + path.sep) ? p : null
}

function scoreChecks(checks: Check[], dir: string, stream: string, timeoutMs: number): CheckResult[] {
  const skills = skillsLoaded(stream)
  return checks.map(c => {
    if (c.kind === 'command') {
      const r = runCommand(c.cmd, { cwd: dir, timeoutMs })
      return { kind: c.kind, ok: r.exit === 0, detail: `${c.cmd} → exit ${r.exit}` }
    }
    if (c.kind === 'skill-loaded') {
      const ok = skills.some(s => s === c.name || s.endsWith(`:${c.name}`) || s === `rig-${c.name}`)
      return { kind: c.kind, ok, detail: ok ? c.name : `skill ${c.name} not loaded (loaded: ${skills.join(', ') || 'none'})` }
    }
    const p = inside(dir, c.path)
    if (!p) return { kind: c.kind, ok: false, detail: `${c.path} is outside the repository` }
    if (c.kind === 'file-absent') return { kind: c.kind, ok: !fs.existsSync(p), detail: `${c.path} ${fs.existsSync(p) ? 'exists' : 'absent'}` }
    const ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(c.text)
    return { kind: c.kind, ok, detail: `${c.path} ${ok ? 'contains' : 'lacks'} the text` }
  })
}

// The code under test is the eval's base; the agent configuration and the eval's own files come from HEAD.
function overlay(dir: string, head: string, files: string[]): void {
  gitIn(dir, ['rm', '-rqf', '--ignore-unmatch', '--', ...CONFIG_PATHS])
  for (const p of [...CONFIG_PATHS, ...files]) if (gitIn(dir, ['cat-file', '-e', `${head}:${p}`]) !== null) gitIn(dir, ['checkout', head, '--', p])
}

function runEval(e: Eval, run: string, cfg: { maxTurns: number; timeoutMs: number }, model?: string): EvalResult {
  const started = Date.now()
  const head = git(['rev-parse', 'HEAD']) ?? 'HEAD'
  const done = (pass: boolean, checks: CheckResult[], error?: string): EvalResult => ({ at: now(), run, id: e.id, pass, ...(error ? { error } : {}), checks, ms: Date.now() - started })
  const bin = process.env.RIG_CLAUDE || 'claude'
  const missing = (e.files ?? []).filter(p => gitIn(process.cwd(), ['cat-file', '-e', `${head}:${p}`]) === null)
  if (missing.length) return done(false, [], `files not in HEAD: ${missing.join(', ')}; commit them first`)
  const r = withBaseTree(e.base ?? head, dir => {
    overlay(dir, head, e.files ?? [])
    const args = ['-p', e.prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(cfg.maxTurns), ...(e.allowedTools ? ['--allowedTools', e.allowedTools] : []), ...(model ? ['--model', model] : [])]
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    const c = spawnSync(bin, args, { cwd: dir, env, encoding: 'utf8', timeout: cfg.timeoutMs, maxBuffer: 256 * 1024 * 1024 })
    const code = (c.error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return done(false, [], `${bin} not found: install Claude Code`)
    if (c.error) return done(false, [], `${bin} did not finish: ${code === 'ETIMEDOUT' ? `timed out after ${cfg.timeoutMs} ms` : c.error.message}`)
    if (c.status !== 0) return done(false, [], `${bin} exited ${c.status}: ${(c.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`)
    const checks = scoreChecks(e.checks, dir, c.stdout ?? '', cfg.timeoutMs)
    return done(checks.every(x => x.ok), checks)
  }, { prefix: 'rig-eval-' })
  return r.ok ? r.value : done(false, [], r.error)
}

export function summarize(rows: EvalResult[], cfg: { minPass: number; maxErrors: number }): Summary | null {
  const run = rows.at(-1)?.run
  if (!run) return null
  const last = rows.filter(r => r.run === run)
  const passed = last.filter(r => r.pass).length
  const errors = last.filter(r => r.error).length
  const rate = passed / last.length
  return { run, passed, total: last.length, errors, rate, verdict: errors > cfg.maxErrors ? 'unmeasured' : rate >= cfg.minPass ? 'pass' : 'fail' }
}

export const lastRun = (): Summary | null => summarize(readJsonl<EvalResult>(RESULTS), loadConfig().config.evals)

// Drafts evals from shipped changes: the task as its intent stated it, run from the commit before it, checked by the plan's
// verification commands with the change's own tests taken from HEAD. A person curates every draft before relying on it.
function seed(limit: number): void {
  const tests = loadConfig().config.tests
  const written: string[] = []
  for (const slug of listChanges().filter(isShipped)) {
    if (written.length >= limit) break
    const file = path.join(EVALS, `change-${slug}.json`)
    let ship: { base?: unknown } = {}
    try { ship = JSON.parse(read(path.join(CHANGES, slug, 'ship.json'))) as { base?: unknown } } catch { continue }
    const cmds = planVerification(slug)
    if (exists(file) || !str(ship.base) || !cmds.length) continue
    const shipCommit = git(['log', '-1', '--format=%H', '--', `.sdlc/changes/${slug}/ship.json`]) ?? 'HEAD'
    const files = (git(['diff', '--name-only', ship.base, shipCommit]) ?? '').split('\n').filter(f => f && matchesAny(f, tests))
    const { body } = frontmatter(read(path.join(CHANGES, slug, 'intent.md')))
    const draft = { prompt: `Make this change in this repository, then run its verification.\n\n${body.trim()}`, base: ship.base, files, checks: cmds.map(cmd => ({ kind: 'command', cmd })), source: `change:${slug}` }
    fs.mkdirSync(EVALS, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(draft, null, 2) + '\n')
    written.push(`.sdlc/evals/change-${slug}.json`)
  }
  if (written.length) sanctionWrites(written)
  out(written.length ? `seeded ${written.length} eval(s) in .sdlc/evals: read each prompt and check before relying on it` : 'nothing to seed: every shipped change with a base and plan verification already has an eval')
}

export function cmdEvals(args: Args): void {
  if (!exists(SDLC)) fail('sdlc not initialised here')
  if (args.opt.seed) return seed(Number(optString(args, 'limit')) || 20)
  const cfg = loadConfig().config.evals
  const only = optString(args, 'only')
  const files = exists(EVALS) ? fs.readdirSync(EVALS).filter(f => f.endsWith('.json') && (!only || f === `${only}.json`)).sort() : []
  if (!files.length) fail(only ? `no eval ${only} in .sdlc/evals` : 'no evals in .sdlc/evals: run `sdlc.ts evals --seed` or write one')
  if (git(['status', '--porcelain', '--', ...CONFIG_PATHS])) out('warn: uncommitted changes to CLAUDE.md, .claude, guides, rules or sensors are not evaluated: evals use the configuration at HEAD; commit first')
  const run = now()
  const model = optString(args, 'model')
  const rows: EvalResult[] = files.map(f => {
    const id = f.slice(0, -'.json'.length)
    const e = parseEval(read(path.join(EVALS, f)), id)
    return typeof e === 'string' ? { at: now(), run, id, pass: false, error: e, checks: [], ms: 0 } : runEval(e, run, cfg, model)
  })
  fs.appendFileSync(RESULTS, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const s = summarize(rows, cfg) as Summary
  const why = (r: EvalResult): string => r.error ?? r.checks.filter(c => !c.ok).map(c => c.detail).join('; ')
  out([...rows.map(r => (r.pass ? `pass ${r.id}` : `FAIL ${r.id}: ${why(r)}`)), `evals: ${s.passed}/${s.total} pass (${s.rate.toFixed(2)}), ${s.errors} error(s), minPass ${cfg.minPass} → ${s.verdict}`].join('\n'))
  if (s.verdict !== 'pass') process.exitCode = 1
}
