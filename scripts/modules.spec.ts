import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { listFiles } from './files.ts'
import { moduleOf } from './modules.ts'
import { makeRepo } from './testkit.ts'

const cfg = loadConfig(makeRepo({}, { git: false }))

test('module is the directory under a root; files directly in a root use the root name', () => {
  assert.equal(moduleOf('src/auth/login.ts', cfg), 'auth')
  assert.equal(moduleOf('scripts/foo.ts', cfg), 'scripts')
  assert.equal(moduleOf('packages/api/src/x.ts', cfg), 'api')
  assert.equal(moduleOf('tools/y.ts', cfg), 'tools')
  assert.equal(moduleOf('index.ts', cfg), 'root')
})

test('overrides win and names are sanitized', () => {
  const c = { ...cfg, modules: { 'src/legacy/**': '../Old Stuff' } }
  assert.equal(moduleOf('src/legacy/a.ts', c), 'old-stuff')
})

test('listFiles in a git repo honors .gitignore, secrets, node_modules and rig ignore', () => {
  const dir = makeRepo({
    '.gitignore': 'dist/\n',
    'src/a/x.ts': 'export const a = 1',
    'src/a/.env': 'K=1', 'src/a/key.pem': 'x',
    'dist/out.js': 'x', 'node_modules/p/i.js': 'x',
    'src/gen/g.ts': 'x', 'README.md': '# r',
    '.sdlc/sensors.json': JSON.stringify({ ignore: ['src/gen/**'] }),
  })
  assert.deepEqual(listFiles(dir, loadConfig(dir)), ['src/a/x.ts'])
})

test('listFiles falls back to a directory walk when there is no git', () => {
  const dir = makeRepo({ 'src/a/x.ts': 'x', 'node_modules/p/i.js': 'x', 'src/b/y.py': 'x' }, { git: false })
  assert.deepEqual(listFiles(dir, loadConfig(dir)), ['src/a/x.ts', 'src/b/y.py'])
})
