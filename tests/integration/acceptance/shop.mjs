// Brownfield lane: tests/fixtures/shop-app (catalog, cart, orders, http), changed three times.
// Each phase's setup, task and hidden promises live together; a later phase re-checks every earlier promise.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MODULES = ['catalog', 'cart', 'orders', 'http']

export const PHASES = [
  {
    id: 'bugfix',
    // The bug the operator plants as an ordinary trunk commit before the change starts.
    seed: { file: 'src/orders/orders.js', from: 'SAVE20: 0.2', to: 'SAVE20: 0.02', message: 'pricing update' },
    task: 'Bug in payments: checkout with discount code SAVE20 takes only 2% off instead of 20%. Customers are being overcharged.',
  },
  {
    id: 'refactor',
    task: [
      "Refactor: move the discount codes out of src/orders/orders.js into a new src/orders/discounts.js that exports",
      "DISCOUNTS and rateFor(code) (returns the rate, or undefined for an unknown code). Checkout behaviour must not",
      "change.",
    ].join(' '),
  },
  {
    id: 'bestsellers',
    task: [
      "Add a best-sellers report. Export bestSellers(orders, n) from a new src/orders/report.js: orders is an array",
      "of { lines: [{ sku, qty }] }; it returns the n SKU strings with the highest total quantity sold, most first,",
      "ties broken by SKU ascending, and [] for no orders. The HTTP handler keeps every successful checkout and",
      "serves GET /reports/bestsellers?n=<n> as 200 { skus } using bestSellers; n defaults to 3 and must be a",
      "positive integer, otherwise 400 { error }. Include tests.",
    ].join(' '),
  },
]

const load = (repo, rel) => import(`${pathToFileURL(path.join(repo, rel)).href}?t=${Date.now()}`)

async function shop(repo) {
  const { Catalog } = await load(repo, 'src/catalog/products.js')
  const { Cart } = await load(repo, 'src/cart/cart.js')
  const { checkout } = await load(repo, 'src/orders/orders.js')
  const catalog = new Catalog()
  for (const [sku, priceCents] of [['TEA-001', 450], ['MUG-002', 1000], ['CUP-003', 300]]) catalog.add({ sku, name: sku, priceCents })
  return { catalog, Cart, checkout }
}

const PROMISES = {
  async bugfix(repo) {
    const { catalog, Cart, checkout } = await shop(repo)
    const cart = new Cart(catalog)
    cart.add('MUG-002')
    const s20 = checkout(cart, { code: 'SAVE20' }).totalCents
    const s10 = checkout(cart, { code: 'SAVE10' }).totalCents
    return (s20 === 800 && s10 === 900) || `SAVE20 gave ${s20} (want 800), SAVE10 gave ${s10} (want 900)`
  },
  async refactor(repo) {
    const { rateFor, DISCOUNTS } = await load(repo, 'src/orders/discounts.js')
    if (rateFor('SAVE10') !== 0.1 || rateFor('SAVE20') !== 0.2 || rateFor('NOPE') !== undefined || !DISCOUNTS) return 'rateFor or DISCOUNTS wrong'
    const { readFileSync } = await import('node:fs')
    if (/SAVE10\s*:/.test(readFileSync(path.join(repo, 'src/orders/orders.js'), 'utf8'))) return 'codes still defined in orders.js'
    const { catalog, Cart, checkout } = await shop(repo)
    const cart = new Cart(catalog)
    cart.add('MUG-002', 2)
    let unknown = false
    try { checkout(cart, { code: 'FREE' }) } catch (err) { unknown = /unknown discount/.test(err.message) }
    return (checkout(cart, { code: 'SAVE10' }).totalCents === 1800 && checkout(cart).totalCents === 2000 && unknown) || 'checkout behaviour changed'
  },
  async bestsellers(repo) {
    const { bestSellers } = await load(repo, 'src/orders/report.js')
    const orders = [
      { lines: [{ sku: 'TEA-001', qty: 2 }, { sku: 'MUG-002', qty: 1 }] },
      { lines: [{ sku: 'MUG-002', qty: 1 }, { sku: 'CUP-003', qty: 2 }] },
      { lines: [{ sku: 'TEA-001', qty: 1 }] },
    ]
    const top = bestSellers(orders, 2)
    if (JSON.stringify(top) !== JSON.stringify(['TEA-001', 'CUP-003'])) return `bestSellers gave ${JSON.stringify(top)}, want ["TEA-001","CUP-003"]`
    if (JSON.stringify(bestSellers([], 3)) !== '[]') return 'bestSellers([]) is not []'
    const { createHandler } = await load(repo, 'src/http/handler.js')
    const { catalog } = await shop(repo)
    const h = createHandler(catalog)
    h({ method: 'POST', path: '/cart', body: { sku: 'CUP-003', qty: 3 } })
    h({ method: 'POST', path: '/cart', body: { sku: 'TEA-001', qty: 1 } })
    h({ method: 'POST', path: '/checkout', body: {} })
    const ok = h({ method: 'GET', path: '/reports/bestsellers?n=1' })
    if (ok.status !== 200 || JSON.stringify(ok.body?.skus) !== '["CUP-003"]') return `GET ?n=1 gave ${ok.status} ${JSON.stringify(ok.body)}`
    for (const bad of ['0', '-2', 'x', '1.5']) {
      const r = h({ method: 'GET', path: `/reports/bestsellers?n=${bad}` })
      if (r.status !== 400) return `GET ?n=${bad} gave ${r.status}, want 400`
    }
    return true
  },
}

export async function assertShop(c, repo, phase) {
  const upTo = PHASES.findIndex(p => p.id === phase)
  if (upTo === -1) throw new Error(`unknown shop phase: ${phase}`)
  for (const p of PHASES.slice(0, upTo + 1)) {
    await c.check(`${p.id === phase ? 'hidden acceptance' : 'no regression'}: ${p.id}`, () => PROMISES[p.id](repo))
  }
}
