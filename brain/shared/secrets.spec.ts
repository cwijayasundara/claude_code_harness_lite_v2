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

test('redact catches prefixed and suffixed key names', () => {
  assert.equal(redact('DB_PASSWORD=hunter22'), 'DB_PASSWORD=[REDACTED]')
  assert.equal(redact('GITHUB_TOKEN=abcdef1234'), 'GITHUB_TOKEN=[REDACTED]')
  assert.equal(redact('MY_API_KEY=abcdef123456'), 'MY_API_KEY=[REDACTED]')
  assert.equal(redact('client_secret=abcdef123456'), 'client_secret=[REDACTED]')
  assert.equal(redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI'), 'AWS_SECRET_ACCESS_KEY=[REDACTED]')
})

test('redact masks quoted values containing spaces', () => {
  assert.equal(redact('password="hunter two"'), 'password="[REDACTED]"')
  assert.equal(redact("secret: 'my long value'"), "secret: '[REDACTED]'")
  assert.equal(hasSecret('password="hunter two"'), true)
})

test('redact masks URL credentials, Basic auth and Stripe keys', () => {
  assert.equal(redact('postgres://user:hunter22@db.example.com/app'), 'postgres://user:[REDACTED]@db.example.com/app')
  assert.equal(redact('https://github.com/org/repo'), 'https://github.com/org/repo')
  assert.equal(redact('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="'), 'curl -H "Authorization: [REDACTED]"')
  assert.equal(redact('Basic configuration is done'), 'Basic configuration is done')
  assert.equal(redact('sk_live_abcdefghijklmnop1234'), '[REDACTED]')
  assert.equal(redact('sk_test_abcdefghijklmnop1234'), '[REDACTED]')
})

test('redact stays linear on long runs of key-like words', () => {
  for (const s of ['token'.repeat(40000), 'password'.repeat(20000)]) {
    const t = performance.now()
    const out = redact(s)
    const ms = performance.now() - t
    assert.equal(out, s)
    assert.ok(ms < 200, `redact took ${ms.toFixed(1)} ms`)
  }
})
