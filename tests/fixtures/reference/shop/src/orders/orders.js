// Orders: a checkout freezes a cart into an order and applies at most one discount code.
import { rateFor } from './discounts.js'

export function checkout(cart, { code } = {}) {
  const lines = cart.lines()
  if (!lines.length) throw new Error('cart is empty')
  const subtotal = cart.subtotalCents()
  const rate = code ? rateFor(code) : 0
  if (rate === undefined) throw new Error(`unknown discount code: ${code}`)
  const discount = Math.round(subtotal * rate)
  return { lines, subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount }
}
