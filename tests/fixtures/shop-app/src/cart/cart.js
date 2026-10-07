// A shopping cart: quantities per SKU, priced from the catalog.
export class Cart {
  #lines = new Map()

  constructor(catalog) {
    this.catalog = catalog
  }

  add(sku, qty = 1) {
    if (!this.catalog.get(sku)) throw new Error(`unknown sku: ${sku}`)
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('qty must be a positive integer')
    this.#lines.set(sku, (this.#lines.get(sku) ?? 0) + qty)
  }

  lines() {
    return [...this.#lines].map(([sku, qty]) => ({ sku, qty, unitCents: this.catalog.get(sku).priceCents }))
  }

  subtotalCents() {
    return this.lines().reduce((sum, l) => sum + l.qty * l.unitCents, 0)
  }
}
