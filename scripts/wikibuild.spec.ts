import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

const PROSE = '## In plain words\n\nIt checks keys.\n\n## Walk-through\n\nA request enters at `src/auth/key.js:1`.\n'
const page = (repo: string, p: string): string => fs.readFileSync(path.join(repo, 'docs/wiki', p), 'utf8')

function wikiRepo(extra: object = {}): string {
  const repo = makeRepo()
  write(repo, 'src/auth/key.js', "import { util } from '../core/util.js'\n// Checks API keys\nexport function check(k) {\n  return util(k)\n}\n")
  write(repo, 'src/core/util.js', 'export const util = k => k\n')
  write(repo, 'test/auth.test.js', "import { check } from '../src/auth/key.js'\ntest('check passes a key', () => check(1))\n")
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { 'modules/auth.md': { globs: ['src/auth/**'] }, 'modules/core.md': { globs: ['src/core/**'] } }, ...extra }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'a')
  return repo
}
const build = (repo: string, ...a: string[]) => sdlc(repo, ['wiki', 'build', ...a])

test('build creates skeleton pages with every generated block, the edge, the symbols and the tests', () => {
  const repo = wikiRepo()
  const r = build(repo)
  assert.equal(r.code, 0, r.stderr)
  const auth = page(repo, 'modules/auth.md')
  assert.match(auth, /^# auth\n/)
  assert.match(auth, /flowchart LR[\s\S]*C -->\|1\| n_modules_core_md/)
  assert.match(auth, /\| \[`src\/auth\/key\.js`\]\(\.\.\/\.\.\/\.\.\/src\/auth\/key\.js\) \| Checks API keys \| 5 \|/)
  assert.match(auth, /export function check\(k\)/)
  assert.match(auth, /\[core\]\(core\.md\) · 1 import/)
  assert.match(auth, /test\/auth\.test\.js.*check passes a key/)
  assert.match(page(repo, 'modules/core.md'), /\*\*Used by\*\*\n\n- \[auth\]\(auth\.md\) · 1 import/)
  assert.match(page(repo, 'index.md'), /## System map[\s\S]*mermaid[\s\S]*## Start here[\s\S]*## Modules/)
})

test('build is idempotent and preserves prose outside the markers byte for byte', () => {
  const repo = wikiRepo()
  build(repo)
  const authPath = path.join(repo, 'docs/wiki/modules/auth.md')
  const written = fs.readFileSync(authPath, 'utf8').split('_pending: run /rig:wiki_').join('Hand-written prose here.')
  fs.writeFileSync(authPath, written)
  const again = build(repo)
  assert.match(again.stdout, /wiki up to date/)
  assert.equal(fs.readFileSync(authPath, 'utf8'), written)
  write(repo, 'src/auth/extra.js', 'export const e = 1\n')
  gitIn(repo, 'add', '.')
  build(repo)
  const after = fs.readFileSync(authPath, 'utf8')
  assert.match(after, /extra\.js/)
  assert.equal(after.replace(/<!-- rig:gen:[\s\S]*?<!-- \/rig:gen -->/g, 'B'), written.replace(/<!-- rig:gen:[\s\S]*?<!-- \/rig:gen -->/g, 'B'), 'only generated blocks changed')
})

test('build --check: 0 when fresh, 1 naming the page and block when a source file changes, 0 again after build', () => {
  const repo = wikiRepo()
  build(repo)
  assert.equal(build(repo, '--check').code, 0)
  write(repo, 'src/auth/extra.js', 'export const e = 1\n')
  gitIn(repo, 'add', '.')
  const stale = build(repo, '--check')
  assert.equal(stale.code, 1)
  assert.match(stale.stdout, /generated: docs\/wiki\/modules\/auth\.md \(files\)/)
  build(repo)
  assert.equal(build(repo, '--check').code, 0)
})

test('the why and recent blocks are refreshed by build but never enforced by --check', () => {
  const repo = wikiRepo()
  build(repo)
  // a body-only edit: same line count, same role, same imports, same exported lines, so no structural block changes
  write(repo, 'src/auth/key.js', "import { util } from '../core/util.js'\n// Checks API keys\nexport function check(k) {\n  return util(k) // ok\n}\n")
  gitIn(repo, 'commit', '-qam', 'rename the parameter')
  assert.equal(build(repo, '--check').code, 0)
  build(repo)
  assert.match(page(repo, 'modules/auth.md'), /rename the parameter/)
})

test('no manifest: build and --check say so and exit 0; an invalid manifest fails with the reason', () => {
  const repo = makeRepo()
  assert.equal(build(repo).code, 0)
  assert.match(build(repo, '--check').stdout, /no code wiki here/)
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: {}, bogus: 1, notes: ['x'.repeat(10_001)], order: ['nope.md'] }))
  const bad = build(repo)
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /unknown key "bogus"/)
  assert.match(bad.stderr, /notes\[0\] is longer than 10000/)
  assert.match(bad.stderr, /order: nope\.md is not a page/)
})

test('steering keys parse: notes and order are accepted, and order drives the start-here list', () => {
  const repo = wikiRepo({ notes: ['Auth is the entry point.'], order: ['modules/core.md'] })
  assert.equal(build(repo).code, 0)
  const idx = page(repo, 'index.md')
  assert.ok(idx.indexOf('[core](modules/core.md)') < idx.indexOf('[auth](modules/auth.md)'), 'manifest order first')
})

test('a language with no table row: the block says edges are not computed, and a drawn diagram outside the markers passes --check', () => {
  const repo = wikiRepo()
  write(repo, 'src/svc/main.go', 'package main\n')
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { 'modules/svc.md': { globs: ['src/svc/**'] } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'go')
  build(repo)
  const svcPath = path.join(repo, 'docs/wiki/modules/svc.md')
  assert.match(fs.readFileSync(svcPath, 'utf8'), /Edges not computed for \.go/)
  fs.appendFileSync(svcPath, '\n<!-- rig:drawn -->\n```mermaid\nflowchart LR\n  a --> b\n```\n')
  assert.equal(build(repo, '--check').code, 0)
})

test('a page that predates the markers keeps its text and gains the blocks; an empty module gets a skeleton', () => {
  const repo = wikiRepo()
  const legacy = '# auth\n- `src/auth/key.js:1` the old way\n'
  write(repo, 'docs/wiki/modules/auth.md', legacy)
  build(repo)
  assert.ok(page(repo, 'modules/auth.md').startsWith(legacy.trimEnd()))
  assert.match(page(repo, 'modules/auth.md'), /rig:gen:architecture/)
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { 'modules/ghost.md': { globs: ['nothing/**'] } } }))
  assert.equal(build(repo).code, 0)
  assert.match(page(repo, 'modules/ghost.md'), /_No source files match the module globs\._/)
})

test('the why block lists a recorded change whose plan matches, and an ad-hoc commit by subject', () => {
  const repo = wikiRepo()
  write(repo, '.sdlc/changes/add-auth/intent.md', '---\nslug: add-auth\ntype: feature\ntier: M\ncreated: 2026-10-05T00:00:00.000Z\n---\n# add-auth\n\n## Problem\nKeys were never checked.\n')
  write(repo, '.sdlc/changes/add-auth/plan.md', '# plan\n\n## Files\n- `src/auth/**`\n')
  write(repo, 'src/auth/key.js', "import { util } from '../core/util.js'\n// Checks API keys\nexport function check(k) {\n  return util(k) // checked\n}\n")
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'tweak the auth check')
  build(repo)
  const auth = page(repo, 'modules/auth.md')
  assert.match(auth, /\[add-auth\]\(\.\.\/\.\.\/\.\.\/\.sdlc\/changes\/add-auth\/intent\.md\) · feature · Keys were never checked\./)
  assert.match(auth, /· commit · tweak the auth check/)
})

test('links are GitHub blob URLs when origin is on GitHub', () => {
  const repo = wikiRepo()
  gitIn(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  build(repo)
  assert.match(page(repo, 'modules/auth.md'), /\]\(https:\/\/github\.com\/o\/r\/blob\/main\/src\/auth\/key\.js\)/)
})

test('two builds produce identical bytes', () => {
  const repo = wikiRepo()
  build(repo)
  const first = ['index.md', 'modules/auth.md', 'modules/core.md'].map(p => page(repo, p))
  fs.rmSync(path.join(repo, 'docs/wiki/index.md'))
  build(repo)
  assert.equal(page(repo, 'index.md'), first[0])
})

test('unsafe page keys fail the build and nothing is written outside docs/wiki', () => {
  for (const key of ['../../escape.md', '/abs/x.md', 'modules/../../x.md', 'index.md', 'a\\b.md', 'x.txt', './x.md', 'a//b.md']) {
    const repo = wikiRepo()
    write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { [key]: { globs: ['src/**'] } } }))
    const r = build(repo)
    assert.equal(r.code, 1, key)
    assert.ok(r.stderr.includes(`page "${key}": not a safe relative .md path`), `${key}: ${r.stderr}`)
    assert.ok(!fs.existsSync(path.join(repo, '..', 'escape.md')))
    assert.ok(!fs.existsSync(path.join(repo, 'escape.md')))
    assert.ok(!fs.existsSync(path.join(repo, 'x.md')))
    assert.ok(!fs.existsSync('/abs/x.md'))
  }
})

test('a symlinked directory inside docs/wiki cannot redirect a write', () => {
  const repo = wikiRepo()
  fs.mkdirSync(path.join(repo, 'outside'))
  fs.symlinkSync('../../outside', path.join(repo, 'docs/wiki/modules'))
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { 'modules/x.md': { globs: ['src/**'] } } }))
  const r = build(repo)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /modules\/x\.md/)
  assert.deepEqual(fs.readdirSync(path.join(repo, 'outside')), [])
})

test('a symlinked page file is refused', () => {
  const repo = wikiRepo()
  fs.mkdirSync(path.join(repo, 'docs/wiki/modules'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'outside.md'), 'keep')
  fs.symlinkSync('../../../outside.md', path.join(repo, 'docs/wiki/modules/auth.md'))
  assert.equal(build(repo).code, 1)
  assert.equal(fs.readFileSync(path.join(repo, 'outside.md'), 'utf8'), 'keep')
})

test('docs/wiki itself a symlink out of the repo: refused, nothing written outside', () => {
  const repo = wikiRepo()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-out-'))
  fs.cpSync(path.join(repo, 'docs/wiki'), outside, { recursive: true })
  fs.rmSync(path.join(repo, 'docs/wiki'), { recursive: true })
  fs.symlinkSync(outside, path.join(repo, 'docs/wiki'))
  const r = build(repo)
  assert.equal(r.code, 1)
  assert.deepEqual(fs.readdirSync(outside), ['manifest.json'])
})

test('a symlinked index.md is refused and its target is unchanged', () => {
  const repo = wikiRepo()
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-idx-')), 'victim.md')
  fs.writeFileSync(target, 'keep')
  fs.symlinkSync(target, path.join(repo, 'docs/wiki/index.md'))
  assert.equal(build(repo).code, 1)
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep')
})

test('the first build creates docs/wiki/modules when it does not exist', () => {
  const repo = wikiRepo()
  assert.ok(!fs.existsSync(path.join(repo, 'docs/wiki/modules')))
  assert.equal(build(repo).code, 0)
  assert.ok(fs.existsSync(path.join(repo, 'docs/wiki/modules/auth.md')))
})

const wikiText = (repo: string): string => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [fs.readFileSync(path.join(d, e.name), 'utf8')]))
  return walk(path.join(repo, 'docs/wiki')).join('\n')
}
const outsideFile = (body: string): string => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-leak-')), 'secret.txt')
  fs.writeFileSync(f, body)
  return f
}

test('a tracked symlink to an outside file contributes nothing to the wiki', () => {
  const repo = wikiRepo()
  fs.symlinkSync(outsideFile('// TOP SECRET ROLE LINE\nexport const something = "API_KEY=abc123"\ndef leaked_function():\n'), path.join(repo, 'src/auth/leak.js'))
  gitIn(repo, 'add', '.')
  assert.equal(build(repo).code, 0)
  const all = wikiText(repo)
  for (const s of ['TOP SECRET', 'API_KEY', 'leaked_function', 'leak.js']) assert.ok(!all.includes(s), s)
})

test('a symlinked intent.md leaks no Problem text', () => {
  const repo = wikiRepo()
  fs.mkdirSync(path.join(repo, '.sdlc/changes/evil'), { recursive: true })
  fs.symlinkSync(outsideFile('---\nslug: evil\ntype: feature\n---\n# evil\n\n## Problem\nLEAKED PROBLEM TEXT\n'), path.join(repo, '.sdlc/changes/evil/intent.md'))
  write(repo, '.sdlc/changes/evil/plan.md', '# plan\n\n## Files\n- `src/auth/**`\n')
  assert.equal(build(repo).code, 0)
  assert.ok(!wikiText(repo).includes('LEAKED PROBLEM'))
})

test('a glob matching a symlink to a directory does not crash', () => {
  const repo = wikiRepo()
  fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-dir-')), path.join(repo, 'src/auth/ldir'))
  gitIn(repo, 'add', '.')
  const r = build(repo)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(!/EISDIR|at /.test(r.stderr))
})

test('a tracked symlink does not change the module surface hash', () => {
  const repo = wikiRepo()
  build(repo)
  sdlc(repo, ['wiki', 'stamp'])
  const before = JSON.parse(sdlc(repo, ['wiki', 'status', '--json']).stdout) as { stale: string[] }
  fs.symlinkSync(outsideFile('export const x = 1\n'), path.join(repo, 'src/auth/link.js'))
  const after = JSON.parse(sdlc(repo, ['wiki', 'status', '--json']).stdout) as { stale: string[] }
  assert.deepEqual(after.stale, before.stale)
})

test('page keys that collide case-insensitively or hold control characters are rejected', () => {
  const repo = wikiRepo()
  const g = { globs: ['src/**'] }
  for (const [pages, re] of [
    [{ 'm/a.md': g, 'm/A.md': g }, /page "m\/(?:a|A)\.md": collides case-insensitively with "m\/(?:A|a)\.md"/],
    [{ 'Index.md': g }, /page "Index\.md": collides case-insensitively with the reserved index\.md/],
    [{ 'a\nb.md': g }, /not a safe relative \.md path/],
  ] as [object, RegExp][]) {
    write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages }))
    const r = build(repo)
    assert.equal(r.code, 1)
    assert.match(r.stderr, re)
  }
})

type Status = { stale: string[]; missing: string[]; uncovered: string[]; generated: string[]; prose: string[] }
const status = (repo: string) => JSON.parse(sdlc(repo, ['wiki', 'status', '--json']).stdout) as Status

test('status: pending prose is a prose finding; real prose clears it; a changed import is a generated finding', () => {
  const repo = wikiRepo()
  build(repo)
  assert.deepEqual(status(repo).prose, ['modules/auth.md', 'modules/core.md'])
  assert.deepEqual(status(repo).generated, [])
  for (const p of ['modules/auth.md', 'modules/core.md']) {
    const f = path.join(repo, 'docs/wiki', p)
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('_pending: run /rig:wiki_').join('Real prose.'))
  }
  assert.deepEqual(status(repo).prose, [])
  write(repo, 'src/auth/extra.js', 'export const e = 1\n')
  gitIn(repo, 'add', '.')
  assert.deepEqual(status(repo).generated, ['modules/auth.md'])
  assert.match(sdlc(repo, ['wiki', 'status']).stdout, /generated: modules\/auth\.md/)
})

test('stamp refuses a page with pending prose, then stamps it once the prose is written', () => {
  const repo = wikiRepo()
  sdlc(repo, ['init'])
  build(repo)
  const refused = sdlc(repo, ['wiki', 'stamp', 'modules/auth.md'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /missing prose sections: modules\/auth\.md \(In plain words, Walk-through\)/)
  const f = path.join(repo, 'docs/wiki/modules/auth.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('_pending: run /rig:wiki_').join('Real prose, see `src/auth/key.js:3`.'))
  const ok = sdlc(repo, ['wiki', 'stamp', 'modules/auth.md'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.match(ok.stdout, /stamped 1 page/)
})

test('wiki-generated and wiki-prose are warnings at ci, never blocks; wiki-stale is unchanged', () => {
  const repo = wikiRepo()
  sdlc(repo, ['init'])
  build(repo)
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'wiki')
  gitIn(repo, 'checkout', '-qb', 'f')
  write(repo, 'src/auth/extra.js', 'export const e = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'more')
  const ci = JSON.parse(sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--json']).stdout) as { findings: { sensor: string; severity: string }[] }
  const by = (s: string) => ci.findings.filter(f => f.sensor === s).map(f => f.severity)
  assert.deepEqual(by('wiki-generated'), ['warn'])
  assert.deepEqual(by('wiki-prose'), ['warn', 'warn'])
  assert.equal(by('wiki-stale').every(s => s === 'warn'), true)
})

test('the new sensors can be waived by name', () => {
  const repo = wikiRepo()
  sdlc(repo, ['init'])
  const r = sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  assert.equal(r.code, 0, r.stderr)
  for (const s of ['wiki-generated', 'wiki-prose']) assert.equal(sdlc(repo, ['waive', s, '*', 'reason'], { env: { SDLC_HUMAN: '1' } }).code, 0, s)
})

const manifestPath = (repo: string): string => path.join(repo, 'docs/wiki/manifest.json')
const checkCommit = (repo: string) => { write(repo, 'unrelated.txt', 'x\n'); gitIn(repo, 'add', 'unrelated.txt'); return sdlc(repo, ['check', '--at', 'commit', '--json']) }

test('a broken manifest is reported, not hidden: status names the error and ci warns on manifest.json', () => {
  const repo = wikiRepo()
  sdlc(repo, ['init'])
  build(repo)
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'wiki')
  gitIn(repo, 'checkout', '-qb', 'f')
  const m = JSON.parse(fs.readFileSync(manifestPath(repo), 'utf8')) as object
  fs.writeFileSync(manifestPath(repo), JSON.stringify({ ...m, bogus: 1 }))
  write(repo, 'src/auth/extra.js', 'export const e = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'more')
  const s = sdlc(repo, ['wiki', 'status', '--json'])
  assert.equal(s.code, 0, s.stderr)
  assert.match((JSON.parse(s.stdout) as Status & { invalid: string[] }).invalid.join('\n'), /unknown key "bogus"/)
  assert.match(sdlc(repo, ['wiki', 'status']).stdout, /^manifest: .*unknown key "bogus"/m)
  const ci = sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--json'])
  assert.doesNotMatch(ci.stderr, /crashed/)
  const hit = (JSON.parse(ci.stdout) as { findings: { sensor: string; severity: string; file?: string; message: string }[] }).findings.filter(f => f.sensor === 'wiki-generated' && f.file === 'docs/wiki/manifest.json')
  assert.equal(hit.length > 0 && hit.every(f => f.severity === 'warn' && /^invalid manifest: /.test(f.message)), true)
})

for (const bad of ['{"pages":null}', '{"pages":{"a.md":null}}', '{"pages":{"a.md":{"globs":5}}}', '[]', '5', '"x"', '{not json']) {
  test(`a manifest of ${bad} never crashes status or the commit check`, () => {
    const repo = wikiRepo()
    sdlc(repo, ['init'])
    fs.writeFileSync(manifestPath(repo), bad)
    const s = sdlc(repo, ['wiki', 'status', '--json'])
    assert.equal(s.code, 0, s.stderr)
    assert.doesNotMatch(s.stderr, /at |Error/)
    assert.equal((JSON.parse(s.stdout) as { invalid: string[] }).invalid.length > 0, true)
    const c = checkCommit(repo)
    assert.doesNotMatch(c.stderr, /the checker crashed/)
    assert.equal((JSON.parse(c.stdout) as { findings: { sensor: string }[] }).findings.some(f => f.sensor === 'wiki-generated'), true)
  })
}

test('a symlinked manifest.json is invalid and its pages are not used; a valid one has invalid: []', () => {
  const repo = wikiRepo()
  assert.deepEqual((JSON.parse(sdlc(repo, ['wiki', 'status', '--json']).stdout) as { invalid: string[] }).invalid, [])
  const outside = path.join(repo, 'elsewhere.json')
  fs.renameSync(manifestPath(repo), outside)
  fs.symlinkSync(outside, manifestPath(repo))
  const s = JSON.parse(sdlc(repo, ['wiki', 'status', '--json']).stdout) as Status & { invalid: string[] }
  assert.match(s.invalid.join('\n'), /not a regular file/)
  assert.deepEqual([s.stale, s.missing, s.generated, s.prose], [[], [], [], []])
})

function symlinkDirRepo(): string {
  const repo = wikiRepo({})
  fs.mkdirSync(path.join(repo, 'elsewhere'))
  fs.symlinkSync(path.join(repo, 'elsewhere'), path.join(repo, 'docs/wiki/sub'))
  const m = JSON.parse(fs.readFileSync(manifestPath(repo), 'utf8')) as { pages: object }
  fs.writeFileSync(manifestPath(repo), JSON.stringify({ ...m, pages: { ...m.pages, 'sub/a.md': { globs: ['src/auth/**'] } } }))
  return repo
}

test('a page under a symlinked directory is reported as invalid; status and the commit check never abort, build and stamp still fail loudly', () => {
  const repo = symlinkDirRepo()
  sdlc(repo, ['init'])
  const s = sdlc(repo, ['wiki', 'status', '--json'])
  assert.equal(s.code, 0, s.stderr)
  assert.match((JSON.parse(s.stdout) as { invalid: string[] }).invalid.join('\n'), /page "sub\/a\.md": path is not safe/)
  write(repo, 'unrelated.txt', 'x\n'); gitIn(repo, 'add', 'unrelated.txt')
  const c = sdlc(repo, ['check', '--at', 'commit', '--json'])
  assert.equal(c.code, 0, c.stderr)
  const f = (JSON.parse(c.stdout) as { findings: { sensor: string; severity: string; file?: string }[] }).findings
  assert.equal(f.some(x => x.sensor === 'wiki-generated' && x.severity === 'warn' && x.file === 'docs/wiki/manifest.json'), true)
  const b = build(repo)
  assert.equal(b.code, 1)
  assert.match(b.stderr, /not a safe relative \.md path|not a safe path/)
  const st = sdlc(repo, ['wiki', 'stamp', 'sub/a.md'])
  assert.equal(st.code, 1)
  assert.match(st.stderr, /not a safe relative \.md path|not a safe path/)
})

test('a symlinked index.md is invalid in status, and build still fails loudly', () => {
  const repo = wikiRepo()
  fs.writeFileSync(path.join(repo, 'real-index.md'), 'x\n')
  fs.symlinkSync(path.join(repo, 'real-index.md'), path.join(repo, 'docs/wiki/index.md'))
  const s = sdlc(repo, ['wiki', 'status', '--json'])
  assert.equal(s.code, 0, s.stderr)
  assert.match((JSON.parse(s.stdout) as { invalid: string[] }).invalid.join('\n'), /index\.md is not a safe path/)
  const b = build(repo)
  assert.equal(b.code, 1)
  assert.match(b.stderr, /docs\/wiki: not a safe path/)
})

test('wiki search: ranked pages with page and symbol refs, --json, --limit, and a clear no-match message', () => {
  const repo = wikiRepo()
  build(repo)
  const hit = sdlc(repo, ['wiki', 'search', 'check', 'key'])
  assert.equal(hit.code, 0, hit.stderr)
  assert.match(hit.stdout, /^modules\/auth\.md {2}\(score \d+\)/m)
  assert.match(hit.stdout, /src\/auth\/key\.js:3 {2}export function check\(k\)/)
  const json = JSON.parse(sdlc(repo, ['wiki', 'search', 'util', '--json']).stdout) as { page: string; hits: { ref: string }[] }[]
  assert.ok(json.length >= 1 && json.every(h => typeof h.page === 'string'))
  assert.equal((JSON.parse(sdlc(repo, ['wiki', 'search', 'src', '--json', '--limit', '1']).stdout) as unknown[]).length, 1)
  const none = sdlc(repo, ['wiki', 'search', 'zzzzzz'])
  assert.equal(none.code, 0)
  assert.match(none.stdout, /no wiki hits for "zzzzzz"/)
  assert.equal(sdlc(repo, ['wiki', 'search']).code, 1)
})

test('wiki search: no manifest is a friendly exit 0, a broken manifest exits 1', () => {
  const bare = makeRepo()
  const r = sdlc(bare, ['wiki', 'search', 'auth'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /no code wiki here/)
  const repo = wikiRepo()
  write(repo, 'docs/wiki/manifest.json', '{ nope')
  const bad = sdlc(repo, ['wiki', 'search', 'auth'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /manifest\.json/)
})

test('wiki search: --limit takes a positive integer only, and a hostile query is harmless', () => {
  const repo = wikiRepo()
  build(repo)
  for (const bad of ['0', '-3', 'abc', '1e9', '1.5']) {
    const n = (JSON.parse(sdlc(repo, ['wiki', 'search', 'src', '--json', '--limit', bad]).stdout) as unknown[]).length
    assert.equal(n, 2, `--limit ${bad} falls back to the default`)
  }
  const huge = sdlc(repo, ['wiki', 'search', 'auth '.repeat(100_000).slice(0, 100_000), '--json'])
  assert.equal(huge.code, 0, huge.stderr)
  const punct = sdlc(repo, ['wiki', 'search', '?!*(', '--json'])
  assert.equal(punct.code, 0)
  assert.equal(punct.stdout.trim(), '[]')
})

test('wiki search: output is byte-identical across runs', () => {
  const repo = wikiRepo()
  build(repo)
  assert.equal(sdlc(repo, ['wiki', 'search', 'src', 'check']).stdout, sdlc(repo, ['wiki', 'search', 'src', 'check']).stdout)
})

test('wiki search: a tracked symlink to an outside file contributes no symbols or text', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wikileak-'))
  fs.writeFileSync(path.join(outside, 'secret.js'), 'export const leakAlpha = 1\nexport const leakBeta = 2\n')
  const repo = wikiRepo()
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(repo, 'src/auth/leak.js'))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'link')
  build(repo)
  for (const args of [['wiki', 'search', 'leakalpha'], ['wiki', 'search', 'leakalpha', '--json']]) {
    const r = sdlc(repo, args)
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /leakAlpha|leakBeta/)
  }
  const unsafePage = path.join(repo, 'docs/wiki/modules/core.md')
  fs.rmSync(unsafePage)
  fs.writeFileSync(path.join(outside, 'page.md'), '# core\n\npagesecret marker\n')
  fs.symlinkSync(path.join(outside, 'page.md'), unsafePage)
  const p = sdlc(repo, ['wiki', 'search', 'pagesecret', '--json'])
  assert.equal(p.code, 0, p.stderr)
  assert.doesNotMatch(p.stdout, /pagesecret/)
})

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

test('wiki output: escape and control characters in repo text never reach the human output; --json keeps them escaped', () => {
  const repo = wikiRepo()
  write(repo, 'src/auth/esc.js', 'export const \x1b[31mFAKE\x1b[0m = 1 // check\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'esc')
  build(repo)
  const authPath = path.join(repo, 'docs/wiki/modules/auth.md')
  fs.writeFileSync(authPath, fs.readFileSync(authPath, 'utf8') + '\x1b[31mFAKE\x1b[0m check \x01 line\n')
  const human = sdlc(repo, ['wiki', 'search', 'check'])
  assert.equal(human.code, 0, human.stderr)
  assert.match(human.stdout, /FAKE/)
  assert.doesNotMatch(human.stdout, CONTROL)
  assert.match(sdlc(repo, ['wiki', 'search', 'check', '--json']).stdout, /\\u001b\[31mFAKE/)
  const noHit = sdlc(repo, ['wiki', 'search', '\x1b[31mnomatchzz'])
  assert.match(noHit.stdout, /no wiki hits/)
  assert.doesNotMatch(noHit.stdout, CONTROL)
  assert.doesNotMatch(sdlc(repo, ['wiki', 'status']).stdout, CONTROL)

  const dirRepo = wikiRepo()
  const evil = 'ev\x1b[31mil'
  fs.mkdirSync(path.join(dirRepo, evil))
  fs.writeFileSync(path.join(dirRepo, evil, 'a.js'), 'export const a = 1\n')
  gitIn(dirRepo, 'add', '.'); gitIn(dirRepo, 'commit', '-qm', 'dir')
  build(dirRepo)
  const st = sdlc(dirRepo, ['wiki', 'status'])
  assert.doesNotMatch(st.stdout, CONTROL)
  const sj = sdlc(dirRepo, ['wiki', 'status', '--json'])
  assert.doesNotMatch(sj.stdout, CONTROL)
  JSON.parse(sj.stdout)

  const keyRepo = wikiRepo()
  write(keyRepo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { 'modules/a\x1b[31mb.md': { globs: ['src/**'] } } }))
  const b = build(keyRepo)
  assert.equal(b.code, 1)
  assert.doesNotMatch(b.stderr, CONTROL)
  assert.doesNotMatch(sdlc(keyRepo, ['wiki', 'status']).stdout, CONTROL)
  assert.doesNotMatch(sdlc(keyRepo, ['wiki', 'search', 'auth']).stderr, CONTROL)
  assert.doesNotMatch(sdlc(keyRepo, ['wiki', 'stamp']).stderr, CONTROL)
})

test('the ask skill treats wiki and cited source text as untrusted data', () => {
  const skill = fs.readFileSync(path.join(import.meta.dirname, '..', 'skills/ask/SKILL.md'), 'utf8')
  assert.match(skill, /untrusted data/)
  assert.ok(skill.split('\n').length <= 60)
})
