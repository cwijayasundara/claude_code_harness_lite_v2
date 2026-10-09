import fs from 'node:fs'
import path from 'node:path'
import { Checks } from '../../integration/lib/checks.mjs'
import { assertChange } from '../../integration/assert/change.mjs'
import { assertCart } from '../../integration/acceptance/cart.mjs'
import { runRoute } from '../lib/operator.mjs'
import { assertWatch, assertIncident, assertRestoredMetrics } from '../assert/maintain.mjs'

const fx = rel => path.join(import.meta.dirname, '../fixtures/p4', rel)
export const INCIDENT = '.sdlc/incidents/20261009-lines-leak-internal-state.md'

export const PHASE = {
  id: 'P4', slug: 'lines-copy', type: 'incident', tier: 'M', title: 'lines() leaks internal state',
  prompt: '/rig-incident "Cart.lines() returns live internal objects; a caller mutating a line changes the cart total" --escaped',
  intent: {
    problem: `Callers that mutate a line returned by lines() silently change the cart. Incident: ${INCIDENT}`,
    outcome: 'lines() returns copies; a regression test pins it.',
    nonGoals: 'Freezing the objects.',
    risks: 'none',
  },
  design: '',
  incident: { date: '20261009', class: 'shared-state', file: '20261009-lines-leak-internal-state.md', symptoms: 'Cart.lines() returns live internal objects, so a caller that mutates a returned line changes the cart total.' },
  tests: [{ src: fx('test/regression.test.js'), dest: 'test/regression.test.js' }],
  impl: [{ src: fx('src/cart.js'), dest: 'src/cart.js' }],
  commit: 'fix(cart): lines() returns copies',
  acceptance: 'coupon',
}

const newestIncident = sb => {
  const names = sb.run('sh', ['-c', 'ls -t .sdlc/incidents/*.md 2>/dev/null']).stdout.trim().split('\n').filter(Boolean)
  return names[0] ?? ''
}
const c0 = (c, file) => c.check('incident: /rig-incident (or the fixture) left an incident file', () => Boolean(file) || 'no file under .sdlc/incidents')

export async function runMaintain(sb, driver, phase = PHASE) {
  const out = []
  const w = new Checks('P4 maintain: watch')
  await assertWatch(w, sb)
  sb.commitAll('chore: watch band, history and breach intent')
  out.push(w)

  // Seed the escaped bug on main, as if it had shipped, then record the incident.
  // Reset to the known-good fixture set (cart and its tests) with the one bug seeded. Replacing only the code would leave the model's own
  // P1/P2 tests, which assert behaviour the fixture cart does not have, so the baseline would be red for reasons unrelated to the incident.
  const good = fs.readFileSync(fx('src/cart.js'), 'utf8')
  const buggy = good.replace('.map(l => ({ ...l }))', '')
  if (buggy === good) throw new Error('P4: the bug seed did not change src/cart.js')
  sb.write('src/cart.js', buggy)
  // The smoke test stays: the scaffold's lint script checks it by name.
  for (const f of sb.run('sh', ['-c', 'ls test/*.test.js 2>/dev/null']).stdout.split('\n').filter(f => f && !f.endsWith('smoke.test.js'))) fs.rmSync(sb.file(f))
  fs.mkdirSync(sb.file('test'), { recursive: true })
  for (const [src, dest] of [[path.join(import.meta.dirname, '../fixtures/p1/test/cart.test.js'), 'test/cart.test.js'], [path.join(import.meta.dirname, '../fixtures/p2/test/coupon.test.js'), 'test/coupon.test.js']]) fs.copyFileSync(src, sb.file(dest))
  sb.commitAll('chore: seed the lines() leak (simulates the escaped bug), on the known-good cart and tests')
  const live = Boolean(driver.sessions)
  // Scripted: the incident file is written here. Live: /rig-incident writes it, and the newest file under .sdlc/incidents is judged.
  if (!live) {
    sb.write(INCIDENT, [
      '---', 'class: shared-state', 'severity: sev3', 'escaped: true', `detected: ${new Date().toISOString()}`,
      'restored:', `intent_at: ${new Date().toISOString()}`, '---', '', 'Symptoms: totals drift after callers edit lines().', 'Impact: wrong totals.', 'Evidence: see test/regression.test.js.', '',
    ].join('\n'))
    sb.commitAll('docs: incident record')
  }

  const slug = await driver.begin()
  const incidentFile = live ? newestIncident(sb) : INCIDENT
  const i = new Checks('P4 maintain: incident')
  await c0(i, incidentFile)
  await assertIncident(i, sb, incidentFile)
  out.push(i)
  const route = await runRoute({ sb, slug, driver, repeats: driver.sessions ? 2 : 1, maxSteps: driver.sessions ? 14 : 10 })
  const c = new Checks('P4 maintain: incident fix')
  // Known gap, pinned so a fix flips it: /rig-pr stages only .sdlc/changes/<slug> and a fixed list, never .sdlc/evals, so the
  // incident eval diagnose writes is left untracked after the ship. A person commits it onto the branch.
  await c.check('known gap: /rig-pr leaves the incident eval untracked (see the plan ledger)', () =>
    sb.git('status', '--porcelain', '--', '.sdlc/evals').includes('??') || 'the eval was committed by /rig-pr: the gap is fixed, update this check')
  sb.git('add', '.sdlc/evals')
  sb.git('commit', '-q', '--no-verify', '-m', 'chore: commit the incident eval')
  await assertChange(c, sb, slug, { label: slug })
  await c.check('P4: the regression test ran red before the fix', () => /"expectFail":\s*true/.test(sb.read(`.sdlc/changes/${slug}/runs.jsonl`)) || 'no red run recorded')
  await c.check('P4: the incident became a regression eval naming the incident', () => {
    const f = sb.run('sh', ['-c', 'ls .sdlc/evals/incident-*.json 2>/dev/null']).stdout.trim().split('\n')[0]
    return (f && JSON.parse(sb.read(f)).source === `incident:${incidentFile.split('/').pop()}`) || 'no incident eval with the incident as its source'
  })
  await assertCart(c, sb.dir, phase.acceptance)
  out.push(c)

  const m = new Checks('P4 maintain: metrics')
  await assertRestoredMetrics(m, sb, incidentFile)
  out.push(m)
  return { checks: out, route, slug }
}
