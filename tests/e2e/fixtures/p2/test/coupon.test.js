import test from 'node:test'
import assert from 'node:assert/strict'
import { Cart } from '../src/cart.js'

test('SAVE10 takes 10% off, rounded down', () => {
  const c = new Cart()
  c.add('A', 1999)
  c.applyCoupon('SAVE10')
  assert.equal(c.totalCents(), 1799)
})

test('applying a coupon twice does not stack', () => {
  const c = new Cart()
  c.add('A', 1000)
  c.applyCoupon('SAVE10')
  c.applyCoupon('SAVE10')
  assert.equal(c.totalCents(), 900)
})

test('an unknown coupon throws', () => {
  assert.throws(() => new Cart().applyCoupon('NOPE'), /unknown coupon/)
})
