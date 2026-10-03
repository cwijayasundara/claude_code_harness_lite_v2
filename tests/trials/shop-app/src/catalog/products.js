// The product catalog: an in-memory list of products keyed by SKU.
export class Catalog {
  #products = new Map()

  add({ sku, name, priceCents }) {
    if (!/^[A-Z]{3}-\d{3}$/.test(sku)) throw new Error(`invalid sku: ${sku}`)
    if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error('priceCents must be a positive integer')
    this.#products.set(sku, { sku, name, priceCents })
    return { sku, name, priceCents }
  }

  get(sku) {
    const p = this.#products.get(sku)
    return p ? { ...p } : null
  }

  list() {
    return [...this.#products.values()].map(p => ({ ...p }))
  }
}
