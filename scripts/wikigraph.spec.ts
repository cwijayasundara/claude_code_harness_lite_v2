import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importsOf, resolveImport, buildGraph, dependents } from './wikigraph.ts'

const src = (m: Record<string, string>) => ({ list: Object.keys(m), read: (f: string): string => m[f] ?? '' })

test('JS/TS: all four import spellings, comments ignored, line numbers kept', () => {
  const text = [
    "import a from './a.js'", "// import ghost from './ghost.js'", "export { b } from '../b'",
    "/* import block from './block' */", "const c = require('./c')", "const d = await import('./d.js')", "import './side.css'",
  ].join('\n')
  assert.deepEqual(importsOf('src/x/y.ts', text), [
    { spec: './a.js', line: 1 }, { spec: '../b', line: 3 }, { spec: './c', line: 5 }, { spec: './d.js', line: 6 }, { spec: './side.css', line: 7 },
  ])
})

test('Python: relative dots, absolute dotted, import statements, comments ignored', () => {
  const text = ['from .a import x', '# from .ghost import y', 'from ..up.mod import z', 'import pkg.sub', 'from . import b'].join('\n')
  assert.deepEqual(importsOf('app/svc/main.py', text).map(i => i.spec), ['.a', '..up.mod', 'pkg.sub', '.'])
})

test('a file in a language with no table row has no imports', () => {
  assert.deepEqual(importsOf('src/main.go', 'import "fmt"\n'), [])
})

test('resolveImport JS/TS: extension candidates, .js to .ts swap, index files, json, externals, node: builtins, unresolved', () => {
  const set = new Set(['src/a/x.ts', 'src/a/y.ts', 'src/b/index.js', 'src/a/data.json'])
  const r = (spec: string) => resolveImport('src/a/x.ts', spec, set)
  assert.deepEqual(r('./y.js'), { kind: 'file', file: 'src/a/y.ts' })
  assert.deepEqual(r('./y'), { kind: 'file', file: 'src/a/y.ts' })
  assert.deepEqual(r('../b'), { kind: 'file', file: 'src/b/index.js' })
  assert.deepEqual(r('./data.json'), { kind: 'file', file: 'src/a/data.json' })
  assert.deepEqual(r('lodash/fp'), { kind: 'external', name: 'lodash' })
  assert.deepEqual(r('@scope/pkg/sub'), { kind: 'external', name: '@scope/pkg' })
  assert.deepEqual(r('node:fs'), { kind: 'external', name: '' })
  assert.deepEqual(r('./missing'), { kind: 'unresolved' })
})

test('resolveImport Python: relative dots, absolute from the root and src/, packages, externals', () => {
  const set = new Set(['app/svc/a.py', 'app/svc/__init__.py', 'app/up/mod.py', 'pkg/sub.py', 'src/lib/core.py', 'src/lib/__init__.py'])
  const r = (spec: string) => resolveImport('app/svc/main.py', spec, set)
  assert.deepEqual(r('.a'), { kind: 'file', file: 'app/svc/a.py' })
  assert.deepEqual(r('.'), { kind: 'file', file: 'app/svc/__init__.py' })
  assert.deepEqual(r('..up.mod'), { kind: 'file', file: 'app/up/mod.py' })
  assert.deepEqual(r('pkg.sub'), { kind: 'file', file: 'pkg/sub.py' })
  assert.deepEqual(r('lib.core'), { kind: 'file', file: 'src/lib/core.py' })
  assert.deepEqual(r('os.path'), { kind: 'external', name: 'os' })
  assert.deepEqual(r('.nope'), { kind: 'unresolved' })
})

test('buildGraph folds imports into module edges, externals, unresolved specifiers and uncomputed languages', () => {
  const { list, read } = src({
    'src/a/x.js': "import { b } from '../b/index.js'\nimport _ from 'lodash/fp'\nimport './self.js'\nimport './missing.js'\n",
    'src/a/self.js': 'export const s = 1\n',
    'src/b/index.js': "import { a } from '../a/x.js'\nexport const b = 1\n",
    'src/svc/main.go': 'package main\n',
    'test/a.test.js': "import { a } from '../src/a/x.js'\n",
  })
  const g = buildGraph({ 'm/a.md': { globs: ['src/a/**'] }, 'm/b.md': { globs: ['src/b/**'] }, 'm/svc.md': { globs: ['src/svc/**'] } }, list, read)
  assert.equal(g.edges.get('m/a.md')?.get('m/b.md'), 1)
  assert.equal(g.edges.get('m/b.md')?.get('m/a.md'), 1, 'mutual edges are both kept')
  assert.equal(g.edges.get('m/a.md')?.get('m/a.md'), undefined, 'a self import is dropped')
  assert.equal(g.external.get('m/a.md')?.get('lodash'), 1)
  assert.deepEqual(g.unresolved.get('m/a.md'), ['./missing.js'])
  assert.deepEqual(g.uncomputed.get('m/svc.md'), ['.go'])
  assert.equal(g.edges.get('m/svc.md'), undefined)
  assert.deepEqual(g.imports.get('test/a.test.js'), ['src/a/x.js'], 'a file outside every module still records its imports')
  assert.deepEqual([...dependents(g, 'm/a.md')], [['m/b.md', 1]])
})

test('a file matched by two pages belongs to the first page by name', () => {
  const { list, read } = src({ 'src/x.js': 'export const x = 1\n' })
  const g = buildGraph({ 'm/b.md': { globs: ['src/**'] }, 'm/a.md': { globs: ['src/**'] } }, list, read)
  assert.equal(g.moduleOf.get('src/x.js'), 'm/a.md')
})

test('an empty repo or empty module yields an empty graph without throwing', () => {
  const g = buildGraph({ 'm/a.md': { globs: ['nothing/**'] } }, [], () => '')
  assert.equal(g.moduleOf.size, 0)
  assert.equal(g.edges.size, 0)
})
