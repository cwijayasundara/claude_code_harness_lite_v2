import test from 'node:test'
import assert from 'node:assert/strict'
import { planRefresh } from './planner.ts'
import { archHash } from './state.ts'
import type { Index, State } from './core.ts'

const mod = (name: string, hash: string, usedBy: string[] = [], structureOnly = false) =>
  ({ name, files: [`src/${name}/a.ts`], hash, sigHash: 's', structureOnly, dependsOn: [], usedBy })
const idx = (mods: ReturnType<typeof mod>[]): Index =>
  ({ generated: '', files: {}, modules: Object.fromEntries(mods.map(m => [m.name, m])) })
const cfg = { moduleRoots: [], modules: {}, maxPages: 25, ignore: [] }
const empty: State = { version: 1, modules: {}, architectureHash: '' }

test('new modules are planned; structure-only are not', () => {
  const p = planRefresh(idx([mod('a', 'h1'), mod('b', 'h2', [], true)]), empty, cfg)
  assert.deepEqual(p.prose.map(t => [t.module, t.reason]), [['a', 'new']])
})

test('unchanged fresh module is not planned; changed and stale are', () => {
  const i = idx([mod('a', 'h1'), mod('b', 'h2'), mod('c', 'h3')])
  const st: State = { version: 1, architectureHash: archHash(i), modules: {
    a: { hash: 'h1', sigHash: 's', status: 'fresh', generated: '' },
    b: { hash: 'old', sigHash: 's', status: 'fresh', generated: '' },
    c: { hash: 'h3', sigHash: 's', status: 'stale', generated: '' } } }
  const p = planRefresh(i, st, cfg)
  assert.deepEqual(p.prose.map(t => [t.module, t.reason]), [['b', 'changed'], ['c', 'stale']])
  assert.equal(p.architecture, true)
})

test('nothing due and same graph: empty plan', () => {
  const i = idx([mod('a', 'h1')])
  const st: State = { version: 1, architectureHash: archHash(i), modules: { a: { hash: 'h1', sigHash: 's', status: 'fresh', generated: '' } } }
  assert.deepEqual(planRefresh(i, st, cfg), { prose: [], pending: [], architecture: false })
})

test('cap puts most-depended-on first and overflow into pending', () => {
  const i = idx([mod('a', 'h'), mod('b', 'h', ['x', 'y']), mod('c', 'h', ['x'])])
  const p = planRefresh(i, empty, { ...cfg, maxPages: 2 })
  assert.deepEqual(p.prose.map(t => t.module), ['b', 'c'])
  assert.deepEqual(p.pending.map(t => t.module), ['a'])
})

test('empty index plans nothing', () => {
  assert.deepEqual(planRefresh(idx([]), { ...empty, architectureHash: archHash(idx([])) }, cfg), { prose: [], pending: [], architecture: false })
})
