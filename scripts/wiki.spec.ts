import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, write, sdlc, gitIn } from './testkit.ts'

type Status = { stale: string[]; missing: string[]; uncovered: string[] }
type Out = { findings: { sensor: string; severity: string }[] }
const manifest = (repo: string, pages: object): void => {
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages }))
  for (const page of Object.keys(pages)) write(repo, `docs/wiki/${page}`, `# ${page}\n- \`README.md:1\` cited\n`)
}
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

test('uncovered ignores dot dirs and test dirs', () => {
  const repo = makeRepo()
  write(repo, 'src/a.js', 'export const a = 1\n'); write(repo, 'tests/a.test.js', 'test()\n'); write(repo, '.github/x.yml', 'a: 1\n')
  manifest(repo, { 'modules/src.md': { globs: ['src/**'] } })
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  assert.deepEqual(status(repo).uncovered, [])
})

test('docs/wiki exempts only the manifest and markdown pages', async () => {
  const { isPlanned } = await import('./core.ts')
  const { isSource, parseConfig } = await import('./model.ts')
  const cfg = parseConfig('{}').config
  assert.equal(isPlanned('docs/wiki/evil.js', ['src/**']), false)
  assert.equal(isSource('docs/wiki/evil.js', cfg), true)
  for (const f of ['docs/wiki/modules/a.md', 'docs/wiki/manifest.json']) {
    assert.equal(isPlanned(f, ['src/**']), true, f)
    assert.equal(isSource(f, cfg), false, f)
  }
})

test('wiki stamp rejects unknown pages without writing and counts what it stamped', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, 'src/a.js', 'export const a = 1\n')
  manifest(repo, { 'modules/src.md': { globs: ['src/**'] }, 'modules/b.md': { globs: ['b/**'] } })
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  const bad = sdlc(repo, ['wiki', 'stamp', 'modules/src.md', 'nope.md'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /unknown page\(s\): nope\.md/)
  assert.deepEqual(status(repo).stale, ['modules/src.md'], 'nothing written')
  const ok = sdlc(repo, ['wiki', 'stamp', 'modules/src.md'])
  assert.match(ok.stdout, /stamped 1 page/)
})

test('wiki stamp refuses a page with no path:line citation and stamps the cited ones', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, 'src/a/x.js', 'export const x = 1\n')
  write(repo, 'src/b/y.js', 'export const y = 1\n')
  manifest(repo, { 'modules/a.md': { globs: ['src/a/**'] }, 'modules/b.md': { globs: ['src/b/**'] } })
  write(repo, 'docs/wiki/modules/a.md', '# a\n- `src/a/x.js:1` exports x\n')
  write(repo, 'docs/wiki/modules/b.md', '# b\nIt exports y.\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  const r = sdlc(repo, ['wiki', 'stamp'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /uncited page\(s\): modules\/b\.md/)
  assert.deepEqual(status(repo).stale, ['modules/b.md'], 'the cited page was stamped, the uncited one was not')
})
