import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIndexMd } from './indexmd.ts'
import { findIn } from './find.ts'
import type { Index, State } from './core.ts'

const f = (path: string, module: string, names: string[]) => ({ path, module, hash: 'h', lang: 'ts' as const, structureOnly: false, imports: [], symbols: names.map(n => ({ name: n, kind: 'function', signature: `export function ${n}()`, doc: '' })) })
const idx: Index = {
  generated: '', 
  files: { 'src/auth/login.ts': f('src/auth/login.ts', 'auth', ['login', 'logout']), 'src/util/h.ts': f('src/util/h.ts', 'util', ['hash']) },
  modules: {
    auth: { name: 'auth', files: ['src/auth/login.ts'], hash: 'h', sigHash: 's', structureOnly: false, dependsOn: ['util'], usedBy: [] },
    util: { name: 'util', files: ['src/util/h.ts'], hash: 'h', sigHash: 's', structureOnly: false, dependsOn: [], usedBy: ['auth'] },
  },
}
const st: State = { version: 1, architectureHash: '', modules: { auth: { hash: 'h', sigHash: 's', status: 'stale', generated: '' }, util: { hash: 'h', sigHash: 's', status: 'fresh', generated: '' } } }

test('findIn ranks symbol and module matches and flags stale', () => {
  const hits = findIn(idx, st, 'where is login handled')
  assert.equal(hits[0].name, 'login')
  assert.equal(hits[0].stale, true)
  assert.equal(hits[0].page, '.sdlc/wiki/modules/auth.md')
  assert.deepEqual(findIn(idx, st, 'zzzz'), [])
})

test('INDEX.md ranks by dependents, marks stale, stays under the cap', () => {
  const md = buildIndexMd(idx, st, m => `${m} purpose.`)
  assert.ok(md.indexOf('**util**') < md.indexOf('**auth**'))
  assert.match(md, /\*\*auth\*\* \(stale\)/)
  assert.ok(md.length <= 8000)
})

test('large repos overflow to a names-only line; empty repo still valid', () => {
  const many: Index = { generated: '', files: {}, modules: {} }
  for (let i = 0; i < 300; i++) many.files[`src/m${i}/a.ts`] = f(`src/m${i}/a.ts`, `m${i}`, [`fn${i}`])
  for (let i = 0; i < 300; i++) many.modules[`m${i}`] = { name: `m${i}`, files: [`src/m${i}/a.ts`], hash: 'h', sigHash: 's', structureOnly: false, dependsOn: [], usedBy: [] }
  const md = buildIndexMd(many, { version: 1, modules: {}, architectureHash: '' }, () => 'x'.repeat(60))
  assert.ok(md.length <= 8000)
  assert.match(md, /More: m\d+/)
  assert.match(buildIndexMd({ generated: '', files: {}, modules: {} }, st, () => ''), /No modules/)
})
