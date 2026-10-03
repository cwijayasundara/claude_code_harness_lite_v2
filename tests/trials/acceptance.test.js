// Hidden acceptance test, identical for both trial repos. Uses far past/future dates so no clock injection is needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
const root = process.env.TRIAL_ROOT
const { TodoStore } = await import(`${root}/src/store.js`)
const { TodoService } = await import(`${root}/src/service.js`)
const { createHandler } = await import(`${root}/src/http.js`)
const app = () => createHandler(new TodoService(new TodoStore()))
const post = (h, body) => h({ method: 'POST', path: '/todos', body })

test('valid dueDate is stored and echoed', () => {
  const r = post(app(), { title: 'a', dueDate: '2030-05-01' })
  assert.equal(r.status, 201); assert.equal(r.body.dueDate, '2030-05-01')
})
test('invalid dueDates are 400', () => {
  const h = app()
  for (const d of ['2026-02-30', 'tomorrow', '2026-3-5', 20260101, '2026-13-01']) assert.equal(post(h, { title: 'a', dueDate: d }).status, 400, String(d))
})
test('dueDate is optional', () => { assert.equal(post(app(), { title: 'a' }).status, 201) })
test('overdue returns only open todos due in the past', () => {
  const h = app()
  const late = post(h, { title: 'late', dueDate: '2000-01-01' }).body
  const lateDone = post(h, { title: 'late-done', dueDate: '2000-01-02' }).body
  post(h, { title: 'future', dueDate: '2999-01-01' }); post(h, { title: 'undated' })
  h({ method: 'PATCH', path: `/todos/${lateDone.id}/complete` })
  const r = h({ method: 'GET', path: '/todos', query: { overdue: 'true' } })
  assert.deepEqual(r.body.map(t => t.title), ['late']); assert.equal(late.title, 'late')
})
test('list sorts by dueDate ascending, undated last', () => {
  const h = app()
  post(h, { title: 'undated' }); post(h, { title: 'c', dueDate: '2031-01-03' }); post(h, { title: 'a', dueDate: '2031-01-01' }); post(h, { title: 'b', dueDate: '2031-01-02' })
  assert.deepEqual(h({ method: 'GET', path: '/todos' }).body.map(t => t.title), ['a', 'b', 'c', 'undated'])
})
test('existing behaviour still works', () => {
  const h = app()
  assert.equal(post(h, { title: '' }).status, 400)
  assert.equal(h({ method: 'PATCH', path: '/todos/99/complete' }).status, 404)
})
