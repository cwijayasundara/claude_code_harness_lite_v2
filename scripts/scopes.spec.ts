import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from './model.ts'
import { tierFromDiff, weakensConfig } from './sensors.ts'
import { scopeOf, selectScopes, closureRoots, extraScopes } from './scopes.ts'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

const cfg = (extra: object = {}) => parseConfig(JSON.stringify({ scopes: {
  'packages/shared/**': { name: 'shared', root: 'packages/shared' },
  'packages/api/**': { name: 'api', root: 'packages/api', deps: ['packages/shared/**'] },
  'packages/web/**': { name: 'web', root: 'packages/web', deps: ['packages/api/**'] },
  'packages/api/generated/**': { name: 'gen', root: 'packages/api/generated' },
  'tools/**': { name: 'tools', root: 'tools' },
}, ...extra })).config

test('the longest matching glob wins, and files outside every scope are unscoped', () => {
  const c = cfg()
  assert.equal(scopeOf('packages/api/src/a.ts', c), 'packages/api/**')
  assert.equal(scopeOf('packages/api/generated/x.ts', c), 'packages/api/generated/**')
  assert.equal(scopeOf('README.md', c), null)
})

test('affected = touched plus dependents, transitively; deleted and renamed paths select by their path', () => {
  const c = cfg()
  assert.deepEqual(selectScopes(['packages/shared/a.ts'], c), { touched: ['shared'], affected: ['api', 'shared', 'web'], unscoped: [] })
  assert.deepEqual(selectScopes(['packages/web/x.ts'], c).affected, ['web'])
  assert.deepEqual(selectScopes(['packages/api/src/old.ts', 'tools/run.sh', 'LICENSE'], c), { touched: ['api', 'tools'], affected: ['api', 'tools', 'web'], unscoped: ['LICENSE'] })
})

test('a deps cycle terminates', () => {
  const c = parseConfig(JSON.stringify({ scopes: {
    'a/**': { name: 'a', root: 'a', deps: ['b/**'] }, 'b/**': { name: 'b', root: 'b', deps: ['a/**'] },
  } })).config
  assert.deepEqual(selectScopes(['a/x.ts'], c).affected, ['a', 'b'])
})

test('closureRoots lists the roots of the scopes and of what they depend on', () => {
  assert.deepEqual(closureRoots(cfg(), ['web']), ['packages/api', 'packages/shared', 'packages/web'])
})

test('extra scope names from the affected command are added; unknown names are ignored', () => {
  const c = cfg({ affected: 'node -e "console.log(\'tools\\nnonesuch\\n\')"' })
  assert.deepEqual(extraScopes(c), ['tools'])
  assert.deepEqual(selectScopes(['packages/web/x.ts'], c, extraScopes(c)).affected, ['tools', 'web'])
})

test('a diff touching more scopes than scopeLimit is tier L', () => {
  const c = cfg({ scopeLimit: 2 })
  const d = (file: string) => ({ file, status: 'M' as const, added: [{ n: 1, text: 'x' }], removed: [] })
  assert.equal(tierFromDiff([d('packages/web/a.ts'), d('tools/b.sh')], c), 'S')
  assert.equal(tierFromDiff([d('packages/web/a.ts'), d('tools/b.sh'), d('packages/shared/c.ts')], c), 'L')
})

test('removing a scope or a dependency edge, or raising scopeLimit, is a weakening edit', () => {
  const before = JSON.stringify({ scopes: { 'a/**': { name: 'a', root: 'a', deps: ['b/**'] }, 'b/**': { name: 'b', root: 'b' } }, scopeLimit: 2 })
  const noEdge = JSON.stringify({ scopes: { 'a/**': { name: 'a', root: 'a' }, 'b/**': { name: 'b', root: 'b' } }, scopeLimit: 2 })
  const noScope = JSON.stringify({ scopes: { 'a/**': { name: 'a', root: 'a', deps: [] } }, scopeLimit: 2 })
  const looser = JSON.stringify({ scopes: JSON.parse(before).scopes, scopeLimit: 9 })
  assert.match(weakensConfig(before, noEdge).join(), /scope a\/\*\* lost dependency b\/\*\*/)
  assert.match(weakensConfig(before, noScope).join(), /scope b\/\*\* removed/)
  assert.match(weakensConfig(before, looser).join(), /scopeLimit raised 2 → 9/)
  assert.deepEqual(weakensConfig(before, before), [])
})

test('the unscoped sensor warns when scopes are declared and a changed source file matches none', () => {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: { 'pkg/**': { name: 'pkg', root: 'pkg' } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, 'pkg/a.js', 'export const a = 1\n'); write(repo, 'loose/b.js', 'export const b = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'work')
  const r = sdlc(repo, ['check', '--at', 'ci', '--base', 'main'])
  assert.match(r.stdout, /unscoped/)
  assert.match(r.stdout, /loose\/b\.js/)
  assert.equal(r.code, 0, 'a warning, not a block')
})
