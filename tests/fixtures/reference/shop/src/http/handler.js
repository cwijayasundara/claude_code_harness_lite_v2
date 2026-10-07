// A transport-agnostic router: handle({ method, path, body }) -> { status, body }
import { Cart } from '../cart/cart.js'
import { checkout } from '../orders/orders.js'
import { bestSellers } from '../orders/report.js'

export function createHandler(catalog) {
  const cart = new Cart(catalog)
  const orders = []
  return function handle({ method, path, body = {} }) {
    const [route, query = ''] = path.split('?')
    try {
      if (method === 'GET' && route === '/products') return { status: 200, body: catalog.list() }
      if (method === 'POST' && route === '/cart') {
        cart.add(body.sku, body.qty)
        return { status: 201, body: cart.lines() }
      }
      if (method === 'POST' && route === '/checkout') {
        const order = checkout(cart, { code: body.code })
        orders.push(order)
        return { status: 201, body: order }
      }
      if (method === 'GET' && route === '/reports/bestsellers') {
        const raw = new URLSearchParams(query).get('n') ?? '3'
        if (!/^[1-9]\d*$/.test(raw)) return { status: 400, body: { error: 'n must be a positive integer' } }
        return { status: 200, body: { skus: bestSellers(orders, Number(raw)) } }
      }
      return { status: 404, body: { error: 'not found' } }
    } catch (err) {
      return { status: 400, body: { error: err.message } }
    }
  }
}
