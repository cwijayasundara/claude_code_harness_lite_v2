import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Catalog } from '../src/catalog/products.js'
import { Cart } from '../src/cart/cart.js'
import { checkout } from '../src/orders/orders.js'
import { createHandler } from '../src/http/handler.js'

const catalog = () => {
  const c = new Catalog()
  c.add({ sku: 'TEA-001', name: 'Green tea', priceCents: 450 })
  c.add({ sku: 'MUG-002', name: 'Mug', priceCents: 1200 })
  return c
}

test('catalog rejects bad SKUs and prices', () => {
  assert.throws(() => new Catalog().add({ sku: 'tea', name: 'x', priceCents: 1 }), /invalid sku/)
  assert.throws(() => new Catalog().add({ sku: 'TEA-001', name: 'x', priceCents: 0 }), /positive/)
})

test('cart sums quantities and prices', () => {
  const cart = new Cart(catalog())
  cart.add('TEA-001', 2)
  cart.add('MUG-002')
  cart.add('TEA-001')
  assert.equal(cart.subtotalCents(), 3 * 450 + 1200)
})

test('checkout applies a known discount and rejects unknown codes', () => {
  const cart = new Cart(catalog())
  cart.add('MUG-002', 2)
  assert.equal(checkout(cart, { code: 'SAVE10' }).totalCents, 2160)
  assert.throws(() => checkout(cart, { code: 'FREE' }), /unknown discount/)
  assert.throws(() => checkout(new Cart(catalog())), /empty/)
})

test('http handler wires catalog, cart and checkout', () => {
  const h = createHandler(catalog())
  assert.equal(h({ method: 'GET', path: '/products' }).body.length, 2)
  assert.equal(h({ method: 'POST', path: '/cart', body: { sku: 'TEA-001', qty: 2 } }).status, 201)
  assert.equal(h({ method: 'POST', path: '/checkout', body: {} }).body.totalCents, 900)
  assert.equal(h({ method: 'POST', path: '/cart', body: { sku: 'NOPE-999' } }).status, 400)
})
