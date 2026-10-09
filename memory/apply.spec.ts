import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyOps, textProblem, writeStore } from './apply.ts'
import { loadMemConfig } from './config.ts'
import { allEntries, findEntry, loadStore } from './store.ts'
import { makeRepo } from '../shared/testkit.ts'

const D = '2026-10-09'
const repo = (files: Record<string, string> = {}) => makeRepo(files, { git: false })
const mem = (dir: string, f: string) => fs.readFileSync(path.join(dir, '.sdlc/memory', f), 'utf8')
const add = (text: string, file = 'commands.md', source = 's1') => ({ op: 'add', file, text, source })

test('add writes the entry line, MEMORY.md and the cache .gitignore', () => {
  const dir = repo(), cfg = loadMemConfig(dir)
  const r = applyOps(dir, cfg, [add('Run tests with `npm test`, not `npx jest`.')], D)
  assert.equal(r.added, 1); assert.deepEqual(r.rejected, [])
  assert.match(mem(dir, 'commands.md'), /^# commands\n> Build, test and run invocations that work\n\n- Run tests with `npm test`, not `npx jest`\. \[source: s1; added: 2026-10-09; id: m-[0-9a-f]{6}\]\n$/)
  assert.match(mem(dir, 'MEMORY.md'), /- \[\[commands\]\] \(1\)/)
  assert.equal(mem(dir, '.gitignore'), '.cache/\n')
  assert.equal(fs.existsSync(path.join(dir, '.sdlc/memory/gotchas.md')), false)
})

test('textProblem rules', () => {
  assert.equal(textProblem(''), 'text missing'); assert.equal(textProblem(5), 'text missing')
  assert.equal(textProblem('a\nb'), 'text must be one line')
  assert.equal(textProblem('x'.repeat(241)), 'text over 240 chars')
  assert.equal(textProblem('ok [source: me]'), 'text has metadata')
  assert.equal(textProblem('use token=abcdef123'), 'text contains a secret')
  assert.equal(textProblem('fine'), null)
})

test('apply rejects bad ops and writes them to rejected.jsonl without touching memory', () => {
  const dir = repo(), cfg = loadMemConfig(dir)
  const bad = [add('x', '../evil.md'), add('x', 'MEMORY.md'), add('x', 'a/b.md'), add('x', 'notes.txt'), add('a\nb'), add('x'.repeat(241)),
    add('key password: hunter22'), { op: 'nope', text: 'x' }, 'string', null, { op: 'update', id: 'm-ffffff', text: 'x' }, { op: 'remove', id: 'm-ffffff' },
    { op: 'merge', ids: ['m-ffffff'], text: 'x' }]
  const r = applyOps(dir, cfg, bad, D)
  assert.equal(r.rejected.length, bad.length); assert.equal(r.added, 0)
  assert.equal(fs.existsSync(path.join(dir, '.sdlc/memory/MEMORY.md')), false)
  assert.equal(fs.readFileSync(path.join(dir, '.sdlc/memory/.cache/rejected.jsonl'), 'utf8').trim().split('\n').length, bad.length)
  assert.deepEqual(applyOps(dir, cfg, { not: 'array' }, D).rejected[0].reason, 'ops must be an array')
})

test('near-duplicate adds are rejected', () => {
  const dir = repo(), cfg = loadMemConfig(dir)
  applyOps(dir, cfg, [add('Use pnpm, not npm, for installs.')], D)
  const r = applyOps(dir, cfg, [add('use pnpm not npm for installs', 'conventions.md')], D)
  assert.match(r.rejected[0].reason, /^duplicate of m-/)
})

test('update, remove and merge; merge keeps the earliest id and added, joins sources', () => {
  const dir = repo(), cfg = loadMemConfig(dir)
  applyOps(dir, cfg, [add('alpha one')], '2026-10-01')
  applyOps(dir, cfg, [add('beta two', 'gotchas.md', 's2'), add('gamma three', 'gotchas.md', 's3')], '2026-10-05')
  const [a, b, c] = allEntries(loadStore(dir))
  assert.equal(applyOps(dir, cfg, [{ op: 'update', id: b.id, text: 'beta two revised' }], D).updated, 1)
  assert.equal(findEntry(loadStore(dir), b.id)!.topic.lines.find(l => typeof l !== 'string' && l.id === b.id && l.text === 'beta two revised' && l.added === '2026-10-05') !== undefined, true)
  assert.equal(applyOps(dir, cfg, [{ op: 'merge', ids: [c.id, a.id], text: 'alpha and gamma' }], D).merged, 1)
  const merged = allEntries(loadStore(dir)).find(e => e.id === a.id)!
  assert.deepEqual([merged.text, merged.added, merged.source], ['alpha and gamma', '2026-10-01', 's3,s1'])
  assert.equal(findEntry(loadStore(dir), c.id), null)
  assert.equal(applyOps(dir, cfg, [{ op: 'remove', id: b.id, reason: 'wrong' }], D).removed, 1)
  assert.equal(allEntries(loadStore(dir)).length, 1)
})

test('ops apply in order; a later op on a removed id is rejected, earlier ones kept', () => {
  const dir = repo(), cfg = loadMemConfig(dir)
  applyOps(dir, cfg, [add('one thing'), add('two thing else')], D)
  const [a] = allEntries(loadStore(dir))
  const r = applyOps(dir, cfg, [{ op: 'remove', id: a.id }, { op: 'update', id: a.id, text: 'x' }, add('three more words')], D)
  assert.equal(r.removed, 1); assert.equal(r.added, 1); assert.equal(r.rejected[0].reason, 'unknown id')
})

test('caps: maxFiles and maxEntriesPerFile', () => {
  const dir = repo({ '.sdlc/memory.json': JSON.stringify({ maxFiles: 5, maxEntriesPerFile: 1 }) }), cfg = loadMemConfig(dir)
  assert.equal(applyOps(dir, cfg, [add('aa bb', 'extra.md')], D).added, 1)
  assert.equal(applyOps(dir, cfg, [add('cc dd', 'more.md')], D).rejected[0].reason, 'too many topic files')
  assert.equal(applyOps(dir, cfg, [add('ee ff', 'extra.md')], D).rejected[0].reason, 'topic file full')
})

test('a new topic takes its description from the op', () => {
  const dir = repo(), cfg = loadMemConfig(dir)
  applyOps(dir, cfg, [{ ...add('deploy with make ship', 'deploy.md'), description: 'Releasing and deploying' }], D)
  assert.match(mem(dir, 'deploy.md'), /^# deploy\n> Releasing and deploying\n/)
})

test('apply preserves hand-written lines and rebuilds MEMORY.md byte-identically', () => {
  const dir = repo({ '.sdlc/memory/gotchas.md': '# gotchas\n> Traps\n\nPerson note: CI is slow on Mondays.\n' }), cfg = loadMemConfig(dir)
  applyOps(dir, cfg, [add('the db port is 5433', 'gotchas.md')], D)
  assert.match(mem(dir, 'gotchas.md'), /Person note: CI is slow on Mondays\.\n- the db port is 5433/)
  const before = [mem(dir, 'MEMORY.md'), mem(dir, 'gotchas.md')]
  writeStore(dir, loadStore(dir))
  assert.deepEqual([mem(dir, 'MEMORY.md'), mem(dir, 'gotchas.md')], before)
})

test('a failed write leaves existing memory unchanged', () => {
  const dir = repo({ '.sdlc/memory/gotchas.md': '# gotchas\n> Traps\n\n- old [source: s; added: 2026-10-01; id: m-aaaaaa]\n' }), cfg = loadMemConfig(dir)
  fs.mkdirSync(path.join(dir, '.sdlc/memory/commands.md'))
  assert.throws(() => applyOps(dir, cfg, [add('new gotcha here', 'gotchas.md')], D))
  assert.equal(mem(dir, 'gotchas.md'), '# gotchas\n> Traps\n\n- old [source: s; added: 2026-10-01; id: m-aaaaaa]\n')
  assert.equal(fs.existsSync(path.join(dir, '.sdlc/memory/MEMORY.md')), false)
})
