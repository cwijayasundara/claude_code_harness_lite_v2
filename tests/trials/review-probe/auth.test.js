import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorized } from './auth.js'

test('known keys pass; empty, unknown and non-string keys fail', () => {
  assert.equal(isAuthorized('alpha-key'), true)
  assert.equal(isAuthorized(''), false)
  assert.equal(isAuthorized('nope'), false)
  assert.equal(isAuthorized(undefined), false)
})
