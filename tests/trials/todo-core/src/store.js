export class TodoStore {
  #items = new Map()
  #nextId = 1

  add(fields) {
    const todo = { id: this.#nextId++, done: false, createdAt: new Date().toISOString(), ...fields }
    this.#items.set(todo.id, todo)
    return { ...todo }
  }

  get(id) {
    const todo = this.#items.get(id)
    return todo ? { ...todo } : null
  }

  list() {
    return [...this.#items.values()].map(t => ({ ...t }))
  }

  update(id, fields) {
    const todo = this.#items.get(id)
    if (!todo) return null
    Object.assign(todo, fields)
    return { ...todo }
  }
}
