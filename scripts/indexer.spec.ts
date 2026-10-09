import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIndex } from './indexer.ts'
import { loadConfig } from './config.ts'
import { makeRepo } from './testkit.ts'

const repo = () => makeRepo({
  'src/auth/login.ts': '/** Log a user in. */\nexport function login(user: string, pw: string): boolean { return true }\nexport class Session {}\nexport const TTL = 5\nexport type Id = string\nimport { hash } from "../util/hash.js"\n',
  'src/util/hash.ts': 'export function hash(s: string): string { return s }\n',
  'src/py/a.py': 'from py.b import f\n',
  'src/py/b.py': 'def f(): pass\n',
  'src/bad/broken.ts': 'export function ((( {{{',
})

test('extracts exported symbols with signature and doc', () => {
  const idx = buildIndex(repo(), loadConfig(repo()))
  const f = idx.files['src/auth/login.ts']
  const login = f.symbols.find(s => s.name === 'login')!
  assert.equal(login.kind, 'function')
  assert.equal(login.signature, 'export function login(user: string, pw: string): boolean')
  assert.equal(login.doc, 'Log a user in.')
  assert.deepEqual(f.symbols.map(s => s.name).sort(), ['Id', 'Session', 'TTL', 'login'])
  assert.equal(f.structureOnly, false)
})

test('edges resolve .js imports to .ts files and python by suffix', () => {
  const dir = repo()
  const idx = buildIndex(dir, loadConfig(dir))
  assert.deepEqual(idx.modules.auth.dependsOn, ['util'])
  assert.deepEqual(idx.modules.util.usedBy, ['auth'])
  assert.deepEqual(idx.modules.py.dependsOn, [])  // same module
})

test('a file that does not parse is structure-only and does not crash', () => {
  const dir = repo()
  const idx = buildIndex(dir, loadConfig(dir))
  assert.equal(idx.files['src/bad/broken.ts'].structureOnly, true)
  assert.equal(idx.modules.bad.structureOnly, true)
})

test('works without typescript: everything structure-only, imports still found', () => {
  const dir = repo()
  const idx = buildIndex(dir, loadConfig(dir), { noTypescript: true })
  assert.equal(idx.files['src/auth/login.ts'].structureOnly, true)
  assert.deepEqual(idx.modules.auth.dependsOn, ['util'])
})

test('hash changes with body, sigHash only with signature', () => {
  const a = makeRepo({ 'src/m/x.ts': 'export function f(): number { return 1 }\n' })
  const b = makeRepo({ 'src/m/x.ts': 'export function f(): number { return 2 }\n' })
  const ia = buildIndex(a, loadConfig(a)), ib = buildIndex(b, loadConfig(b))
  assert.notEqual(ia.modules.m.hash, ib.modules.m.hash)
  assert.equal(ia.modules.m.sigHash, ib.modules.m.sigHash)
})
