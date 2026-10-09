import test from 'node:test'
import assert from 'node:assert/strict'
import { Cart } from '../src/cart.js'

test('repeat add sums qty and lines are sorted by sku', () => {
  const c = new Cart()
  c.add('B', 200)
  c.add('A', 100, 2)
  c.add('A', 100)
  assert.deepEqual(c.lines(), [{ sku: 'A', qty: 3, priceCents: 100 }, { sku: 'B', qty: 1, priceCents: 200 }])
  assert.equal(c.totalCents(), 500)
})

test('remove deletes the line and throws for an unknown sku', () => {
  const c = new Cart()
  c.add('A', 100)
  c.remove('A')
  assert.equal(c.lines().length, 0)
  assert.throws(() => c.remove('A'), Error)
})

test('add rejects bad qty and price with RangeError', () => {
  const c = new Cart()
  assert.throws(() => c.add('A', 100, 0), RangeError)
  assert.throws(() => c.add('A', 100, 1.5), RangeError)
  assert.throws(() => c.add('A', -1), RangeError)
})
