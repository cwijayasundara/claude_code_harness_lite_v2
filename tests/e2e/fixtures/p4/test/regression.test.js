import test from 'node:test'
import assert from 'node:assert/strict'
import { Cart } from '../src/cart.js'

test('lines() returns copies: mutating a returned line does not change the cart', () => {
  const c = new Cart()
  c.add('A', 100, 2)
  c.lines()[0].qty = 99
  assert.equal(c.totalCents(), 200)
})
