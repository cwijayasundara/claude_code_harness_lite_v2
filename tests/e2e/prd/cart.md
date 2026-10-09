# PRD: shopping cart library

Build a Node.js 22 ESM library, no dependencies, tests with `node --test`: an in-memory shopping cart.

- `Cart.add(sku, priceCents, qty = 1)`: a repeat add of the same SKU sums the quantity.
- `Cart.remove(sku)`: deletes the whole line; throws `Error` for a SKU not in the cart.
- `Cart.lines()`: `[{ sku, qty, priceCents }]` sorted by sku ascending.
- `Cart.totalCents()`: sum of `priceCents * qty`.
- `qty` must be a positive integer and `priceCents` a non-negative integer, otherwise `add` throws `RangeError`.
- This is the library's first public API. Include tests.
