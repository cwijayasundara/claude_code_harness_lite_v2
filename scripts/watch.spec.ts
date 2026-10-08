// Closing the loop: bands config, the deterministic detector, the watch command and status, rig-watch.yml's scripts, loop metrics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from './model.ts'

test('bands: defaults, and every bad entry is a precise error', () => {
  const ok = parseConfig(JSON.stringify({ bands: [{ id: 'ci-failure-rate', query: 'gh run list --limit 50 --json conclusion', count: 'failure', tiers: { 2: { tools: 'Read,Grep,Bash(gh run view *)' }, 3: { routes: ['pull_request', 'runbook:rollback'] } } }] }))
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.config.bands, [{ id: 'ci-failure-rate', query: 'gh run list --limit 50 --json conclusion', count: 'failure', window: 30, step: 0.5, tools: 'Read,Grep,Bash(gh run view *)', routes: ['pull_request', 'runbook:rollback'] }])
  assert.deepEqual(parseConfig(JSON.stringify({ bands: [{ id: 'p95', query: 'cat p95.txt' }] })).config.bands[0], { id: 'p95', query: 'cat p95.txt', window: 30, step: 0.5, tools: 'Read,Grep,Glob', routes: ['pull_request'] })
  const errs = (bands: unknown): string => parseConfig(JSON.stringify({ bands })).errors.join('\n')
  assert.match(errs({ id: 'x' }), /bands must be a list/)
  assert.match(errs([{ id: 'CI_rate', query: 'x' }]), /bands\[0\]\.id must be a unique kebab-case name/)
  assert.match(errs([{ id: 'a', query: 'x' }, { id: 'a', query: 'y' }]), /bands\[1\]\.id must be a unique/)
  assert.match(errs([{ id: 'a' }]), /bands\[0\]\.query must be a command/)
  assert.match(errs([{ id: 'a', query: 'x', window: 3 }]), /bands\[0\]\.window must be a whole number of at least 5/)
  assert.match(errs([{ id: 'a', query: 'x', step: -1 }]), /bands\[0\]\.step must be a number from 0 to 3/)
  assert.match(errs([{ id: 'a', query: 'x', rules: 'nelson' }]), /bands\[0\]\.rules must be "western_electric"/)
  assert.match(errs([{ id: 'a', query: 'x', colour: 1 }]), /bands\[0\]: unknown key "colour"/)
  assert.match(errs([{ id: 'a', query: 'x', tiers: { 3: { routes: ['deploy'] } } }]), /unknown route "deploy"/)
  for (const tools of ['Read,Edit', 'Bash', 'Read,WebFetch', 'Write(./x)', 'NotebookEdit']) {
    assert.match(errs([{ id: 'a', query: 'x', tiers: { 2: { tools } } }]), /tiers\.2\.tools must be read-only/, tools)
  }
})
