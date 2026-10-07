// `ratchet record <slug> build --checks`: a slice's verdict from captured evidence. The model never certifies its own slice.
import { defaultBase, scopeDrift, planApproved, planVerification } from './core.ts'
import { loadConfig, runChecks } from './check.ts'
import { branchDiff, showAt } from './diffs.ts'
import { loadChange } from './graph.ts'
import { readRuns, normCmd } from './runs.ts'
import { treeStamp } from './stamp.ts'

export type SliceCheck = { ok: true } | { ok: false; why: string }

export function checkSlice(slug: string): SliceCheck {
  if (loadChange(slug).tier === 'L') return { ok: false, why: 'tier L slices need a reviewer verdict (rig:reviewer), not --checks' }
  const { config, rules } = loadConfig()
  const base = defaultBase()
  const drift = scopeDrift(slug, base).drift
  if (drift.length) return { ok: false, why: `files outside the plan's ## Files: ${drift.join(', ')}` }
  const gate = runChecks({ point: 'stop', diffs: branchDiff(base ?? 'HEAD'), config, rules, slugs: [slug], commands: 'none', budgetMs: 60_000, before: f => showAt(base ?? 'HEAD', f) ?? '', base, ratchet: false })
  if (gate.blocks.length) return { ok: false, why: `sensors block: ${gate.blocks.map(b => `${b.sensor}${b.file ? ` ${b.file}` : ''}: ${b.message}`).join('; ')}` }
  const tests = new Set([config.fast.test, config.full.test, ...Object.values(config.levels), ...(planApproved(slug) ? planVerification(slug) : [])].filter((c): c is string => Boolean(c)).map(normCmd))
  const tree = treeStamp()
  const green = tree !== null && readRuns(slug).some(r => !r.expectFail && !r.source && !r.timedOut && r.exit === 0 && r.tree === tree && tests.has(normCmd(r.cmd)))
  return green ? { ok: true } : { ok: false, why: 'no green run of a declared test command on the current tree (declared: fast.test or full.test in sensors.json, levels.*, or the approved plan ## Verification): run one with sdlc.ts run -- "<command>", then record again' }
}
