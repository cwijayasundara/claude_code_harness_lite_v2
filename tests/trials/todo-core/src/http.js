import { ValidationError } from './validation.js'

// A tiny transport-agnostic router: handle({ method, path, query, body }) -> { status, body }
export function createHandler(service) {
  return function handle({ method, path, query = {}, body = {} }) {
    try {
      if (method === 'GET' && path === '/todos') {
        const done = query.done === undefined ? undefined : query.done === 'true'
        return { status: 200, body: service.list({ done }) }
      }
      if (method === 'POST' && path === '/todos') {
        return { status: 201, body: service.create(body) }
      }
      const complete = /^\/todos\/(\d+)\/complete$/.exec(path)
      if (method === 'PATCH' && complete) {
        const todo = service.complete(Number(complete[1]))
        return todo ? { status: 200, body: todo } : { status: 404, body: { error: 'not found' } }
      }
      return { status: 404, body: { error: 'not found' } }
    } catch (err) {
      if (err instanceof ValidationError) return { status: 400, body: { error: err.message } }
      throw err
    }
  }
}
