// Unplanned ("vibe") work: no /rig:start, no active change. Every sensor still fires at edit, stop, commit and CI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'
import path from 'node:path'

// atEdit: false where editFindings (check.ts) does not run the sensor. The spec (do-it-once design, "At edit") lists
// layering for post-edit, but no version of the edit hooks has run it; Stop, commit and CI do.
type Case = { sensor: string; file: string; text: string; config: object; atEdit: boolean }
const CASES: Case[] = [
  { sensor: 'secrets', file: 'src/a.js', text: 'const apikey = "abcdefghijklmnop12345678"\n', config: {}, atEdit: true },
  { sensor: 'suppression', file: 'src/a.js', text: '// eslint-disable-next-line no-console\nconsole.log(1)\n', config: {}, atEdit: true },
  { sensor: 'layering', file: 'src/domain/a.js', text: "import db from '../infra/db.js'\n", config: { layers: [{ from: 'src/domain/**', mustNotImport: ['infra'], why: 'domain is pure' }] }, atEdit: false },
]

function fresh(c: Case) {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify(c.config))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  return repo
}

for (const c of CASES) {
  if (c.atEdit) test(`${c.sensor}: blocked at edit with no active change`, () => {
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
