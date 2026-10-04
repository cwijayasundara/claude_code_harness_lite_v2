// Quality categories: counting, the base-branch comparison, unmeasured and failing commands, and the test-count invariant.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { countFindings } from './quality.ts'

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
