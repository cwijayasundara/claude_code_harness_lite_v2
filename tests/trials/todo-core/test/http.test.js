import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TodoStore } from '../src/store.js'
import { TodoService } from '../src/service.js'
import { createHandler } from '../src/http.js'

const handler = () => createHandler(new TodoService(new TodoStore()))

test('POST then GET /todos', () => {
  const handle = handler()
  assert.equal(handle({ method: 'POST', path: '/todos', body: { title: 'x' } }).status, 201)
  assert.equal(handle({ method: 'GET', path: '/todos' }).body.length, 1)
})

test('POST /todos with a bad title is 400', () => {
  assert.equal(handler()({ method: 'POST', path: '/todos', body: {} }).status, 400)
})

test('PATCH unknown todo is 404', () => {
  assert.equal(handler()({ method: 'PATCH', path: '/todos/9/complete' }).status, 404)
})
