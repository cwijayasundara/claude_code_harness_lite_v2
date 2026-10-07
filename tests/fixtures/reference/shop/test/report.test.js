import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestSellers } from '../src/orders/report.js'
import { Catalog } from '../src/catalog/products.js'
import { createHandler } from '../src/http/handler.js'

test('bestSellers ranks by quantity, ties by sku', () => {
  const orders = [{ lines: [{ sku: 'B', qty: 2 }, { sku: 'A', qty: 2 }] }, { lines: [{ sku: 'C', qty: 1 }] }]
  assert.deepEqual(bestSellers(orders, 2), ['A', 'B'])
  assert.deepEqual(bestSellers([], 3), [])
})

test('GET /reports/bestsellers serves the report and rejects a bad n', () => {
  const catalog = new Catalog()
  catalog.add({ sku: 'TEA-001', name: 'Tea', priceCents: 450 })
  const h = createHandler(catalog)
  h({ method: 'POST', path: '/cart', body: { sku: 'TEA-001', qty: 2 } })
  h({ method: 'POST', path: '/checkout', body: {} })
  assert.deepEqual(h({ method: 'GET', path: '/reports/bestsellers?n=1' }).body, { skus: ['TEA-001'] })
  assert.equal(h({ method: 'GET', path: '/reports/bestsellers?n=0' }).status, 400)
})
