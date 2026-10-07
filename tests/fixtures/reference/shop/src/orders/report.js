// Reports over checked-out orders.
export function bestSellers(orders, n) {
  const sold = new Map()
  for (const order of orders) for (const { sku, qty } of order.lines) sold.set(sku, (sold.get(sku) ?? 0) + qty)
  return [...sold].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, n).map(([sku]) => sku)
}
