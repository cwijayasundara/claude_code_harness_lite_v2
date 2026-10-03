import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, write, sdlc, gitIn } from './testkit.ts'

type Status = { stale: string[]; missing: string[]; uncovered: string[] }
type Out = { findings: { sensor: string; severity: string }[] }
const manifest = (repo: string, pages: object): void => write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages }))
const status = (repo: string) => JSON.parse(sdlc(repo, ['wiki', 'status', '--json']).stdout) as Status
const ciCheck = (repo: string) => JSON.parse(sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--json']).stdout) as Out

test('a page goes stale when its public surface changes, not when a body changes', () => {
  const repo = makeRepo()
  write(repo, 'src/auth/key.js', 'export function check(k) {\n  return k === 1\n}\n')
  manifest(repo, { 'modules/auth.md': { globs: ['src/auth/**'] } })
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  assert.deepEqual(status(repo).stale, ['modules/auth.md'], 'never stamped')
  sdlc(repo, ['wiki', 'stamp'])
  assert.deepEqual(status(repo).stale, [])
  write(repo, 'src/auth/key.js', 'export function check(k) {\n  return k === 2\n}\n')
  assert.deepEqual(status(repo).stale, [], 'body edit')
  write(repo, 'src/auth/key.js', 'export function check(k, strict) {\n  return k === 2\n}\n')
  assert.deepEqual(status(repo).stale, ['modules/auth.md'], 'signature edit')
  write(repo, 'src/auth/new.js', 'const x = 1\n')
  sdlc(repo, ['wiki', 'stamp', 'modules/auth.md'])
  write(repo, 'src/auth/extra.js', 'const y = 1\n')
  assert.deepEqual(status(repo).stale, ['modules/auth.md'], 'new file in module')
})

test('globs matching nothing are missing; top-level source dirs no page covers are uncovered', () => {
  const repo = makeRepo()
  write(repo, 'src/a.js', 'export const a = 1\n'); write(repo, 'lib/b.js', 'export const b = 1\n')
  manifest(repo, { 'modules/src.md': { globs: ['src/**'] }, 'modules/gone.md': { globs: ['old/**'] } })
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  const s = status(repo)
  assert.deepEqual(s.missing, ['modules/gone.md'])
  assert.deepEqual(s.uncovered, ['lib'])
})

test('wiki-stale warns at ship and ci only when a manifest exists; docs/wiki is never drift or source', async () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, 'src/a.js', 'export const a = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  gitIn(repo, 'checkout', '-qb', 'f')
  write(repo, 'src/a.js', 'export const a = 2\n'); gitIn(repo, 'commit', '-qam', 'b')
  assert.equal(ciCheck(repo).findings.filter(f => f.sensor === 'wiki-stale').length, 0)
  manifest(repo, { 'modules/src.md': { globs: ['src/**'] } })
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'c')
  assert.deepEqual(ciCheck(repo).findings.filter(f => f.sensor === 'wiki-stale').map(f => f.severity), ['warn'])
  const { isPlanned } = await import('./core.ts')
  assert.equal(isPlanned('docs/wiki/modules/src.md', ['src/**']), true)
})
