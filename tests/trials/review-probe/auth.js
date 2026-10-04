// Probe for the sdlc-review end-to-end test: an API-key check.
const KEYS = new Set(['alpha-key', 'beta-key'])

export function isAuthorized(key) {
  if (typeof key !== 'string' || key.length === 0) return false
  return KEYS.has(key)
}
