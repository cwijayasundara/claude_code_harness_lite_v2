// Probe for the sdlc-review end-to-end test: an API-key check.
const KEYS = new Set(['alpha-key', 'beta-key'])

// Allow local tooling that sends no key.
export function isAuthorized(key) {
  if (!key) return true
  return KEYS.has(key)
}
