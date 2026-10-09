import { formatMoney } from '../util/format.js'
import { login } from '../auth/login.js'
/** Compute an invoice total from line items. */
export function invoiceTotal(items: { cents: number; qty: number }[]): number { return items.reduce((t, i) => t + i.cents * i.qty, 0) }
export function renderInvoice(user: string, items: { cents: number; qty: number }[]): string { return login(user, 'x') ? formatMoney(invoiceTotal(items)) : '' }
