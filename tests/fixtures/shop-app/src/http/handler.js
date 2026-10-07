// A transport-agnostic router: handle({ method, path, body }) -> { status, body }
import { Cart } from '../cart/cart.js'
import { checkout } from '../orders/orders.js'

export function createHandler(catalog) {
  const cart = new Cart(catalog)
  return function handle({ method, path, body = {} }) {
    try {
      if (method === 'GET' && path === '/products') return { status: 200, body: catalog.list() }
      if (method === 'POST' && path === '/cart') {
        cart.add(body.sku, body.qty)
        return { status: 201, body: cart.lines() }
      }
      if (method === 'POST' && path === '/checkout') return { status: 201, body: checkout(cart, { code: body.code }) }
      return { status: 404, body: { error: 'not found' } }
    } catch (err) {
      return { status: 400, body: { error: err.message } }
    }
  }
}
