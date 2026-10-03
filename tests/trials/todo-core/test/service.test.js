import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TodoStore } from '../src/store.js'
import { TodoService } from '../src/service.js'

test('create trims and stores a todo', () => {
  const svc = new TodoService(new TodoStore())
  const todo = svc.create({ title: '  buy milk ' })
  assert.equal(todo.title, 'buy milk')
  assert.equal(todo.done, false)
})

test('create rejects an empty title', () => {
  const svc = new TodoService(new TodoStore())
  assert.throws(() => svc.create({ title: ' ' }), /title is required/)
})

test('list filters by done', () => {
  const svc = new TodoService(new TodoStore())
  const a = svc.create({ title: 'a' })
  svc.create({ title: 'b' })
  svc.complete(a.id)
  assert.deepEqual(svc.list({ done: true }).map(t => t.title), ['a'])
})
