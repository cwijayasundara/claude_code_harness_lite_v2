export class Cart {
  #lines = new Map()

  add(sku, priceCents, qty = 1) {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError('qty must be a positive integer')
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new RangeError('priceCents must be a non-negative integer')
    const line = this.#lines.get(sku)
    this.#lines.set(sku, { sku, priceCents, qty: (line?.qty ?? 0) + qty })
  }

  remove(sku) {
    if (!this.#lines.delete(sku)) throw new Error(`not in cart: ${sku}`)
  }

  lines() {
    return [...this.#lines.values()].sort((a, b) => (a.sku < b.sku ? -1 : 1)).map(l => ({ ...l }))
  }

  totalCents() {
    return this.lines().reduce((n, l) => n + l.priceCents * l.qty, 0)
  }
}
