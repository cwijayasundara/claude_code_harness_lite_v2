// node tests/e2e/run.mjs [--driver scripted|live] [--phase P0|P1|P2|P3|P4] [--keep] [--out DIR]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSandbox } from '../integration/lib/sandbox.mjs'
import { writeReport } from './lib/report.mjs'
import { install, SCAFFOLD_PROMPT } from './phases/p0-install.mjs'
import { PHASE as P1, runChange } from './phases/p1-greenfield.mjs'
import { scriptedDriver } from './driver/scripted.mjs'
import { PHASE as P2 } from './phases/p2-change.mjs'
import { runDeploy } from './phases/p3-deploy.mjs'
import { runMaintain, PHASE as P4 } from './phases/p4-maintain.mjs'
import { mergeToMain } from './lib/merge.mjs'
import { runNegatives, runStaleTwin, runDeployNegatives, runMaintainNegatives } from './negative.mjs'
import { createSessions, liveDriver } from './driver/live.mjs'
import { assertOnboarding } from '../integration/assert/onboarding.mjs'
import { assertProcess } from '../integration/assert/process.mjs'
import { Checks } from '../integration/lib/checks.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const driverName = arg('driver', 'scripted')
const only = arg('phase')
const out = path.resolve(arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'rig-e2e-'))))
const live = driverName === 'live'

const sb = createSandbox({ name: 'project', out })
const sessions = live ? createSessions({ sb, out, capUsd: Number(arg('cap', 6)) }) : null
const driverFor = phase => (live ? liveDriver(sb, phase, { sessions }) : scriptedDriver(sb, phase))
const results = []
// A phase runs when it is the requested one or a prerequisite of it (P2 needs P1).
const NEEDS = { P2: ['P1'], P4: ['P1', 'P2'] }
const ensureMain = () => {
  const b = sb.git('rev-parse', '--abbrev-ref', 'HEAD')
  if (b !== 'main') mergeToMain(sb, b.replace(/^sdlc\//, ''))
}
const want = id => !only || only === id || (NEEDS[only] ?? []).includes(id)
const finish = () => {
  writeReport(out, results)
  for (const c of results) c.print()
  console.log(`\nreport and sandbox: ${out}`)
  process.exitCode = results.some(c => c.failed.length) ? 1 : (process.exitCode ?? 0)
}

try {
  if (live) {
    sb.git('commit', '-q', '--allow-empty', '-m', 'chore: empty start')
    sb.isolate()
    sessions.run('P0-init', `/rig:init --defaults greenfield "${SCAFFOLD_PROMPT}"`, { withPlugin: true })
    sb.commitAll('chore: onboarding leftovers')
    const p0 = new Checks('P0 install (live)')
    await assertOnboarding(p0, sb, { lane: 'greenfield' })
    results.push(p0)
  } else {
    results.push(await install(sb))
  }
  if (want('P1')) results.push((await runChange(sb, P1, driverFor(P1), { first: true })).checks)
  if (!live && want('P1')) {
    const bad = await runNegatives(sb, P1.slug)
    for (const b of bad) console.error(`twin surprise: ${b}`)
    if (bad.length) process.exitCode = 1
  }
  if (want('P2')) {
    mergeToMain(sb, P1.slug)
    const { slug, checks: c2 } = await runChange(sb, P2, driverFor(P2))
    // Edited, not rewritten: under 80% of cart.js lines deleted relative to main.
    const del = Number(sb.git('diff', '--numstat', 'main...HEAD', '--', 'src/cart.js').split('\t')[1])
    const total = sb.git('show', 'main:src/cart.js').split('\n').length
    await c2.check('P2: cart.js was edited, not rewritten', () => del / total < 0.8 || `${del} of ${total} lines deleted`)
    results.push(c2)
    if (!live) {
      const bad = await runStaleTwin(sb, slug)
      for (const b of bad) console.error(`twin surprise: ${b}`)
      if (bad.length) process.exitCode = 1
    }
  }
  if (want('P3')) {
    ensureMain()
    results.push(await runDeploy(sb))
    if (!live) {
      const bad = await runDeployNegatives(sb)
      for (const b of bad) console.error(`twin surprise: ${b}`)
      if (bad.length) process.exitCode = 1
    }
  }
  if (want('P4')) {
    ensureMain()
    const r = await runMaintain(sb, driverFor(P4))
    results.push(...r.checks)
    if (!live) {
      const bad = await runMaintainNegatives(out)
      for (const b of bad) console.error(`twin surprise: ${b}`)
      if (bad.length) process.exitCode = 1
    }
  }
  if (live) {
    const pc = new Checks('process (all live sessions)')
    await assertProcess(pc, sessions.sessions, { label: 'live run' })
    results.push(pc)
  }
} catch (err) {
  console.error(`e2e aborted: ${err.message}\nsandbox kept at ${out}`)
  process.exitCode = 1
}
finish()
