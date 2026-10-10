import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyWiki } from './apply.ts'
import { buildIndex } from './indexer.ts'
import { loadConfig } from './config.ts'
import { loadState } from './state.ts'
import { makeRepo } from '../shared/testkit.ts'

const setup = () => {
  const dir = makeRepo({
    'src/auth/login.ts': '/** Log in. */\nexport function login(a: string): boolean { return true }\nimport { h } from "../util/h.js"\n',
    'src/util/h.ts': 'export const h = 1\n',
  })
  return { dir, cfg: loadConfig(dir) }
}
const writeProse = (dir: string, mod: string, p: object) => {
  const f = path.join(dir, '.rig/wiki/.cache/prose', `${mod}.json`)
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(p))
}
const page = (dir: string, mod: string) => fs.readFileSync(path.join(dir, '.rig/wiki/modules', `${mod}.md`), 'utf8')

test('composes a page from facts and prose, updates state', () => {
  const { dir, cfg } = setup()
  writeProse(dir, 'auth', { purpose: 'Handles login.', how: 'Checks creds.', mermaid: 'graph LR\n  a-->b' })
  writeProse(dir, 'util', { purpose: 'Helpers.', how: 'Constants.' })
  const r = applyWiki(dir, cfg, buildIndex(dir, cfg))
  assert.deepEqual(r.written.sort(), ['auth', 'util'])
  const p = page(dir, 'auth')
  assert.match(p, /status: fresh/)
  assert.match(p, /\| login \| function \| export function login\(a: string\): boolean \|/)
  assert.match(p, /\[util\]\(util\.md\)/)
  assert.match(p, /Handles login\./)
  assert.match(p, /```mermaid\ngraph LR/)
  assert.equal(loadState(dir).modules.auth.status, 'fresh')
  assert.match(fs.readFileSync(path.join(dir, '.rig/wiki/architecture.md'), 'utf8'), /auth --> util/)
})

test('missing prose keeps the old page and reports pending; nothing half-written', () => {
  const { dir, cfg } = setup()
  writeProse(dir, 'auth', { purpose: 'P', how: 'H' }); writeProse(dir, 'util', { purpose: 'P', how: 'H' })
  applyWiki(dir, cfg, buildIndex(dir, cfg))
  fs.rmSync(path.join(dir, '.rig/wiki/.cache/prose'), { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 2\n')
  const r = applyWiki(dir, cfg, buildIndex(dir, cfg))
  assert.match(page(dir, 'util'), /status: stale/)
  assert.match(page(dir, 'util'), /> \*\*Stale:\*\*/)
  assert.match(page(dir, 'util'), /P/)           // old prose reused
  assert.deepEqual(r.pending, ['util'])
})

test('a module with no prose and no old page is pending, no file written', () => {
  const { dir, cfg } = setup()
  const r = applyWiki(dir, cfg, buildIndex(dir, cfg))
  assert.deepEqual(r.pending.sort(), ['auth', 'util'])
  assert.equal(fs.existsSync(path.join(dir, '.rig/wiki/modules/auth.md')), false)
})

test('keep blocks survive regeneration', () => {
  const { dir, cfg } = setup()
  writeProse(dir, 'util', { purpose: 'P', how: 'H' }); writeProse(dir, 'auth', { purpose: 'P', how: 'H' })
  applyWiki(dir, cfg, buildIndex(dir, cfg))
  const f = path.join(dir, '.rig/wiki/modules/util.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n<!-- keep -->\nHuman note\n<!-- /keep -->\n')
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 3\n')
  writeProse(dir, 'util', { purpose: 'P2', how: 'H2' })
  applyWiki(dir, cfg, buildIndex(dir, cfg))
  assert.match(page(dir, 'util'), /Human note/)
  assert.match(page(dir, 'util'), /P2/)
})

test('unsafe prose cannot break out: a bad mermaid block fails validation and the old page stays', () => {
  const { dir, cfg } = setup()
  writeProse(dir, 'util', { purpose: 'P', how: 'H' }); writeProse(dir, 'auth', { purpose: 'P', how: 'H' })
  applyWiki(dir, cfg, buildIndex(dir, cfg))
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 9\n')
  writeProse(dir, 'util', { purpose: 'NEW', how: 'H', mermaid: 'not a diagram' })
  const r = applyWiki(dir, cfg, buildIndex(dir, cfg))
  assert.ok(r.problems.util.some(p => /prose/.test(p)))
  assert.doesNotMatch(page(dir, 'util'), /NEW/)
})

test('removed modules lose their page', () => {
  const { dir, cfg } = setup()
  writeProse(dir, 'util', { purpose: 'P', how: 'H' }); writeProse(dir, 'auth', { purpose: 'P', how: 'H' })
  applyWiki(dir, cfg, buildIndex(dir, cfg))
  fs.rmSync(path.join(dir, 'src/util'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/auth/login.ts'), 'export function login(a: string): boolean { return true }\n')
  applyWiki(dir, cfg, buildIndex(dir, cfg))
  assert.equal(fs.existsSync(path.join(dir, '.rig/wiki/modules/util.md')), false)
})
