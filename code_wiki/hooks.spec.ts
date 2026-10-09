import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { markStale, promptContext } from './mark.ts'
import { applyWiki } from './apply.ts'
import { buildIndex } from './indexer.ts'
import { loadConfig } from './config.ts'
import { loadState } from './state.ts'
import { makeRepo } from '../shared/testkit.ts'

const built = () => {
  const dir = makeRepo({ 'src/a/x.ts': 'export const x = 1\n' })
  const cfg = loadConfig(dir)
  const f = path.join(dir, '.sdlc/wiki/.cache/prose/a.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ purpose: 'Does a.', how: 'H' }))
  applyWiki(dir, cfg, buildIndex(dir, cfg))
  return dir
}
const wiki = path.resolve('code_wiki/wiki.ts')
const run = (dir: string, args: string[], input = '') =>
  spawnSync('node', ['--disable-warning=ExperimentalWarning', wiki, ...args], { cwd: dir, input, encoding: 'utf8' })

test('apply writes INDEX.md with the purpose', () => {
  const dir = built()
  assert.match(fs.readFileSync(path.join(dir, '.sdlc/wiki/INDEX.md'), 'utf8'), /\*\*a\*\* — Does a\./)
})

test('markStale flags the page; unknown file and outside-root paths are safe', () => {
  const dir = built()
  fs.writeFileSync(path.join(dir, 'src/a/x.ts'), 'export const x = 2\n')
  assert.equal(markStale(dir, 'src/a/x.ts'), true)
  assert.equal(loadState(dir).modules.a.status, 'stale')
  assert.equal(markStale(dir, '/etc/passwd'), false)
  assert.equal(markStale(dir, 'src/zzz/q.ts'), false)
  assert.equal(markStale(makeRepo({}, { git: false }), 'src/a/x.ts'), false)
})

test('promptContext injects once per session', () => {
  const dir = built()
  assert.match(promptContext(dir, 's1'), /Wiki index/)
  assert.equal(promptContext(dir, 's1'), '')
  assert.match(promptContext(dir, 's2'), /Wiki index/)
  assert.equal(promptContext(makeRepo({}), 's1'), '')
})

test('hook CLI never fails on garbage input and post-edit marks stale', () => {
  const dir = built()
  for (const ev of ['post-edit', 'stop', 'session-start', 'prompt-submit']) {
    const r = run(dir, ['hook', ev], 'not json {{{')
    assert.equal(r.status, 0)
  }
  fs.writeFileSync(path.join(dir, 'src/a/x.ts'), 'export const x = 3\n')
  run(dir, ['hook', 'post-edit'], JSON.stringify({ tool_input: { file_path: path.join(dir, 'src/a/x.ts') }, cwd: dir }))
  assert.equal(loadState(dir).modules.a.status, 'stale')
  assert.match(run(dir, ['hook', 'session-start'], '{}').stdout, /\.sdlc\/wiki\/INDEX\.md/)
})

test('CLI find and status work', () => {
  const dir = built()
  assert.match(run(dir, ['find', 'x.ts']).stdout, /modules\/a\.md/)
  assert.match(run(dir, ['status']).stdout, /fresh: 1/)
})

test('markStale accepts a file path that reaches the repo through a symlink', () => {
  const dir = built()
  fs.writeFileSync(path.join(dir, 'src/a/x.ts'), 'export const x = 4\n')
  const link = `${dir}-link`
  fs.symlinkSync(dir, link)
  assert.equal(markStale(fs.realpathSync(dir), path.join(link, 'src/a/x.ts')), true)
  assert.equal(loadState(dir).modules.a.status, 'stale')
})
