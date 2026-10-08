// A spec, plan or design flags each conflict with a policy skill under ## Concerns; approval waits until each is resolved.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, sdlc, write } from './testkit.ts'
import { unresolvedConcerns } from './model.ts'

test('unresolvedConcerns: bullets without resolved:, ignoring none and documents without the section', () => {
  assert.deepEqual(unresolvedConcerns('# x\n## Files\n- a\n'), [])
  assert.deepEqual(unresolvedConcerns('## Concerns\nnone\n'), [])
  assert.deepEqual(unresolvedConcerns('## Concerns\n- none\n'), [])
  assert.deepEqual(unresolvedConcerns('## Concerns\n- [policy-security] PII in logs → owner: @sec\n- [policy-brand] colour → owner: @design → resolved: use the token (@design)\n## Risks\n- [x] not a concern\n'),
    ['[policy-security] PII in logs → owner: @sec'])
})

let repo: string
beforeEach(() => {
  repo = makeRepo()
  sdlc(repo, ['new', 'feat', '--type', 'feature', '--tier', 'M'])
})
const design = (concerns: string) => write(repo, '.sdlc/changes/feat/design.md', `## Files\n- src/a.js\n## Verification\n- \`npm test\`\n${concerns}`)
const approve = () => sdlc(repo, ['approve', 'feat', 'design'], { env: { SDLC_HUMAN: '1' } })

test('approve refuses a design with an unresolved concern and names it; status lists it as open', () => {
  design('## Concerns\n- [policy-security] claim IDs appear in logs → owner: @sec\n')
  const r = approve()
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /resolve the concern\(s\) in feat\/design\.md/)
  assert.match(r.stderr, /claim IDs appear in logs/)
  assert.match(sdlc(repo, ['status']).stdout, /^open: feat\/design\.md: concern: \[policy-security\] claim IDs appear in logs/m)
})

test('approve accepts a design whose concerns are all resolved', () => {
  design('## Concerns\n- [policy-security] claim IDs appear in logs → owner: @sec → resolved: masked at the logger (@sec)\n')
  const r = approve()
  assert.equal(r.code, 0, r.stderr)
})

test('a design written before Concerns existed (no section) is approved as before', () => {
  design('')
  const r = approve()
  assert.equal(r.code, 0, r.stderr)
})
