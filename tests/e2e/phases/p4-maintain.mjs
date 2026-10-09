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

export async function runMaintain(sb, driver, phase = PHASE) {
  const out = []
  const w = new Checks('P4 maintain: watch')
  await assertWatch(w, sb)
  sb.commitAll('chore: watch band, history and breach intent')
  out.push(w)

  // Seed the escaped bug on main, as if it had shipped, then record the incident.
  sb.write('src/cart.js', sb.read('src/cart.js').replace('.map(l => ({ ...l }))', ''))
  sb.commitAll('chore: seed the lines() leak (simulates the escaped bug)')
  sb.write(INCIDENT, [
    '---', 'class: shared-state', 'severity: sev3', 'escaped: true', `detected: ${new Date().toISOString()}`,
    'restored:', `intent_at: ${new Date().toISOString()}`, '---', '', 'Symptoms: totals drift after callers edit lines().', 'Impact: wrong totals.', 'Evidence: see test/regression.test.js.', '',
  ].join('\n'))
  sb.commitAll('docs: incident record')
  const i = new Checks('P4 maintain: incident')
  await assertIncident(i, sb, INCIDENT)
  out.push(i)

  const slug = await driver.begin()
  const route = await runRoute({ sb, slug, driver })
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
    return (f && JSON.parse(sb.read(f)).source === `incident:${phase.incident.file}`) || 'no incident eval with the incident as its source'
  })
  await assertCart(c, sb.dir, phase.acceptance)
  out.push(c)

  const m = new Checks('P4 maintain: metrics')
  await assertRestoredMetrics(m, sb, INCIDENT)
  out.push(m)
  return { checks: out, route, slug }
}
