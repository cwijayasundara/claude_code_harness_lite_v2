import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sha, safeName, readJson, writeJson } from './core.ts'
import { makeRepo } from './testkit.ts'

test('sha is stable and 16 chars', () => {
  assert.equal(sha('a'), sha('a'))
  assert.equal(sha('a').length, 16)
  assert.notEqual(sha('a'), sha('b'))
})

test('safeName sanitizes traversal, spaces and slashes', () => {
  assert.equal(safeName('../etc/passwd'), 'etc-passwd')
  assert.equal(safeName('My Module'), 'my-module')
  assert.equal(safeName('...'), 'module')
  assert.equal(safeName(''), 'module')
})

test('writeJson then readJson round-trips; missing file gives fallback', () => {
  const dir = makeRepo({}, { git: false })
  const f = path.join(dir, 'a', 'b.json')
  assert.deepEqual(readJson(f, { x: 1 }), { x: 1 })
  writeJson(f, { y: 2 })
  assert.deepEqual(readJson(f, {}), { y: 2 })
  assert.equal(fs.readdirSync(path.dirname(f)).length, 1)
})
