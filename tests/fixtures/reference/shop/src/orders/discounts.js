// Discount codes and their rates.
export const DISCOUNTS = { SAVE10: 0.1, SAVE20: 0.2 }

export const rateFor = code => DISCOUNTS[code]
