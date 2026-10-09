// node tests/e2e/run.mjs [--driver scripted|live] [--phase P0|P1|P2|P3|P4] [--keep] [--out DIR]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSandbox } from '../integration/lib/sandbox.mjs'
import { writeReport } from './lib/report.mjs'
import { install } from './phases/p0-install.mjs'
import { PHASE as P1, runChange } from './phases/p1-greenfield.mjs'
import { scriptedDriver } from './driver/scripted.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const driverName = arg('driver', 'scripted')
const only = arg('phase')
const out = path.resolve(arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'rig-e2e-'))))
if (driverName !== 'scripted') throw new Error('live driver arrives in Task 8')

const sb = createSandbox({ name: 'project', out })
const results = []
const want = id => !only || only === id
const finish = () => {
  writeReport(out, results)
  for (const c of results) c.print()
  console.log(`\nreport and sandbox: ${out}`)
  process.exitCode = results.some(c => c.failed.length) ? 1 : process.exitCode ?? 0
}

try {
  results.push(await install(sb))
  if (want('P1')) results.push((await runChange(sb, P1, scriptedDriver(sb, P1), { first: true })).checks)
} catch (err) {
  console.error(`e2e aborted: ${err.message}\nsandbox kept at ${out}`)
  process.exitCode = 1
}
finish()
