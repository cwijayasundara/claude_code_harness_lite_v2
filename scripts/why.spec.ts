import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { changesFor } from './why.ts'
import { makeRepo, commitAll } from './testkit.ts'

test('links a module file to the change whose commits touched it', () => {
  const dir = makeRepo({ 'src/a/x.ts': 'export const x = 1', 'src/b/y.ts': 'export const y = 1' })
  fs.mkdirSync(path.join(dir, '.sdlc/changes/add-sso'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sdlc/changes/add-sso/intent.md'), '---\ntier: M\n---\n# Add SSO login\n\nbody')
  fs.writeFileSync(path.join(dir, 'src/a/x.ts'), 'export const x = 2')
  commitAll(dir, 'feat: sso')
  assert.deepEqual(changesFor(dir, ['src/a/x.ts']), [{ slug: 'add-sso', intent: 'Add SSO login' }])
  assert.deepEqual(changesFor(dir, ['src/b/y.ts']), [])
})

test('no git or no changes dir gives an empty list', () => {
  assert.deepEqual(changesFor(makeRepo({ 'a.ts': 'x' }, { git: false }), ['a.ts']), [])
  assert.deepEqual(changesFor(makeRepo({ 'a.ts': 'x' }), ['a.ts']), [])
})
