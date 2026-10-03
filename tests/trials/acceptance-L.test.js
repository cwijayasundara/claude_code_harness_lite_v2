// Hidden acceptance test for the tier L trial (spec v0.3 §9), identical for every arm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = process.env.TRIAL_ROOT
const { TodoStore } = await import(`${root}/src/store.js`)
const { TodoService } = await import(`${root}/src/service.js`)
const { createHandler } = await import(`${root}/src/http.js`)
const { FileTodoStore } = await import(`${root}/src/file-store.js`)
const USERS = [{ id: 'u1', apiKey: 'key-one' }, { id: 'u2', apiKey: 'key-two' }]
const app = (users = USERS) => createHandler(new TodoService(new TodoStore()), { users })
const as = (h, key) => (method, p, extra = {}) => h({ method, path: p, headers: key === undefined ? {} : { 'x-api-key': key }, query: {}, body: {}, ...extra })

test('missing or unknown key is 401', () => {
  const h = app()
  assert.equal(as(h, undefined)('GET', '/todos').status, 401)
  assert.equal(as(h, 'nope')('GET', '/todos').status, 401)
})
test('todos are isolated per user', () => {
  const h = app(); const a = as(h, 'key-one'); const b = as(h, 'key-two')
  const t = a('POST', '/todos', { body: { title: 'mine' } }).body
  assert.equal(b('GET', '/todos').body.total, 0)
  assert.equal(b('PATCH', `/todos/${t.id}/complete`).status, 404)
  assert.equal(a('GET', '/todos').body.items[0].title, 'mine')
})
test('pagination: defaults, bounds and totals', () => {
  const h = app(); const a = as(h, 'key-one')
  for (let i = 0; i < 120; i++) a('POST', '/todos', { body: { title: `t${i}` } })
  assert.equal(a('GET', '/todos').body.items.length, 50)
  const page = a('GET', '/todos', { query: { limit: '10', offset: '5' } }).body
  assert.equal(page.items.length, 10); assert.equal(page.items[0].title, 't5'); assert.equal(page.total, 120)
  for (const q of [{ limit: '101' }, { limit: '0' }, { limit: 'x' }, { offset: '-1' }]) assert.equal(a('GET', '/todos', { query: q }).status, 400, JSON.stringify(q))
})
test('file store persists, and a stray temp file never replaces good data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-')); const file = path.join(dir, 'todos.json')
  const s1 = new FileTodoStore(file); s1.add({ title: 'kept', ownerId: 'u1' })
  JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(`${file}.tmp`, '{ broken')
  assert.equal(new FileTodoStore(file).list().length, 1)
})
test('an empty apiKey never authenticates (setup may refuse it instead)', () => {
  let h
  try { h = app([{ id: 'u1', apiKey: '' }, ...USERS.slice(1)]) } catch { return }
  assert.equal(as(h, '')('GET', '/todos').status, 401)
  assert.equal(as(h, undefined)('GET', '/todos').status, 401)
})
