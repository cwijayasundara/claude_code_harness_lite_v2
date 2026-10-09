import test from 'node:test'
import assert from 'node:assert/strict'
import { redact, hasSecret, SECRET_PATH } from './secrets.ts'

test('redact masks tokens, keyed values, bearer headers and private keys', () => {
  assert.equal(redact('export API_KEY=abcdef123456'), 'export API_KEY=[REDACTED]')
  assert.equal(redact('password: hunter22'), 'password: [REDACTED]')
  assert.equal(redact('curl -H "Authorization: Bearer abcdefghijklmnop123"'), 'curl -H "Authorization: [REDACTED]"')
  assert.equal(redact('key sk-ant-api03-abcdefghijklmnopqrstuv end'), 'key [REDACTED] end')
  assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz0123'), '[REDACTED]')
  assert.equal(redact('AKIAABCDEFGHIJKLMNOP'), '[REDACTED]')
  assert.equal(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'), '[REDACTED]')
})

test('redact leaves ordinary text alone', () => {
  for (const s of ['npm test', 'use pnpm, not npm', 'the token list is empty', 'Run `npx tsc -p .`']) {
    assert.equal(redact(s), s); assert.equal(hasSecret(s), false)
  }
  assert.equal(hasSecret('token=abcdef123'), true)
})

test('SECRET_PATH still matches secret files', () => {
  assert.ok(SECRET_PATH.test('a/.env.local')); assert.ok(SECRET_PATH.test('id_rsa')); assert.ok(!SECRET_PATH.test('src/env.ts'))
})
