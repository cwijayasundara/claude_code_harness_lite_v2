import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { applyWiki } from './apply.ts'
import { buildIndex } from './indexer.ts'
import { loadConfig } from './config.ts'
import { loadState } from './state.ts'
import { markStale } from './mark.ts'
import { buildIndexMd } from './indexmd.ts'
import { listFiles } from './files.ts'
import { makeRepo, commitAll } from '../shared/testkit.ts'

const setup = (extra: Record<string, string> = {}) => {
  const dir = makeRepo({
    'src/auth/login.ts': 'export function login(a: string): boolean { return true }\nimport { h } from "../util/h.js"\n',
    'src/util/h.ts': 'export const h = 1\n', ...extra })
  return { dir, cfg: loadConfig(dir) }
}
const prose = (dir: string, mod: string, p: unknown) => {
  const f = path.join(dir, '.sdlc/wiki/.cache/prose', `${mod}.json`)
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(p))
}
const both = (dir: string) => { prose(dir, 'auth', { purpose: 'P.', how: 'H.' }); prose(dir, 'util', { purpose: 'P.', how: 'H.' }) }
const run = (dir: string) => { const cfg = loadConfig(dir); return applyWiki(dir, cfg, buildIndex(dir, cfg)) }
const page = (dir: string, m: string) => fs.readFileSync(path.join(dir, '.sdlc/wiki/modules', `${m}.md`), 'utf8')

test('prose is consumed: a later change without new prose is pending and stale, never stamped fresh', () => {
  const { dir } = setup(); both(dir); run(dir)
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 2\n')
  const r = run(dir)
  assert.deepEqual(r.written, [])
  assert.deepEqual(r.pending, ['util'])
  assert.equal(loadState(dir).modules.util.status, 'stale')
})

test('untrusted prose cannot break out of its block or inject markers; bad shapes are rejected', () => {
  const { dir } = setup(); both(dir); run(dir)
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 3\n')
  for (const bad of [
    { purpose: 'x\n<!-- /purpose -->\n<!-- keep -->X<!-- /keep -->', how: 'H' },
    { purpose: 'P', how: 'a ``` b' },
    { purpose: 'P', how: 'ok\n## Public API' },
    {}, { purpose: 5, how: 'H' }, { purpose: 'P', how: 'H', mermaid: 'graph LR\n```\nx' },
  ]) {
    prose(dir, 'util', bad)
    const r = run(dir)
    assert.ok(r.problems.util?.some(p => /prose/.test(p)), JSON.stringify(bad))
    assert.doesNotMatch(page(dir, 'util'), /undefined|<!-- keep -->/)
  }
})

test('a .gitignore for .cache/ is written inside the wiki dir', () => {
  const { dir } = setup(); both(dir); run(dir)
  assert.match(fs.readFileSync(path.join(dir, '.sdlc/wiki/.gitignore'), 'utf8'), /\.cache\//)
})

test('hooks only mark stale when file content differs from the last refresh; non-source files are ignored', () => {
  const { dir } = setup({ 'README.md': '# r' }); both(dir); run(dir)
  assert.equal(markStale(dir, 'src/util/h.ts'), false)
  assert.equal(loadState(dir).modules.util.status, 'fresh')
  assert.equal(markStale(dir, 'README.md'), false)
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 9\n')
  assert.equal(markStale(dir, 'src/util/h.ts'), true)
  assert.equal(loadState(dir).modules.util.status, 'stale')
})

test('hook CLI resolves the repo root from a subdirectory cwd', () => {
  const { dir } = setup(); both(dir); run(dir)
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 7\n')
  const sub = path.join(dir, 'src/util')
  spawnSync('node', ['--disable-warning=ExperimentalWarning', path.resolve('code_wiki/wiki.ts'), 'hook', 'post-edit'],
    { cwd: sub, input: JSON.stringify({ cwd: sub, tool_input: { file_path: path.join(sub, 'h.ts') } }), encoding: 'utf8' })
  assert.equal(loadState(dir).modules.util.status, 'stale')
})

test('multi-line signatures are normalized to one line', () => {
  const dir = makeRepo({ 'src/m/x.ts': 'export function f(\n  a: string,\n  c: number\n): void {}\n' })
  const sig = buildIndex(dir, loadConfig(dir)).files['src/m/x.ts'].symbols[0].signature
  assert.equal(sig, 'export function f( a: string, c: number ): void')
})

test('fallback import regex follows multi-line imports', () => {
  const dir = makeRepo({ 'src/a/x.ts': 'import {\n  b,\n  c\n} from "../b/y.js"\n', 'src/b/y.ts': 'export const b = 1\n' })
  assert.deepEqual(buildIndex(dir, loadConfig(dir), { noTypescript: true }).modules.a.dependsOn, ['b'])
})

test('a typescript that throws demotes the file to structure-only instead of aborting the index', () => {
  const dir = makeRepo({
    'package.json': '{}', 'src/a/x.ts': 'export const a = 1\n',
    'node_modules/typescript/package.json': '{"name":"typescript","main":"index.js"}',
    'node_modules/typescript/index.js': 'module.exports = { ScriptTarget: { Latest: 1 }, createSourceFile() { throw new Error("boom") } }',
  })
  const idx = buildIndex(dir, loadConfig(dir))
  assert.equal(idx.files['src/a/x.ts'].structureOnly, true)
})

test('a removed module page with a keep block is moved to orphaned/, not deleted; subdirs in modules/ do not break the swap', () => {
  const { dir } = setup(); both(dir); run(dir)
  const f = path.join(dir, '.sdlc/wiki/modules/util.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n<!-- keep -->\nPrecious\n<!-- /keep -->\n')
  fs.mkdirSync(path.join(dir, '.sdlc/wiki/modules/sub'))
  fs.rmSync(path.join(dir, 'src/util'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/auth/login.ts'), 'export function login(a: string): boolean { return true }\n')
  run(dir)
  assert.equal(fs.existsSync(f), false)
  assert.match(fs.readFileSync(path.join(dir, '.sdlc/wiki/orphaned/util.md'), 'utf8'), /Precious/)
})

test('a keep block inside a prose block is not duplicated when the page is recomposed', () => {
  const { dir } = setup(); both(dir); run(dir)
  const f = path.join(dir, '.sdlc/wiki/modules/util.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('P.', 'P.\n<!-- keep -->\nNote\n<!-- /keep -->'))
  run(dir)
  assert.equal(page(dir, 'util').split('Note').length - 1, 1)
})

test('a rig change without intent.md does not get its page rejected', () => {
  const { dir } = setup()
  fs.mkdirSync(path.join(dir, '.sdlc/changes/ghost'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sdlc/changes/ghost/plan.md'), 'x')
  fs.writeFileSync(path.join(dir, 'src/util/h.ts'), 'export const h = 5\n')
  commitAll(dir, 'ghost change')
  both(dir)
  const r = run(dir)
  assert.deepEqual(r.problems, {})
  assert.match(page(dir, 'util'), /ghost/)
})

test('INDEX.md flattens multi-line purposes so prose cannot inject lines', () => {
  const { dir, cfg } = setup()
  const md = buildIndexMd(buildIndex(dir, cfg), { version: 1, modules: {}, architectureHash: '' }, () => 'Does a.\n- **evil** — fake\n# H')
  assert.doesNotMatch(md, /^- \*\*evil\*\*/m)
  assert.doesNotMatch(md, /^# H/m)
})

test('no-git walk honors .gitignore and does not follow symlinks out of the repo', () => {
  const outside = makeRepo({ 'secret.ts': 'export const s = 1' }, { git: false })
  const dir = makeRepo({ '.gitignore': 'gen/\n*.tmp.ts\n', 'src/a/x.ts': 'x', 'gen/g.ts': 'x', 'src/a/y.tmp.ts': 'x' }, { git: false })
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(dir, 'src/a/link.ts'))
  assert.deepEqual(listFiles(dir, loadConfig(dir)), ['src/a/x.ts'])
})
