// Greenfield lane: an in-memory cart library built from an empty directory, then changed twice.
// Each phase's task and its hidden promises live together; a later phase re-checks every earlier promise.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const SCAFFOLD = 'Node.js 22 ESM library, no dependencies, tests with node --test: an in-memory shopping cart'

export const PHASES = [
  {
    id: 'cart',
    task: [
      "Add a Cart class exported from src/cart.js. add(sku, priceCents, qty = 1) adds qty of a SKU (a repeat add of",
      "the same SKU sums the quantity). remove(sku) deletes the whole line and throws an Error for a SKU not in the",
      "cart. lines() returns [{ sku, qty, priceCents }] sorted by sku ascending. totalCents() returns the sum of",
      "priceCents * qty. qty must be a positive integer and priceCents a non-negative integer, otherwise add throws a",
      "RangeError. This is the library's first public API. Include tests.",
    ].join(' '),
  },
  {
    id: 'coupon',
    task: [
      "Add Cart.applyCoupon(code). SAVE10 takes 10% off the cart total, any other code throws an Error whose message",
      "contains 'unknown coupon'. totalCents() then returns the discounted total rounded DOWN to a whole cent;",
      "applying a coupon twice keeps a single 10% discount (it does not stack). Everything that worked before must",
      "behave the same when no coupon is applied. Include tests.",
    ].join(' '),
  },
  {
    id: 'bulk',
    task: [
      "Behaviour change: a line with qty of 10 or more now gets 5% off that line (line total = floor(priceCents * qty",
      "* 95 / 100)), applied before any coupon. This deliberately changes totalCents() for carts that were previously",
      "priced at full price, so update the tests that pinned the old totals. Lines under 10 and the coupon rules are",
      "unchanged.",
    ].join(' '),
  },
]

const throwsOf = (fn, Type = Error) => { try { fn() } catch (e) { return e instanceof Type ? e : null } return null }

async function cartOf(repo, rows) {
  const { Cart } = await import(`${pathToFileURL(path.join(repo, 'src/cart.js')).href}?t=${Date.now()}`)
  const c = new Cart()
  for (const [sku, price, qty] of rows) c.add(sku, price, qty)
  return c
}

const PROMISES = {
  async cart(repo) {
    const c = await cartOf(repo, [['B-2', 250, 2], ['A-1', 100], ['B-2', 250, 1]])
    const want = [{ sku: 'A-1', qty: 1, priceCents: 100 }, { sku: 'B-2', qty: 3, priceCents: 250 }]
    if (!isDeepStrictEqual(c.lines(), want)) return `lines ${JSON.stringify(c.lines())}`
    if (c.totalCents() !== 850) return `total ${c.totalCents()}, want 850`
    if (!throwsOf(() => c.remove('NOPE'))) return 'remove of an absent SKU did not throw'
    c.remove('A-1')
    if (c.totalCents() !== 750) return `total after remove ${c.totalCents()}, want 750`
    for (const bad of [0, -1, 1.5]) if (!throwsOf(() => c.add('X', 10, bad), RangeError)) return `add qty ${bad} did not throw RangeError`
    if (!throwsOf(() => c.add('X', -5), RangeError) || !throwsOf(() => c.add('X', 1.5), RangeError)) return 'bad priceCents did not throw RangeError'
    return true
  },
  async coupon(repo) {
    const c = await cartOf(repo, [['A-1', 1999]])
    c.applyCoupon('SAVE10')
    if (c.totalCents() !== 1799) return `SAVE10 on 1999 gave ${c.totalCents()}, want 1799`
    c.applyCoupon('SAVE10')
    if (c.totalCents() !== 1799) return `second SAVE10 stacked: ${c.totalCents()}`
    const e = throwsOf(() => c.applyCoupon('BOGUS'))
    if (!e || !/unknown coupon/i.test(e.message)) return 'unknown coupon did not throw "unknown coupon"'
    return true
  },
  async bulk(repo) {
    const a = await cartOf(repo, [['A-1', 100, 10]])
    if (a.totalCents() !== 950) return `qty 10 at 100 gave ${a.totalCents()}, want 950`
    const b = await cartOf(repo, [['A-1', 100, 9]])
    if (b.totalCents() !== 900) return `qty 9 at 100 gave ${b.totalCents()}, want 900`
    const c = await cartOf(repo, [['A-1', 333, 10], ['B-2', 50, 2]])
    if (c.totalCents() !== 3263) return `mixed cart gave ${c.totalCents()}, want 3263`
    c.applyCoupon('SAVE10')
    if (c.totalCents() !== Math.floor(3263 * 90 / 100)) return `coupon after bulk gave ${c.totalCents()}, want ${Math.floor(3263 * 90 / 100)}`
    const d = await cartOf(repo, [['A-1', 100, 5], ['A-1', 100, 5]])
    if (d.totalCents() !== 950) return `repeat adds summing to 10 gave ${d.totalCents()}, want 950`
    return true
  },
}

export async function assertCart(c, repo, phase) {
  const upTo = PHASES.findIndex(p => p.id === phase)
  if (upTo === -1) throw new Error(`unknown cart phase: ${phase}`)
  for (const p of PHASES.slice(0, upTo + 1)) {
    await c.check(`${p.id === phase ? 'hidden acceptance' : 'no regression'}: ${p.id}`, () => PROMISES[p.id](repo))
  }
}
