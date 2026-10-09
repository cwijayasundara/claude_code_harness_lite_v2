import path from 'node:path'

const fx = rel => path.join(import.meta.dirname, '../fixtures/p2', rel)

export const PHASE = {
  id: 'P2', slug: 'coupon', type: 'feature', tier: 'M', title: 'Cart coupon',
  prompt: '/rig-start Add Cart.applyCoupon(code). SAVE10 takes 10% off the cart total; any other code throws an Error whose message contains "unknown coupon". totalCents() then returns the discounted total rounded DOWN to a whole cent; applying a coupon twice keeps a single 10% discount. Everything that worked before must behave the same when no coupon is applied. Include tests.',
  intent: {
    problem: 'Shoppers cannot apply a discount code.',
    outcome: 'applyCoupon(SAVE10) discounts totalCents by 10% rounded down; unknown codes throw; earlier behaviour unchanged.',
    nonGoals: 'More than one coupon code, stacking, expiry.',
    risks: 'Rounding: use integer math, floor to the cent.',
  },
  design: [
    '# Coupon', '', '## Contracts', '- `Cart.applyCoupon(code)`; `totalCents()` reflects the coupon.', '',
    '## Files', '- src/cart.js', '- test/coupon.test.js', '',
    '## Slices', '1. applyCoupon and discounted total (test/coupon.test.js)', '',
    '## Verification', '- npm test', '',
  ].join('\n'),
  tests: [{ src: fx('test/coupon.test.js'), dest: 'test/coupon.test.js' }],
  impl: [{ src: fx('src/cart.js'), dest: 'src/cart.js' }],
  commit: 'feat(cart): apply a SAVE10 coupon',
  acceptance: 'coupon',
}
