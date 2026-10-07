// Quality categories: counting, the base-branch comparison, unmeasured and failing commands, and the test-count invariant.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { countFindings } from './quality.ts'
import { showMany } from './diffs.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })

test('countFindings: exit, lines and json paths', () => {
  assert.equal(countFindings('', 0, 'exit'), 0)
  assert.equal(countFindings('', 3, 'exit'), 1)
  assert.equal(countFindings('a\nb\n\nc\n', 1, 'lines'), 3)
  assert.equal(countFindings('{"metadata":{"vulnerabilities":{"total":4}}}', 1, 'json:metadata.vulnerabilities.total'), 4)
  assert.equal(countFindings('not json', 1, 'json:a.b'), null)
})

const LINT = 'node -e "const fs=require(\'fs\');for(const f of fs.readdirSync(\'src\'))if(fs.readFileSync(\'src/\'+f,\'utf8\').includes(\'TODO\'))console.log(f)"'

function onBranch() {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { lint: { cmd: LINT, count: 'lines' }, security: { cmd: 'node -e "process.exit(0)"', count: 'exit' } } }))
  write(repo, 'src/a.js', '// TODO old debt\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
}

test('existing debt on the base does not block; a regression does', () => {
  onBranch()
  write(repo, 'src/b.js', 'export const b = 1\n')
  assert.equal(sdlc(repo, ['quality', 'tiny']).code, 0, 'lint 1 on base, 1 on branch: no regression')
  write(repo, 'src/c.js', '// TODO new debt\n')
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /lint\s+base 1 → branch 2\s+regressed/)
})

test('a category with no command is unmeasured, never pass', () => {
  onBranch()
  assert.match(sdlc(repo, ['quality', 'tiny']).stdout, /types\s+unmeasured/)
})

test('a command that cannot run is fail, not pass', () => {
  onBranch()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { deps: { cmd: 'definitely-not-a-command-xyz', count: 'json:a' } } }))
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /deps\s+fail/)
})

test('with no base, quality categories are unmeasured and do not block', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { lint: { cmd: LINT, count: 'lines' } } }))
  write(repo, 'src/a.js', '// TODO\n')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /lint\s+unmeasured \(no base\)/)
})

test('the test count never drops below the base', () => {
  onBranch()
  write(repo, 'test/a.test.js', "test('a', () => {})\ntest('b', () => {})\n")
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'tests')
  gitIn(repo, 'checkout', '-q', 'main'); gitIn(repo, 'merge', '-q', 'sdlc/tiny'); gitIn(repo, 'checkout', '-q', 'sdlc/tiny')
  write(repo, 'test/a.test.js', "test('a', () => {})\n")
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /test cases: base 2 → branch 1/)
})

test('the base worktree is removed afterwards and leaves no stale metadata', () => {
  onBranch()
  sdlc(repo, ['quality', 'tiny'])
  assert.equal(gitIn(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1)
  assert.ok(fs.existsSync(repo))
})

test('a slug that is a path or names no change is refused and nothing is written', () => {
  onBranch()
  const before = fs.readFileSync(`${repo}/.sdlc/changes/tiny/ratchet.json`, 'utf8')
  for (const args of [['quality', '../x'], ['quality', '..'], ['quality', '../..'], ['ratchet', 'show', '..'], ['ratchet', 'record', '../x', 'build']]) {
    const r = sdlc(repo, args, { input: 'verdict: pass\n' })
    assert.notEqual(r.code, 0, args.join(' '))
  }
  assert.equal(fs.existsSync(`${repo}/.sdlc/ratchet.json`), false)
  assert.equal(fs.existsSync(`${repo}/x`), false)
  assert.equal(fs.readFileSync(`${repo}/.sdlc/changes/tiny/ratchet.json`, 'utf8'), before)
  const r = sdlc(repo, ['quality', 'nosuch'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /no change named nosuch/)
})

test('the base worktree can use the checkout dependency directories', () => {
  write(repo, 'node_modules/fake-lint.js', "console.log('one')\n")
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { lint: { cmd: 'node node_modules/fake-lint.js', count: 'lines' } } }))
  write(repo, '.gitignore', 'node_modules\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.match(r.stdout, /lint\s+base 1 → branch 1\s+pass/)
})

test('the base cache is keyed on the command; unmeasured bases are not cached', () => {
  onBranch()
  sdlc(repo, ['quality', 'tiny'])
  const cache = JSON.parse(fs.readFileSync(`${repo}/.sdlc/changes/tiny/ratchet.json`, 'utf8')).baseline.quality
  assert.deepEqual(cache.lint, { cmd: LINT, count: 'lines', n: 1 })
  const quiet = 'node -e "process.exit(0)"'
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { lint: { cmd: quiet, count: 'lines' } } }))
  assert.match(sdlc(repo, ['quality', 'tiny']).stdout, /lint\s+base 0 → branch 0\s+pass/, 'a changed command is measured again on the base')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { deps: { cmd: 'definitely-not-a-command-xyz', count: 'exit' } } }))
  sdlc(repo, ['quality', 'tiny'])
  assert.equal(JSON.parse(fs.readFileSync(`${repo}/.sdlc/changes/tiny/ratchet.json`, 'utf8')).baseline.quality.deps, undefined)
})

test('showMany reads many blobs in one call, maps a missing path to an empty string and survives a newline in a name', () => {
  const got = showMany('HEAD', ['package.json', 'no/such/file.txt', 'scripts/quality.ts', 'odd\nname.txt'])
  assert.match(got.get('package.json') ?? '', /"name": "rig-plugin"/)
  assert.equal(got.get('no/such/file.txt'), '')
  assert.match(got.get('scripts/quality.ts') ?? '', /The sensors node/)
  assert.equal(got.get('odd\nname.txt'), '')
  assert.equal(showMany('HEAD', []).size, 0)
})

const withTwoTests = () => {
  onBranch()
  write(repo, 'test/a.test.js', "test('a', () => {})\ntest('b', () => {})\n")
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'tests')
  gitIn(repo, 'checkout', '-q', 'main'); gitIn(repo, 'merge', '-q', 'sdlc/tiny'); gitIn(repo, 'checkout', '-q', 'sdlc/tiny')
}

test('a renamed test file keeps its cases: no test-count finding', () => {
  withTwoTests()
  gitIn(repo, 'mv', 'test/a.test.js', 'test/b.test.js')
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.doesNotMatch(r.stdout, /test cases:/)
})

test('deleting a test file lowers the count and blocks', () => {
  withTwoTests()
  fs.rmSync(`${repo}/test/a.test.js`)
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /test cases: base 2 → branch 0/)
})

test('adding tests, editing a non-test file and an empty test file never block', () => {
  withTwoTests()
  write(repo, 'test/c.test.js', "test('c', () => {})\n")
  write(repo, 'test/empty.test.js', '')
  write(repo, 'src/a.js', 'export const a = 1\n')
  assert.doesNotMatch(sdlc(repo, ['quality', 'tiny']).stdout, /test cases:/)
})

test('a binary file under test/ is ignored by the count', () => {
  withTwoTests()
  fs.writeFileSync(`${repo}/test/fixture.test.bin`, Buffer.from([0, 1, 2, 0, 3]))
  assert.doesNotMatch(sdlc(repo, ['quality', 'tiny']).stdout, /test cases:/)
})

test('moving a test file out of the test glob lowers the count and blocks', () => {
  withTwoTests()
  gitIn(repo, 'mv', 'test/a.test.js', 'src/moved.js')
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /test cases: base 2 → branch 0/)
})

test('moving a non-test file into the test glob does not count its old test( calls as base cases', () => {
  withTwoTests()
  write(repo, 'src/x.js', "test('x', () => {})\ntest('y', () => {})\ntest('z', () => {})\nconst a = 1\nconst b = 2\nconst c = 3\nconst d = 4\nconst e = 5\n")
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'x')
  gitIn(repo, 'checkout', '-q', 'main'); gitIn(repo, 'merge', '-q', 'sdlc/tiny'); gitIn(repo, 'checkout', '-q', 'sdlc/tiny')
  gitIn(repo, 'mv', 'src/x.js', 'test/x.test.js')
  write(repo, 'test/x.test.js', "test('x', () => {})\nconst a = 1\nconst b = 2\nconst c = 3\nconst d = 4\nconst e = 5\n")
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.doesNotMatch(r.stdout, /test cases:/)
  assert.equal(r.code, 0)
})

test('a test file that was text at base and became binary still counts at base', () => {
  withTwoTests()
  fs.writeFileSync(`${repo}/test/a.test.js`, Buffer.from([0, 1, 2, 0, 3]))
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /test cases: base 2 → branch 0/)
})

test('scoped quality counts only the affected scopes, and keys them by scope', () => {
  const lintApi = 'node -e "const fs=require(\'fs\');for(const f of fs.readdirSync(\'.\'))if(f.endsWith(\'.js\')&&fs.readFileSync(f,\'utf8\').includes(\'TODO\'))console.log(f)"'
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: {
    'api/**': { name: 'api', root: 'api', quality: { lint: { cmd: lintApi, count: 'lines' } } },
    'web/**': { name: 'web', root: 'web', quality: { lint: { cmd: 'node -e "console.log(\'always\')"', count: 'lines' } } },
  } }))
  write(repo, 'api/a.js', '// TODO old\n'); write(repo, 'web/w.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, 'api/b.js', '// TODO new\n')
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /api:lint\s+base 1 → branch 2\s+regressed/)
  assert.doesNotMatch(r.stdout, /web:lint/, 'web was not touched, so it is not measured')
})

test('with sparseBase the base is checked out sparse over the affected scopes and what they depend on', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ sparseBase: true, scopes: {
    'api/**': { name: 'api', root: 'api', deps: ['shared/**'], quality: { lint: { cmd: 'node -e "const fs=require(\'fs\');console.log([fs.existsSync(\'../shared/s.js\'),fs.existsSync(\'../web/w.js\')].join(\'-\'))"', count: 'lines' } } },
    'shared/**': { name: 'shared', root: 'shared' }, 'web/**': { name: 'web', root: 'web' },
  } }))
  for (const f of ['api/a.js', 'shared/s.js', 'web/w.js']) write(repo, f, 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, 'api/b.js', 'export {}\n')
  assert.equal(sdlc(repo, ['quality', 'tiny']).code, 0)
  const cache = JSON.parse(fs.readFileSync(`${repo}/.sdlc/changes/tiny/ratchet.json`, 'utf8')).baseline.quality
  assert.equal(cache['api:lint'].n, 1, 'one output line on the base: shared exists there, web was left out')
})

test('the sparse base leaves out scopes the change does not reach (counted by what exists there)', () => {
  const probe = 'node -e "const fs=require(\'fs\');if(!fs.existsSync(\'../shared/s.js\'))console.log(\'no shared\');if(fs.existsSync(\'../web/w.js\'))console.log(\'web\')"'
  write(repo, '.sdlc/sensors.json', JSON.stringify({ sparseBase: true, scopes: {
    'api/**': { name: 'api', root: 'api', deps: ['shared/**'], quality: { lint: { cmd: probe, count: 'lines' } } },
    'shared/**': { name: 'shared', root: 'shared' }, 'web/**': { name: 'web', root: 'web' },
  } }))
  for (const f of ['api/a.js', 'shared/s.js', 'web/w.js']) write(repo, f, 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, 'api/b.js', 'export {}\n')
  sdlc(repo, ['quality', 'tiny'])
  const cache = JSON.parse(fs.readFileSync(`${repo}/.sdlc/changes/tiny/ratchet.json`, 'utf8')).baseline.quality
  assert.equal(cache['api:lint'].n, 0, 'shared is in the sparse base and web is not')
})

test('scoped quality: a failing affected command measures every scope and warns', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ affected: 'node -e "process.exit(3)"', scopes: {
    'api/**': { name: 'api', root: 'api', quality: { lint: { cmd: 'node -e "0"', count: 'lines' } } },
    'web/**': { name: 'web', root: 'web', quality: { lint: { cmd: 'node -e "0"', count: 'lines' } } },
  } }))
  write(repo, 'api/a.js', 'export {}\n'); write(repo, 'web/w.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, 'api/b.js', 'export {}\n')
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /web:lint\s+base 0 → branch 0\s+pass/)
  assert.match(r.stdout, /the affected command failed, so every scope ran/)
})

test('scoped quality: a scope root that resolves outside the repository fails instead of running there', () => {
  const outside = fs.mkdtempSync(`${repo}-outside-`)
  write(repo, '.sdlc/sensors.json', JSON.stringify({ scopes: {
    'api/**': { name: 'api', root: 'link', quality: { lint: { cmd: 'node -e "0"', count: 'lines' } } },
  } }))
  fs.symlinkSync(outside, `${repo}/link`)
  write(repo, 'api/a.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, 'api/b.js', 'export {}\n')
  const r = sdlc(repo, ['quality', 'tiny'])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /api:lint\s+fail \(its scope root link resolves outside the repository\)/)
})

test('a cached base count is reused only for the same scope root and checkout', () => {
  const list = 'node -e "for(const f of require(\'fs\').readdirSync(\'.\'))console.log(f)"'
  const cfg = (root: string) => JSON.stringify({ scopes: { 'api/**': { name: 'api', root, quality: { lint: { cmd: list, count: 'lines' } } } } })
  write(repo, '.sdlc/sensors.json', cfg('api'))
  write(repo, 'api/a.js', 'export {}\n'); write(repo, 'api2/a.js', 'export {}\n'); write(repo, 'api2/c.js', 'export {}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, 'api/b.js', 'export {}\n')
  sdlc(repo, ['quality', 'tiny'])
  const cache = () => JSON.parse(fs.readFileSync(`${repo}/.sdlc/changes/tiny/ratchet.json`, 'utf8')).baseline.quality
  assert.equal(cache()['api:lint'].n, 1)
  write(repo, '.sdlc/sensors.json', cfg('api2'))
  sdlc(repo, ['quality', 'tiny'])
  assert.equal(cache()['api:lint'].n, 2, 'same key, command and base, another root: measured again')
  assert.equal(cache()['api:lint'].cwd, 'api2')
})
