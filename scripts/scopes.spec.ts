import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from './model.ts'
import { tierFromDiff, weakensConfig } from './sensors.ts'
import { scopeOf, selectScopes, closureRoots, extraScopes, scopeCommands } from './scopes.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn, hook } from './testkit.ts'

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

test('the affected command is read in full from stdout: 60 names survive stderr noise', () => {
  const scopes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}/**`, { name: `s${i}`, root: `s${i}` }]))
  const script = 'for(let i=0;i<60;i++){console.log("s"+i);console.error("noise "+i)}'
  const c = parseConfig(JSON.stringify({ scopes, affected: `node -e '${script}'` })).config
  assert.equal(extraScopes(c)?.length, 60)
})

test('a scope losing, emptying or changing a command, or moving its root, is a weakening edit', () => {
  const base = { 'a/**': { name: 'a', root: 'a', fast: { test: 'npm test' }, full: { e2e: 'npm run e2e' }, quality: { lint: { cmd: 'eslint .', count: 'lines' } } } }
  const with_ = (s: object) => JSON.stringify({ scopes: { 'a/**': { ...base['a/**'], ...s } } })
  const before = with_({})
  assert.match(weakensConfig(before, with_({ fast: {} })).join(), /scope a\/\*\* fast\.test removed/)
  assert.match(weakensConfig(before, with_({ fast: { test: 'true' } })).join(), /scope a\/\*\* fast\.test changed/)
  assert.match(weakensConfig(before, with_({ full: { e2e: '' } })).join(), /scope a\/\*\* full\.e2e (?:removed|changed)/)
  assert.match(weakensConfig(before, with_({ quality: {} })).join(), /scope a\/\*\* quality\.lint removed/)
  assert.match(weakensConfig(before, with_({ quality: { lint: { cmd: 'true', count: 'lines' } } })).join(), /scope a\/\*\* quality\.lint changed/)
  assert.match(weakensConfig(before, with_({ root: 'a/src' })).join(), /scope a\/\*\* root changed a → a\/src/)
  assert.deepEqual(weakensConfig(before, before), [])
  assert.deepEqual(weakensConfig(before, with_({ fast: { test: 'npm test', lint: 'eslint .' } })), [], 'adding a command is not weakening')
})

test('a new scope with no commands weakens a config that already declares scopes; one with commands does not', () => {
  const before = JSON.stringify({ scopes: { 'a/**': { name: 'a', root: 'a', fast: { test: 'npm test' } } } })
  const add = (s: object) => JSON.stringify({ scopes: { ...JSON.parse(before).scopes, 'a/gen/**': { name: 'gen', root: 'a/gen', ...s } } })
  // The reason names each missing kind (final-review fix); this base runs only fast commands.
  assert.deepEqual(weakensConfig(before, add({})), ['scope a/gen/** added with no fast command'])
  assert.deepEqual(weakensConfig(before, add({ fast: { test: 'npm test' } })), [])
  assert.deepEqual(weakensConfig('{}', JSON.stringify({ scopes: { 'a/**': { name: 'a', root: 'a' } } })), [], 'the first scopes are adoption, not weakening')
})

test('backticks in a warning cannot close the step summary fence', () => {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: { 'pkg/**': { name: 'pkg', root: 'pkg' } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, 'loose/a```b.js', 'export const b = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'work')
  const summary = path.join(repo, 'summary.md')
  sdlc(repo, ['check', '--at', 'ci', '--base', 'main'], { env: { GITHUB_STEP_SUMMARY: summary } })
  const text = fs.readFileSync(summary, 'utf8')
  assert.match(text, /loose\/a/)
  assert.equal(text.split('\n').filter(l => l.startsWith('```')).length % 2, 0, text)
  assert.doesNotMatch(text.split('\n').filter(l => !/^```\s*$/.test(l)).join('\n'), /`/, text)
})

test('a failing or timed-out affected command fails closed: null, and every declared scope is affected', () => {
  const failing = cfg({ affected: 'node -e "process.exit(1)"' })
  assert.equal(extraScopes(failing), null)
  assert.deepEqual(selectScopes(['packages/web/x.ts'], failing, extraScopes(failing)), { touched: ['web'], affected: ['api', 'gen', 'shared', 'tools', 'web'], unscoped: [] })
  const slow = cfg({ affected: 'node -e "setTimeout(() => console.log(\'tools\'), 5000)"' })
  assert.equal(extraScopes(slow, 300), null)
  assert.deepEqual(extraScopes(cfg()), [], 'no affected command declared')
})

const mark = (name: string): { file: string; cmd: string } => {
  const file = path.join(os.tmpdir(), `rig-scope-${process.pid}-${name}-${Math.random().toString(36).slice(2)}.txt`)
  return { file, cmd: `node -e "require('fs').appendFileSync('${file}','x')"` }
}
const ran = (m: { file: string }): number => (fs.existsSync(m.file) ? fs.readFileSync(m.file, 'utf8').length : 0)

function monorepo(extra: object = {}) {
  const root = mark('root'), api = mark('api'), web = mark('web'), shared = mark('shared')
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({
    fast: { root: root.cmd },
    scopes: {
      'packages/shared/**': { name: 'shared', root: 'packages/shared', fast: { t: shared.cmd } },
      'packages/api/**': { name: 'api', root: 'packages/api', fast: { t: api.cmd }, deps: ['packages/shared/**'] },
      'packages/web/**': { name: 'web', root: 'packages/web', fast: { t: web.cmd } },
    },
    ...extra,
  }))
  for (const p of ['shared', 'api', 'web']) write(repo, `packages/${p}/index.js`, 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  return { repo, root, api, web, shared }
}
const stopAfterEdit = (repo: string, rel: string) => {
  hook(repo, 'prompt-submit', {})
  write(repo, rel, 'export const x = 1\n')
  return hook(repo, 'stop', { session_id: 's' })
}

test('Stop runs only the fast commands of the scopes the turn touched, and their dependents', () => {
  const { repo, root, api, web, shared } = monorepo()
  stopAfterEdit(repo, 'packages/shared/new.js')
  assert.deepEqual([ran(shared), ran(api), ran(web), ran(root)], [1, 1, 0, 0], 'shared and its dependent api; not web; not the root fallback')
})

test('a changed file outside every scope runs the top-level commands too', () => {
  const { repo, root, api, web, shared } = monorepo()
  stopAfterEdit(repo, 'loose.js')
  assert.deepEqual([ran(root), ran(api), ran(web), ran(shared)], [1, 0, 0, 0])
})

test('a failing affected command fails closed: every scope runs, with a warning', () => {
  const { repo, root, api, web, shared } = monorepo({ affected: 'node -e "process.exit(3)"' })
  const res = stopAfterEdit(repo, 'packages/web/new.js')
  assert.deepEqual([ran(shared), ran(api), ran(web), ran(root)], [1, 1, 1, 0])
  assert.match(res.stdout + res.stderr, /affected command failed, so every scope ran/)
})

test('scoped commands run in the scope root', () => {
  const repo = makeRepo()
  const out = path.join(os.tmpdir(), `rig-cwd-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: { 'pkg/**': { name: 'pkg', root: 'pkg', fast: { t: `node -e "require('fs').writeFileSync('${out}', process.cwd())"` } } } }))
  write(repo, 'pkg/a.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  stopAfterEdit(repo, 'pkg/b.js')
  assert.equal(fs.realpathSync(fs.readFileSync(out, 'utf8')), fs.realpathSync(path.join(repo, 'pkg')))
})

test('a scoped failure is reported with the scope in its key', () => {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: { 'pkg/**': { name: 'pkg', root: 'pkg', fast: { t: 'node -e "process.exit(1)"' } } } }))
  write(repo, 'pkg/a.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  const out = JSON.parse(stopAfterEdit(repo, 'pkg/b.js').stdout)
  assert.match(out.reason, /pkg:fast\.t failed/)
})

test('CI runs the selected scopes from the diff, and everything with ci.scope all', () => {
  for (const [ciScope, expected] of [['affected', [1, 0]], ['all', [1, 1]]] as const) {
    const api = mark('api'), web = mark('web')
    const repo = makeRepo()
    write(repo, '.sdlc/sensors.json', JSON.stringify({
      ci: { scope: ciScope },
      full: {},
      scopes: { 'api/**': { name: 'api', root: 'api', full: { t: api.cmd } }, 'web/**': { name: 'web', root: 'web', full: { t: web.cmd } } },
    }))
    write(repo, 'web/index.js', 'export {}\n')
    gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
    gitIn(repo, 'checkout', '-qb', 'feature')
    write(repo, 'api/a.js', 'export {}\n')
    gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'api change')
    sdlc(repo, ['check', '--at', 'ci', '--base', 'main'])
    assert.deepEqual([ran(api), ran(web)], expected, ciScope)
  }
})

test('verify runs the full commands of the scopes the branch touches, once each', () => {
  const m = mark('full')
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { t: 'node -e "process.exit(0)"' }, scopes: { 'pkg/**': { name: 'pkg', root: 'pkg', full: { t: m.cmd } }, 'other/**': { name: 'other', root: 'other', full: { t: m.cmd.replace(/x'/, 'y\'') } } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/vf')
  sdlc(repo, ['new', 'vf', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/vf/plan.md', '## Files\n- pkg/a.js\n## Verification\n- `node -e "process.exit(0)"`\n')
  write(repo, 'pkg/a.js', 'export {}\n')
  sdlc(repo, ['verify', 'vf'])
  assert.equal(ran(m), 1)
})

test('a scope whose root is not a directory blocks instead of running its command elsewhere', () => {
  const m = mark('ghost')
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: { 'pkg/**': { name: 'pkg', root: 'nowhere', fast: { t: m.cmd } } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  const out = JSON.parse(stopAfterEdit(repo, 'pkg/b.js').stdout)
  assert.match(out.reason, /pkg:fast\.t not run: its scope root nowhere is not a directory/)
  assert.equal(ran(m), 0)
})

// Fix round 1
const stopAfterEdits = (repo: string, rels: string[]) => {
  hook(repo, 'prompt-submit', {})
  for (const rel of rels) write(repo, rel, 'export const x = 1\n')
  return hook(repo, 'stop', { session_id: 's' })
}
const scoped = (scopes: object, extra: object = {}) => {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes, ...extra }))
  for (const d of ['a', 'b', 'shared', 'pkg']) write(repo, `${d}/index.js`, 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  return repo
}

test('verify with no base to diff against runs every scope\'s full commands rather than none', () => {
  const m = mark('nobase')
  const repo = makeRepo()
  gitIn(repo, 'branch', '-m', 'trunk')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: { 'pkg/**': { name: 'pkg', root: 'pkg', full: { t: m.cmd } } } }))
  write(repo, 'pkg/a.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/nb')
  sdlc(repo, ['new', 'nb', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/nb/plan.md', '## Files\n- pkg/a.js\n## Verification\n- `node -e "process.exit(0)"`\n')
  sdlc(repo, ['verify', 'nb'])
  assert.equal(ran(m), 1)
})

test('the same command in the same resolved directory runs once, even across two scopes', () => {
  const m = mark('same')
  const repo = scoped({ 'a/**': { name: 'a', root: 'shared', fast: { t: m.cmd } }, 'b/**': { name: 'b', root: 'shared/', fast: { t: m.cmd } } })
  stopAfterEdits(repo, ['a/x.js', 'b/x.js'])
  assert.equal(ran(m), 1)
})

test('the same command in different scope roots runs in each', () => {
  const m = mark('diff')
  const repo = scoped({ 'a/**': { name: 'a', root: 'a', fast: { t: m.cmd } }, 'b/**': { name: 'b', root: 'b', fast: { t: m.cmd } } })
  stopAfterEdits(repo, ['a/x.js', 'b/x.js'])
  assert.equal(ran(m), 2)
})

test('a scope rooted at . is the repo root: verify does not rerun a command its plan loop already ran there', () => {
  const m = mark('dot')
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ levels: { unit: m.cmd }, scopes: { 'pkg/**': { name: 'pkg', root: '.', full: { t: m.cmd } } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/dot')
  sdlc(repo, ['new', 'dot', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/dot/plan.md', `## Files\n- pkg/a.js\n## Verification\n- \`${m.cmd}\`\n`)
  write(repo, 'pkg/a.js', 'export {}\n')
  sdlc(repo, ['verify', 'dot'])
  assert.equal(ran(m), 1)
})

test('the affected command is not run with no changed files, nor when the prefix has no scoped commands', () => {
  const m = mark('affected')
  const noFiles = scoped({ 'pkg/**': { name: 'pkg', root: 'pkg', fast: { t: 'node -e "0"' } } }, { affected: m.cmd })
  stopAfterEdits(noFiles, [])
  const fullOnly = scoped({ 'pkg/**': { name: 'pkg', root: 'pkg', full: { t: 'node -e "0"' } } }, { affected: m.cmd })
  stopAfterEdits(fullOnly, ['pkg/x.js'])
  assert.equal(ran(m), 0)
  const used = scoped({ 'pkg/**': { name: 'pkg', root: 'pkg', fast: { t: 'node -e "0"' } } }, { affected: m.cmd })
  stopAfterEdits(used, ['pkg/x.js'])
  assert.equal(ran(m), 1, 'it does run when there are files and scoped commands')
})

test('a scope root symlinked outside the repository blocks and does not run', () => {
  const m = mark('link')
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-outside-'))
  const repo = scoped({ 'pkg/**': { name: 'pkg', root: 'link', fast: { t: m.cmd } } })
  fs.symlinkSync(outside, path.join(repo, 'link'))
  const out = JSON.parse(stopAfterEdits(repo, ['pkg/x.js']).stdout)
  assert.match(out.reason, /pkg:fast\.t not run: its scope root link resolves outside the repository/)
  assert.equal(ran(m), 0)
})

// Final-review fix wave
test('a new scope must carry every kind of command the base runs, top-level or in any scope', () => {
  const lint = { lint: { cmd: 'eslint .', count: 'lines' } }
  const before = JSON.stringify({ full: { t: 'npm test' }, quality: lint, scopes: { 'a/**': { name: 'a', root: 'a', fast: { t: 'npm test' } } } })
  const add = (s: object) => JSON.stringify({ ...JSON.parse(before), scopes: { ...JSON.parse(before).scopes, 'a/gen/**': { name: 'gen', root: 'a/gen', ...s } } })
  assert.deepEqual(weakensConfig(before, add({ fast: { t: 'npm test' } })), ['scope a/gen/** added with no full command', 'scope a/gen/** added with no quality command'])
  assert.deepEqual(weakensConfig(before, add({ fast: { t: 'npm test' }, full: { t: 'npm test' }, quality: lint })), [], 'a scope with every kind the base runs')
  assert.deepEqual(weakensConfig(before, before), [])
  const unscopedBase = JSON.stringify({ full: { t: 'npm test' }, quality: lint })
  assert.deepEqual(weakensConfig(unscopedBase, JSON.stringify({ ...JSON.parse(unscopedBase), scopes: { 'a/**': { name: 'a', root: 'a' } } })), [], 'first scopes are adoption')
})

test('with scopes declared, an empty source diff plans nothing; verify alone falls back to the top-level commands', () => {
  const c = parseConfig(JSON.stringify({ full: { t: 'npm test' }, scopes: { 'pkg/**': { name: 'pkg', root: 'pkg', full: { u: 'npm run u' } } } })).config
  assert.deepEqual(scopeCommands('full', c, []), [])
  assert.deepEqual(scopeCommands('full', c, 'all').map(x => x.key), ['full.t', 'pkg:full.u'], "'all' is unchanged")
})

test('verify on a branch with no source changes runs the top-level full commands instead of stamping pass with none', () => {
  const m = mark('empty')
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ full: { t: m.cmd }, scopes: { 'pkg/**': { name: 'pkg', root: 'pkg', full: { u: 'node -e "0"' } } } }))
  write(repo, 'pkg/a.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/em')
  sdlc(repo, ['new', 'em', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/em/plan.md', '## Files\n- .sdlc/sensors.json\n## Verification\n- `node -e "process.exit(0)"`\n')
  sdlc(repo, ['verify', 'em'])
  assert.equal(ran(m), 1)
})

test('a docs-only diff in CI with ci.scope affected plans no commands, scoped or top-level', () => {
  const top = mark('docs-top'), sc = mark('docs-scope')
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ full: { t: top.cmd }, fast: { t: top.cmd }, ci: { scope: 'affected' }, scopes: { 'pkg/**': { name: 'pkg', root: 'pkg', full: { u: sc.cmd } } } }))
  write(repo, 'pkg/a.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, 'docs/guide.md', '# guide\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'docs')
  sdlc(repo, ['check', '--at', 'ci', '--base', 'main'])
  assert.deepEqual([ran(top), ran(sc)], [0, 0])
})
