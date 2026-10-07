// Unplanned ("vibe") work: no /rig:start, no active change. Every sensor still fires at edit, stop, commit and CI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'
import path from 'node:path'

type Case = { sensor: string; file: string; text: string; config: object }
const CASES: Case[] = [
  { sensor: 'secrets', file: 'src/a.js', text: 'const apikey = "abcdefghijklmnop12345678"\n', config: {} },
  { sensor: 'suppression', file: 'src/a.js', text: '// eslint-disable-next-line no-console\nconsole.log(1)\n', config: {} },
  { sensor: 'layering', file: 'src/domain/a.js', text: "import db from '../infra/db.js'\n", config: { layers: [{ from: 'src/domain/**', mustNotImport: ['infra'], why: 'domain is pure' }] } },
]

function fresh(c: Case) {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify(c.config))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  return repo
}

for (const c of CASES) {
  test(`${c.sensor}: blocked at edit with no active change`, () => {
    const repo = fresh(c)
    hook(repo, 'prompt-submit', {})
    write(repo, c.file, c.text)
    const r = hook(repo, 'post-edit', { session_id: 's', tool_input: { file_path: path.join(repo, c.file) } })
    assert.equal(r.code, 2, r.stdout + r.stderr)
    assert.match(r.stderr, new RegExp(c.sensor === 'secrets' ? 'secret|key|token' : c.sensor, 'i'))
  })

  test(`${c.sensor}: blocked at Stop, and the work is adopted as an ad-hoc change`, () => {
    const repo = fresh(c)
    hook(repo, 'prompt-submit', {})
    write(repo, c.file, c.text)
    const r = hook(repo, 'stop', { session_id: 's' })
    const out = JSON.parse(r.stdout)
    assert.equal(out.decision, 'block')
    assert.match(out.reason, new RegExp(c.sensor))
    assert.match(sdlc(repo, ['status']).stdout, /adhoc-/)
  })

  test(`${c.sensor}: blocked at commit`, () => {
    const repo = fresh(c)
    write(repo, c.file, c.text)
    gitIn(repo, 'add', c.file)
    const r = sdlc(repo, ['check', '--at', 'commit'])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, new RegExp(c.sensor))
  })

  test(`${c.sensor}: blocked in CI against the base branch`, () => {
    const repo = fresh(c)
    gitIn(repo, 'checkout', '-qb', 'feature')
    write(repo, c.file, c.text)
    gitIn(repo, 'add', c.file); gitIn(repo, 'commit', '-qm', 'work')
    const r = sdlc(repo, ['check', '--at', 'ci', '--base', 'main'])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, new RegExp(c.sensor))
  })
}

test('the same forbidden import typed through a shell is stopped at commit and in CI, not only at edit', () => {
  const c = CASES[2] as Case
  const repo = fresh(c)
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, c.file, c.text) // written by a shell, an editor or another agent: no hook saw it
  gitIn(repo, 'add', c.file)
  assert.equal(sdlc(repo, ['check', '--at', 'commit']).code, 1)
  gitIn(repo, 'commit', '-qm', 'sneaked', '--no-verify')
  assert.equal(sdlc(repo, ['check', '--at', 'ci', '--base', 'main']).code, 1)
})

test('layering at edit: a forbidden import this turn adds blocks and names the rule; a legacy one is not blamed', () => {
  const c = CASES[2] as Case
  const repo = fresh(c)
  write(repo, 'src/domain/old.js', "import db from '../infra/db.js'\n") // legacy violation, committed before the turn
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'legacy')
  hook(repo, 'prompt-submit', {})
  const post = (rel: string) => hook(repo, 'post-edit', { session_id: 's', tool_input: { file_path: path.join(repo, rel) } })
  write(repo, 'src/domain/clean.js', 'export const ok = 1\n')
  const other = post('src/domain/clean.js')
  assert.equal(other.code, 0, other.stderr)
  write(repo, 'src/domain/old.js', "import db from '../infra/db.js'\nexport const touched = 1\n")
  const legacy = post('src/domain/old.js')
  assert.equal(legacy.code, 0, `the import predates the turn baseline: ${legacy.stderr}`)
  write(repo, 'src/domain/new.js', "import db from '../infra/db.js'\n")
  const added = post('src/domain/new.js')
  assert.equal(added.code, 2, added.stdout + added.stderr)
  assert.match(added.stderr, /layering/)
  assert.match(added.stderr, /src\/domain\/\*\* must not import infra: domain is pure/)
})
