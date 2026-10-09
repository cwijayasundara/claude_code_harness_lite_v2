/** Format cents as a currency string. */
export function formatMoney(cents: number): string { return `$${(cents / 100).toFixed(2)}` }
export function pad(s: string, n: number): string { return s.padEnd(n) }
