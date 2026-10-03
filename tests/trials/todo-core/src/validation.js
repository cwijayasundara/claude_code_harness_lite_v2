export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
  }
}

export function validateTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') throw new ValidationError('title is required')
  if (title.length > 200) throw new ValidationError('title must be at most 200 characters')
  return title.trim()
}
