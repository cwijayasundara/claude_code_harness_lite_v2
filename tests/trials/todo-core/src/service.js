import { validateTitle } from './validation.js'

export class TodoService {
  constructor(store) {
    this.store = store
  }

  create({ title }) {
    return this.store.add({ title: validateTitle(title) })
  }

  complete(id) {
    return this.store.update(id, { done: true })
  }

  list({ done } = {}) {
    const all = this.store.list()
    return done === undefined ? all : all.filter(t => t.done === done)
  }
}
