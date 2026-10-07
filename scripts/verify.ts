// `verify` runs a change's verification commands through the recorder and writes verification.md; `verify-report`
// only writes the report from runs already recorded. Verdicts come from captured exit codes, never from a model.
import fs from 'node:fs'
import path from 'node:path'
import { CHANGES, planPath, planVerificationBullets, planVerification, planApproved, checkSlug, exists, read, now, out, fail, defaultBase, type Args } from './core.ts'
import { activeSlug, loadChange, nextCommand } from './graph.ts'
import { loadConfig, runDeclared } from './check.ts'
import { formatFindings, isSource } from './model.ts'
import { branchDiff } from './diffs.ts'
import { treeStamp } from './stamp.ts'
import { runCommand, recordRun, readRuns, renderVerification, runsDigest, normCmd } from './runs.ts'
import { requiredLevels, levelResults } from './levels.ts'
import { recordRound, readRatchet, unblock, block } from './ratchet.ts'

// sensors.json is protected, so its commands always count. The plan document is the model's own file unless the person
// approved it (the approval is bound to its digest), so its ## Verification counts only then.
export function declaredCommandSet(slug: string | null): Set<string> {
  const { config } = loadConfig()
  const cmds = [...Object.values(config.fast), ...Object.values(config.full), ...Object.values(config.levels), ...Object.values(config.quality).map(q => q.cmd), ...(slug && planApproved(slug) ? planVerification(slug) : [])]
  return new Set(cmds.filter((c): c is string => Boolean(c)).map(normCmd))
}

function slugOf(args: Args, usage: string): string {
  const slug = args.pos[0] ? checkSlug(args.pos[0]) : activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail(usage)
  return slug
}

const FULL_BUDGET_MS = 1_800_000

// `before` is the stamp taken before any command ran: the report is stamped only when the tree is unchanged since, so a
// command that rewrites files (a formatter, codegen) never vouches for a tree the tests did not run on. verify-report alone
// never yields `full: pass`.
function writeReport(slug: string, full: 'pass' | 'fail' | 'none' = 'none', before?: string | null): 'pass' | 'fail' {
  const rows = readRuns(slug)
  const plan = planVerificationBullets(slug)
  const change = loadChange(slug)
  const { config } = loadConfig()
  const required = change.type === 'spike' ? [] : requiredLevels(change, read(planPath(slug)), config)
  const latest = new Map(rows.filter(r => !r.expectFail && !r.source).map(r => [normCmd(r.cmd), r.exit]))
  // Plan commands stand in for an undeclared unit level; with no plan list, any explicit green run does (the no-plan fallback).
  const planned = plan.commands.map(normCmd)
  const planPassed = planned.length ? planned.every(c => latest.get(c) === 0) : latest.size > 0 && [...latest.values()].every(e => e === 0)
  const levels = levelResults(slug, required, config, planPassed)
  const after = treeStamp()
  const tree = before === undefined || before === after ? after : null
  const { text, result } = renderVerification(rows, runsDigest(slug, rows.length), plan.commands, plan.ignored, levels, { tree, full: full === 'pass' && !tree ? 'none' : full })
  fs.writeFileSync(path.join(CHANGES, slug, 'verification.md'), text)
  // A required level nobody declared is not fixable by code (spec §5.2): block with the exact edit a person makes.
  // The level kind clears first, so a cap reached in this same run is recorded rather than refused behind the old block.
  const undeclared = levels.find(l => l.status === 'undeclared')
  if (!undeclared) unblock(slug, 'levels declared', 'level')
  // A failing report is always a new finding (counter keeps the hash unique), so only the test node's cap applies.
  if (result === 'fail') {
    recordRound(slug, 'test', [{ severity: 'high', category: 'tests', text: `verification failed at ${now()} (${rows.length} runs, round ${readRatchet(slug).nodes.test?.hashes.length ?? 0})` }], { cap: config.ratchet.rounds.test })
  }
  if (undeclared) block(slug, 'test', `level ${undeclared.level} required but not declared: add "${undeclared.level}": "<cmd>" to .sdlc/sensors.json levels: declare it on the trunk first, as a separate harness change to .sdlc/sensors.json reviewed by the code owners; then rebase this change`, 'level')
  out(`verification ${result}: ${rows.length} recorded run(s). Next: ${nextCommand(loadChange(slug))}`)
  return result
}

export function cmdVerifyReport(args: Args): void {
  writeReport(slugOf(args, 'usage: verify-report <slug>'))
}

// Runs the plan's `## Verification` commands and each required level's declared command, one after another, recording
// each as it finishes. Only commands the harness already trusts run unprompted (sensors.json, or a plan a person
// approved); the rest are listed for the model to run with `run`, which asks the person.
export function cmdVerify(args: Args): void {
  const slug = slugOf(args, 'usage: verify <slug>')
  const { config } = loadConfig()
  const change = loadChange(slug)
  const required = change.type === 'spike' ? [] : requiredLevels(change, read(planPath(slug)), config)
  const wanted = [...planVerificationBullets(slug).commands, ...required.map(l => config.levels[l] ?? '')].filter(Boolean)
  const trusted = declaredCommandSet(slug)
  const before = treeStamp()
  const seen = new Set<string>()
  const skipped: string[] = []
  const ran = new Set<string>()
  for (const cmd of wanted) {
    const key = normCmd(cmd)
    if (seen.has(key)) continue
    seen.add(key)
    if (!trusted.has(key)) { skipped.push(cmd); continue }
    const row = runCommand(cmd)
    recordRun(slug, row)
    ran.add(key)
    out(`exit ${row.exit}${row.timedOut ? ' (timed out)' : ''} in ${row.ms} ms: ${cmd}`)
  }
  if (skipped.length) out(`not run (not declared in sensors.json and the plan is not approved): ${skipped.map(c => `\`${c}\``).join(', ')}. Run each with \`sdlc.ts run --slug ${slug} -- "<command>"\`, which asks the person, then \`verify-report ${slug}\`.`)
  // One authoritative run: the declared full commands run here too, so ship and push can check the stamp instead.
  // The full commands of the scopes the branch touches (source files only), skipping any the loop above already ran.
  // With no base to diff against, every scope's: an empty selection must never stamp `full: pass`.
  const base = defaultBase()
  const files = base ? branchDiff(base).map(d => d.file).filter(f => isSource(f, config)) : 'all'
  const failed = runDeclared('full', config, slug, FULL_BUDGET_MS, false, files, ran).filter(f => f.severity === 'block')
  if (failed.length) out(formatFindings(failed))
  if (writeReport(slug, failed.length ? 'fail' : 'pass', before) !== 'pass') process.exitCode = 1
}
