import fs from 'node:fs'
import path from 'node:path'
import { Checks } from '../../integration/lib/checks.mjs'
import { assertChange } from '../../integration/assert/change.mjs'
import { assertPrePushPasses, assertPreCommitRefusesSecret } from '../../integration/assert/hooks.mjs'
import { assertCart } from '../../integration/acceptance/cart.mjs'
import { runRoute } from '../lib/operator.mjs'

const fx = rel => path.join(import.meta.dirname, '../fixtures/p1', rel)
export const PRD = fs.readFileSync(path.join(import.meta.dirname, '../prd/cart.md'), 'utf8')

export const PHASE = {
  id: 'P1', slug: 'cart', type: 'greenfield', tier: 'M', title: 'Shopping cart library',
  prompt: `/rig-start ${PRD.replace(/\n+/g, ' ')}`,
  intent: {
    problem: 'There is no cart library yet; shops need an in-memory cart with exact integer-cent totals.',
    outcome: 'Cart add/remove/lines/totalCents behave per the PRD; node --test passes.',
    nonGoals: 'Coupons, discounts, persistence.',
    risks: 'none: first public API, so names are the contract.',
  },
  design: [
    '# Cart', '', '## Contracts', '- `Cart` exported from src/cart.js: add, remove, lines, totalCents.', '',
    '## Files', '- src/cart.js', '- test/cart.test.js', '',
    '## Slices', '1. Cart: add/remove/lines/totalCents (test/cart.test.js)', '',
    '## Verification', '- npm test', '',
  ].join('\n'),
  tests: [{ src: fx('test/cart.test.js'), dest: 'test/cart.test.js' }],
  impl: [{ src: fx('src/cart.js'), dest: 'src/cart.js' }],
  commit: 'feat(cart): add the Cart class',
  acceptance: 'cart',
}

// Runs one change through the route and asserts it. `driver` is scripted or live.
export async function runChange(sb, phase, driver, { operator = 'operator', first = false } = {}) {
  const slug = await driver.begin()
  const route = await runRoute({ sb, slug, driver, repeats: driver.sessions ? 2 : 1, maxSteps: driver.sessions ? 14 : 10 })
  const c = new Checks(`${phase.id} ${phase.title}`)
  await assertChange(c, sb, slug, { operator, label: slug })
  await c.check(`${phase.id}: the operator resolved ${route.resolvedConcerns} policy concern(s) the design gate listed`, () => true)
  await c.check(`${phase.id}: approved at least one gate`, () => route.approved.length > 0 || 'no human gate was approved')
  if (first) {
    await assertPrePushPasses(c, sb, slug)
    await assertPreCommitRefusesSecret(c, sb)
  }
  await assertCart(c, sb.dir, phase.acceptance)
  return { slug, route, checks: c }
}
