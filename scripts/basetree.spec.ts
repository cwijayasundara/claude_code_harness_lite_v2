// withBaseTree: one throwaway checkout of the base, dependency directories linked, always cleaned up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { makeRepo, write, gitIn } from './testkit.ts'

const repo = makeRepo()
write(repo, 'a/one.txt', '1\n')
write(repo, 'b/two.txt', '2\n')
write(repo, 'root.txt', 'r\n')
write(repo, 'node_modules/dep.js', 'dep\n')
write(repo, 'venv/pyvenv.cfg', 'v\n')
write(repo, '.gitignore', 'node_modules\nvenv\n')
gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
process.env.CLAUDE_PROJECT_DIR = repo
const { withBaseTree, DEP_DIRS, safeRoot, conePatterns } = await import('./basetree.ts')
const worktrees = (): number => gitIn(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length

test('runs the function in a checkout of the base and removes it afterwards', () => {
  let seen = ''
  const r = withBaseTree('HEAD', dir => { seen = dir; return fs.readFileSync(`${dir}/a/one.txt`, 'utf8') })
  assert.deepEqual(r, { ok: true, value: '1\n' })
  assert.equal(fs.existsSync(seen), false)
  assert.equal(worktrees(), 1)
})

test('removes the checkout when the function throws', () => {
  assert.throws(() => withBaseTree('HEAD', () => { throw new Error('boom') }), /boom/)
  assert.equal(worktrees(), 1)
})

test('links node_modules and venv from the checkout', () => {
  const r = withBaseTree('HEAD', dir => [fs.existsSync(`${dir}/node_modules/dep.js`), fs.existsSync(`${dir}/venv/pyvenv.cfg`)])
  assert.deepEqual(r, { ok: true, value: [true, true] })
  assert.ok(DEP_DIRS.includes('venv'))
})

test('a base that does not exist is an error result, not a crash', () => {
  const r = withBaseTree('no-such-ref', () => 1)
  assert.equal(r.ok, false)
  assert.equal(worktrees(), 1)
})

test('sparse writes only the listed directories plus root files, and never touches the repository config', () => {
  const before = fs.readFileSync(`${repo}/.git/config`, 'utf8')
  const r = withBaseTree('HEAD', dir => ({ a: fs.existsSync(`${dir}/a/one.txt`), b: fs.existsSync(`${dir}/b/two.txt`), root: fs.existsSync(`${dir}/root.txt`) }), { sparse: ['a'] })
  assert.deepEqual(r, { ok: true, value: { a: true, b: false, root: true }, sparse: true })
  assert.equal(worktrees(), 1)
  assert.equal(fs.readFileSync(`${repo}/.git/config`, 'utf8'), before, 'no extensions.worktreeConfig, no core.sparseCheckout')
})

test('a root that could read as an option or a pattern makes the base a full checkout, still measured', () => {
  const before = fs.readFileSync(`${repo}/.git/config`, 'utf8')
  for (const bad of ['--no-cone', 'a*b', ':a', 'a/../b']) {
    const r = withBaseTree('HEAD', dir => ({ a: fs.existsSync(`${dir}/a/one.txt`), b: fs.existsSync(`${dir}/b/two.txt`) }), { sparse: ['a', bad] })
    assert.deepEqual(r, { ok: true, value: { a: true, b: true }, sparse: false }, bad)
  }
  assert.equal(worktrees(), 1)
  assert.equal(fs.readFileSync(`${repo}/.git/config`, 'utf8'), before)
  assert.equal(safeRoot('packages/api'), true)
  assert.equal(safeRoot('-x'), false)
})

test('cone patterns include each nested root and its parents\' own files', () => {
  assert.deepEqual(conePatterns(['packages/api', 'shared']), ['/*', '!/*/', '/packages/', '!/packages/*/', '/packages/api/', '/shared/'])
})
