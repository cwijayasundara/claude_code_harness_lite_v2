import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { seedMemory } from './seed.ts'
import { loadMemConfig } from './config.ts'
import { allEntries, loadStore } from './store.ts'
import { makeRepo } from '../shared/testkit.ts'

const add = (file: string, text: string) => ({ op: 'add', file, text, source: 'init' })
const read = (d: string, f: string) => fs.readFileSync(path.join(d, '.sdlc/memory', f), 'utf8')

test('seed turns memory on and adds entries tagged with source init', () => {
  const dir = makeRepo({})
  const r = seedMemory(dir, [add('commands.md', 'run npm test for the suite'), add('gotchas.md', 'never run node --test test/')], '2026-10-09')
  assert.equal(r.added, 2)
  assert.equal(loadMemConfig(dir).enabled, true)
  assert.ok(allEntries(loadStore(dir)).every(e => e.source === 'init'))
  assert.match(read(dir, 'MEMORY.md'), /\[\[commands\]\] \(1\)/)
})

test('greenfield placeholders create the four topic files and a MEMORY.md without entries', () => {
  const dir = makeRepo({})
  seedMemory(dir, [], '2026-10-09', { placeholders: true })
  for (const f of ['commands.md', 'gotchas.md', 'dead-ends.md', 'conventions.md']) assert.match(read(dir, f), /_\(fill in:/)
  assert.equal(allEntries(loadStore(dir)).length, 0)
  assert.match(read(dir, 'MEMORY.md'), /\(none yet\)/)
})

test('re-seeding never overwrites an existing topic file and dreams can still add beside placeholders', () => {
  const dir = makeRepo({})
  seedMemory(dir, [add('commands.md', 'use npm test')], '2026-10-09')
  seedMemory(dir, [], '2026-10-10', { placeholders: true })
  assert.match(read(dir, 'commands.md'), /use npm test/)
  assert.doesNotMatch(read(dir, 'commands.md'), /fill in/)
  assert.match(read(dir, 'gotchas.md'), /fill in/)
})

test('seed refuses to override a repo that disabled memory', () => {
  const dir = makeRepo({ '.sdlc/memory.json': JSON.stringify({ enabled: false }) })
  assert.throws(() => seedMemory(dir, [], '2026-10-09'), /disabled/)
  assert.equal(fs.existsSync(path.join(dir, '.sdlc/memory')), false)
})

test('seed CLI reads ops from a file and reports rejects', () => {
  const dir = makeRepo({})
  const ops = path.join(dir, 'ops.json')
  fs.writeFileSync(ops, JSON.stringify([add('commands.md', 'use npm test'), add('bad name.md', 'x y z')]))
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', path.resolve('memory/memory.ts'), 'seed', '--placeholders', ops], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /seeded: 1 added, 1 rejected \(bad file name\)/)
})
