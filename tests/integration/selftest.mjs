// Proves the integration test's own parts at no model cost: the sandbox, the stub gh, the oracle and every assertion.
// It plays the model with scripted onboarding and a scripted tier M feature built from tests/fixtures/reference, then
// checks that known-good trees pass and that seeded-bad trees fail the assertion meant to catch them.
// Usage: node tests/integration/selftest.mjs [--out DIR]   (exit 1 on any unexpected result)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Checks } from './lib/checks.mjs'
import { createSandbox, FIXTURES } from './lib/sandbox.mjs'
import { assertOnboarding } from './assert/onboarding.mjs'
import { assertChange } from './assert/change.mjs'
import { assertPreCommitRefusesSecret, assertPrePushPasses } from './assert/hooks.mjs'
import { assertCart } from './acceptance/cart.mjs'
import { assertShop, MODULES, PHASES as SHOP } from './acceptance/shop.mjs'

const outArg = process.argv.indexOf('--out')
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'rig-selftest-'))
const REF = path.join(FIXTURES, 'reference')
const OPERATOR = 'operator'
const surprises = []

// Every check in `c` must pass, except those matching `failing`, which must fail.
function expect(c, failing = []) {
  c.print()
  for (const r of c.results) {
    const shouldFail = failing.some(re => re.test(r.name))
    const got = `${r.status}${r.why ? ` (${r.why})` : ''}`
    if (shouldFail !== (r.status === 'FAIL')) surprises.push(`${c.title}: ${r.name} ${got}, expected ${shouldFail ? 'FAIL' : 'PASS'}`)
  }
  for (const re of failing) if (!c.results.some(r => re.test(r.name))) surprises.push(`${c.title}: no check matched ${re}`)
}

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`)
  return r.stdout
}

// What `/rig:init --defaults` does, minus the model: sensors, stack levels, standalone install, preflight, CLAUDE.md.
function onboard(sb, claudeMd) {
  must(sb.sdlc(['init']), 'init')
  sb.write('.sdlc/sensors.json', JSON.stringify({ fast: { test: 'npm test' }, full: { test: 'npm test' } }, null, 2) + '\n')
  must(sb.sdlc(['init', '--stack']), 'init --stack')
  must(sb.sdlc(['init', '--full']), 'init --full')
  sb.write('CLAUDE.md', claudeMd)
  sb.commitAll('chore: onboard rig')
  must(sb.sdlc(['preflight', '--answers', '{"gates":"default","valueRate":"100","consumers":"none"}']), 'preflight')
  sb.commitAll('chore: preflight report')
}

const ROUTING = 'sdlc routes all work in this repo: start with /rig:start; use superpowers skills only when an sdlc skill names one.'
const claudeMd = (title, map) => `# ${title}\n\n${ROUTING}\n\n## Map\n${map.map(m => `- src/${m}/`).join('\n')}\n`

// A scripted tier M feature through the whole route, the way the skills drive it.
function shipBestsellers(sb) {
  const slug = 'bestsellers'
  const dir = `.sdlc/changes/${slug}`
  sb.git('checkout', '-q', '-b', `sdlc/${slug}`)
  must(sb.sdlc(['new', slug, '--type', 'feature', '--tier', 'M']), 'new')
  sb.write(`${dir}/design.md`, [
    '# Best sellers', '', '## Contracts', '- GET /reports/bestsellers?n=<n> returns 200 { skus } or 400 { error }', '',
    '## Files', '- src/orders/report.js', '- src/http/handler.js', '- test/report.test.js', '',
    '## Slices', '1. report and route: bestSellers plus the GET route (test/report.test.js)', '',
    '## Verification', '- npm test', '',
  ].join('\n'))
  must(sb.sdlc(['approve', slug, 'design', '--by', OPERATOR], { human: true }), 'approve design')
  fs.copyFileSync(path.join(REF, 'shop/test/report.test.js'), sb.file('test/report.test.js'))
  must(sb.sdlc(['run', '--slug', slug, '--expect-fail', '--', 'npm test']), 'red run')
  for (const f of ['src/orders/report.js', 'src/http/handler.js']) fs.copyFileSync(path.join(REF, 'shop', f), sb.file(f))
  must(sb.sdlc(['run', '--slug', slug, '--', 'npm test']), 'green run')
  must(sb.sdlc(['ratchet', 'record', slug, 'build', '--slice', '1', '--checks']), 'record slice 1')
  must(sb.sdlc(['verify', slug]), 'verify')
  must(sb.sdlc(['quality', slug]), 'quality')
  must(sb.sdlc(['pr', slug, '--message', 'feat(orders): best-sellers report']), 'pr')
  sb.write(`${dir}/review-pr.md`, 'verdict: pass\n')
  sb.write(`${dir}/review.md`, '---\nresult: pass\nrounds: 1\ncaught: 0\n---\n# Review\n\nNo findings.\n')
  must(sb.sdlc(['ratchet', 'record', slug, 'pr-review', '--from', `${dir}/review-pr.md`]), 'record pr-review')
  must(sb.sdlc(['pr-checks', slug]), 'pr-checks')
  return slug
}

// ---------- brownfield: the shop ----------
const shop = createSandbox({ name: 'shop', out: OUT })
shop.copyFixture('shop-app')
shop.commitAll('initial')
shop.isolate([])

{
  const c = new Checks('shop acceptance on the untouched fixture')
  await assertShop(c, shop.dir, 'bestsellers')
  expect(c, [/hidden acceptance: bestsellers/, /no regression: refactor/])
}
{
  const { file, from, to } = SHOP[0].seed
  const original = shop.read(file)
  shop.write(file, original.replace(from, to))
  const c = new Checks('shop acceptance on the seeded SAVE20 bug')
  await assertShop(c, shop.dir, 'bugfix')
  expect(c, [/hidden acceptance: bugfix/])
  shop.write(file, original)
}

onboard(shop, claudeMd('shop-app', MODULES))
{
  const c = new Checks('shop onboarding')
  await assertOnboarding(c, shop, { lane: 'brownfield', modules: MODULES })
  expect(c)
}

const slug = shipBestsellers(shop)
{
  const c = new Checks('shop change: scripted tier M feature')
  await assertChange(c, shop, slug, { operator: OPERATOR, label: slug })
  await assertPrePushPasses(c, shop, slug)
  await assertPreCommitRefusesSecret(c, shop)
  const reference = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-shop-ref-'))
  fs.cpSync(path.join(FIXTURES, 'shop-app'), reference, { recursive: true })
  fs.cpSync(path.join(REF, 'shop'), reference, { recursive: true })
  await assertShop(c, reference, 'bestsellers')
  expect(c)
}

// Seeded-bad evidence: each must trip the assertion written to catch it.
{
  const approvals = shop.read('.sdlc/approvals.jsonl')
  shop.write('.sdlc/approvals.jsonl', '')
  shop.write('stray.txt', 'left behind\n')
  const c = new Checks('shop change with its approval removed and a stray file')
  await assertChange(c, shop, slug, { operator: OPERATOR, label: slug })
  // CI still passes here: it judges the committed rows, and rig-check never requires a gated change to carry its approvals.
  expect(c, [/approved exactly the gates/, /done \(nothing left/, /tree clean/, /no scope drift/])
  shop.write('.sdlc/approvals.jsonl', approvals)
  fs.rmSync(shop.file('stray.txt'))
}
{
  const c = new Checks('shop change judged as someone else\'s approval')
  await assertChange(c, shop, slug, { operator: 'someone-else', label: slug })
  expect(c, [/every approval is the operator's/])
}

// ---------- greenfield: the cart ----------
const cart = createSandbox({ name: 'cart', out: OUT })
cart.isolate([])
const scripts = { test: 'node --test', 'test-fast': 'node --test', lint: 'node --check src/index.js' }
cart.write('package.json', JSON.stringify({ name: 'cart', version: '0.1.0', type: 'module', scripts }, null, 2) + '\n')
cart.write('src/index.js', 'export {}\n')
cart.write('test/smoke.test.js', "import { test } from 'node:test'\nimport '../src/index.js'\ntest('loads', () => {})\n")
cart.commitAll('chore: scaffold')
{
  const c = new Checks('cart acceptance before any code')
  await assertCart(c, cart.dir, 'cart')
  expect(c, [/hidden acceptance: cart/])
}
onboard(cart, claudeMd('cart', ['cart']))
{
  const c = new Checks('cart onboarding')
  await assertOnboarding(c, cart, { lane: 'greenfield' })
  expect(c)
}
{
  fs.cpSync(path.join(REF, 'cart'), cart.dir, { recursive: true })
  const c = new Checks('cart acceptance on the reference solution')
  await assertCart(c, cart.dir, 'bulk')
  expect(c)
}

console.log(`\nsandboxes in ${OUT}`)
if (surprises.length) {
  console.log(`\nselftest: ${surprises.length} unexpected result(s):\n${surprises.map(s => `  - ${s}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('selftest: every assertion behaved as expected')
}
