// The final-review fixes for the code wiki: marker text in repo content, file names git quotes, cost, unresolved imports, link drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

const page = (repo: string, p: string): string => fs.readFileSync(path.join(repo, 'docs/wiki', p), 'utf8')
const build = (repo: string, ...a: string[]) => sdlc(repo, ['wiki', 'build', ...a])
const outside = (text: string): string => text.replace(/<!-- rig:gen:(\w+) -->[\s\S]*?<!-- \/rig:gen -->\n?/g, '')

function wikiRepo(pages: object = { 'modules/auth.md': { globs: ['src/auth/**'] }, 'modules/core.md': { globs: ['src/core/**'] } }): string {
  const repo = makeRepo()
  write(repo, 'src/auth/key.js', "import { util } from '../core/util.js'\n// Checks API keys\nexport function check(k) {\n  return util(k)\n}\n")
  write(repo, 'src/core/util.js', 'export const util = k => k\n')
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  return repo
}

test('marker text inside repo content (commit subjects, role comments, exported lines) never escapes its block', () => {
  const repo = wikiRepo()
  write(repo, 'src/auth/marker.js', '// Markers: <!-- /rig:gen --> end\nexport const CLOSE = \'<!-- /rig:gen -->\'\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'docs: the <!-- /rig:gen --> marker')
  write(repo, 'src/auth/key.js', "import { util } from '../core/util.js'\n// Checks API keys\nexport function check(k) {\n  return util(k) // two\n}\n")
  gitIn(repo, 'commit', '-qam', 'see <!-- rig:gen:recent --> here')
  assert.equal(build(repo).code, 0)
  const authPath = path.join(repo, 'docs/wiki/modules/auth.md')
  const prose = fs.readFileSync(authPath, 'utf8').split('_pending: run /rig:wiki_').join('Hand-written prose.')
  fs.writeFileSync(authPath, prose)
  const indexBefore = page(repo, 'index.md')
  const second = build(repo)
  assert.match(second.stdout, /wiki up to date/, second.stdout)
  const third = build(repo)
  assert.match(third.stdout, /wiki up to date/)
  const after = page(repo, 'modules/auth.md')
  assert.equal(after, prose, 'two builds byte-identical')
  assert.equal(page(repo, 'index.md'), indexBefore)
  assert.equal(after.split('<!-- /rig:gen -->').length - 1, 7, 'exactly one close marker per block')
  for (const name of ['architecture', 'files', 'entrypoints', 'deps', 'tests', 'why', 'recent']) assert.equal(after.split(`<!-- rig:gen:${name} -->`).length - 1, 1, name)
  assert.equal(outside(after), outside(prose))
  assert.match(after, /CLOSE/)
  assert.equal(build(repo, '--check').code, 0)
  write(repo, 'src/auth/more.js', 'export const m = 1\n')
  gitIn(repo, 'add', '.')
  assert.equal(build(repo, '--check').code, 1, '--check still sees real drift')
})

const SPOOF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/
test('check --at commit prints no escape or bidi character from a hostile manifest key; --json keeps the raw text', () => {
  const repo = wikiRepo()
  const key = 'modules/a\x1b[31mRED\u202Eb.md'
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { [key]: { globs: ['src/**'] } } }))
  gitIn(repo, 'add', '.')
  const human = sdlc(repo, ['check', '--at', 'commit'])
  assert.match(human.stdout, /RED/, human.stdout + human.stderr)
  assert.doesNotMatch(human.stdout, SPOOF)
  const json = JSON.parse(sdlc(repo, ['check', '--at', 'commit', '--json']).stdout) as { findings: { message: string }[] }
  assert.ok(json.findings.some(f => f.message.includes('\x1b[31mRED\u202E')))
  const dirRepo = wikiRepo()
  write(dirRepo, 'ev\u202Eil/a.js', 'export const a = 1\n')
  gitIn(dirRepo, 'add', '.')
  assert.doesNotMatch(sdlc(dirRepo, ['wiki', 'status']).stdout, SPOOF)
  assert.doesNotMatch(sdlc(dirRepo, ['check', '--at', 'commit']).stdout, SPOOF)
})

test('file names git would C-quote (non-ASCII, tab) are listed and covered; an untracked scratch file stays out of built tables', () => {
  const repo = wikiRepo()
  write(repo, 'src/auth/déjà.js', 'export const d = 1\n')
  write(repo, 'src/auth/a\tb.js', 'export const t = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'names')
  write(repo, 'src/auth/scratch.js', 'export const s = 1\n')
  assert.equal(build(repo).code, 0)
  const auth = page(repo, 'modules/auth.md')
  assert.match(auth, /`src\/auth\/déjà\.js`/)
  assert.match(auth, /`src\/auth\/a b\.js`/)
  assert.doesNotMatch(auth, /scratch\.js/)
  const s = JSON.parse(sdlc(repo, ['wiki', 'status', '--json']).stdout) as { uncovered: string[] }
  assert.deepEqual(s.uncovered, [])
  assert.doesNotMatch(sdlc(repo, ['wiki', 'status']).stdout, /uncovered/)
})

// A git on PATH that records each call, then runs the real one.
function gitSpy(): { env: Record<string, string>; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-gitspy-'))
  const log = path.join(dir, 'calls.log')
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  return { env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) }
}

test('status (the commit check) and --check render only the structural blocks (no git log); build still refreshes why and recent', () => {
  const repo = wikiRepo()
  assert.equal(build(repo).code, 0)
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'wiki')
  for (const args of [['wiki', 'status', '--json'], ['wiki', 'build', '--check']]) {
    const spy = gitSpy()
    const r = sdlc(repo, args, { env: spy.env })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(spy.calls().length > 0, 'the spy saw git')
    assert.deepEqual(spy.calls().filter(c => /\blog\b/.test(c)), [], args.join(' '))
  }
  write(repo, 'src/auth/key.js', "import { util } from '../core/util.js'\n// Checks API keys\nexport function check(k) {\n  return util(k) // why\n}\n")
  gitIn(repo, 'commit', '-qam', 'explain the check')
  const spy = gitSpy()
  assert.equal(sdlc(repo, ['wiki', 'build'], { env: spy.env }).code, 0)
  assert.ok(spy.calls().some(c => /\blog\b/.test(c)))
  assert.match(page(repo, 'modules/auth.md'), /explain the check/)
})

test('an unresolved relative import is shown in the deps block and is enforced by --check', () => {
  const repo = wikiRepo()
  assert.equal(build(repo).code, 0)
  assert.match(page(repo, 'modules/auth.md'), /\*\*Unresolved imports\*\*\n\n_None\._/)
  write(repo, 'src/auth/lost.js', "import { gone } from './missing.js'\n")
  gitIn(repo, 'add', '.')
  const r = build(repo, '--check')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /modules\/auth\.md \(deps\)/)
  build(repo)
  assert.match(page(repo, 'modules/auth.md'), /\*\*Unresolved imports\*\*\n\n- `\.\/missing\.js`/)
})

test('link targets follow the clone (no origin, another origin, another default branch) without making --check drift; a changed row still drifts', () => {
  const repo = wikiRepo()
  assert.equal(build(repo).code, 0)
  assert.match(page(repo, 'modules/auth.md'), /\]\(\.\.\/\.\.\/\.\.\/src\/auth\/key\.js\)/)
  assert.equal(build(repo, '--check').code, 0, 'no origin')
  gitIn(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  assert.equal(build(repo, '--check').code, 0, 'a GitHub origin')
  gitIn(repo, 'remote', 'set-url', 'origin', 'git@github.com:fork/r.git')
  gitIn(repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD')
  gitIn(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master')
  assert.equal(build(repo, '--check').code, 0, 'a fork whose default branch is master')
  write(repo, 'src/auth/key.js', "import { util } from '../core/util.js'\n// Checks API keys and more\nexport function check(k) {\n  return util(k)\n}\n")
  gitIn(repo, 'add', '.')
  const r = build(repo, '--check')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /modules\/auth\.md \(files\)/)
})
