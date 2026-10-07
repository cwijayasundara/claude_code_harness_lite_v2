// Reference cart after all three greenfield phases: lines, coupon, bulk discount.
const COUPONS = { SAVE10: 0.1 }

export class Cart {
  #lines = new Map()
  #coupon = null

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

  applyCoupon(code) {
    if (!(code in COUPONS)) throw new Error(`unknown coupon: ${code}`)
    this.#coupon = code
  }

  totalCents() {
    const gross = this.lines().reduce((n, l) => n + (l.qty >= 10 ? Math.floor(l.priceCents * l.qty * 95 / 100) : l.priceCents * l.qty), 0)
    return this.#coupon ? Math.floor(gross * (1 - COUPONS[this.#coupon])) : gross
  }
}
