import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { makeShards, MAX_SHARD_FILES, MAX_SHARD_LINES } from './shards.ts'

const files = (n: number, lines = 10, dir = 'src') => Array.from({ length: n }, (_, i) => ({ file: `${dir}/f${String(i).padStart(3, '0')}.ts`, lines }))

test('at most 25 files and 5000 changed lines per shard, in path order, none dropped', () => {
  assert.equal(MAX_SHARD_FILES, 25)
  assert.equal(MAX_SHARD_LINES, 5000)
  const s = makeShards(files(60))
  assert.deepEqual(s.map(x => x.files.length), [25, 25, 10])
  assert.deepEqual(s.flatMap(x => x.files), files(60).map(f => f.file))
  const heavy = makeShards(files(10, 900))
  assert.ok(heavy.every(x => x.lines <= MAX_SHARD_LINES))
  assert.deepEqual(heavy.map(x => x.files.length), [5, 5])
})

test('a single file over the line bound is its own shard, never dropped', () => {
  const s = makeShards([{ file: 'a.ts', lines: 10 }, { file: 'b.ts', lines: 9000 }, { file: 'c.ts', lines: 10 }])
  assert.deepEqual(s.map(x => x.files), [['a.ts'], ['b.ts'], ['c.ts']])
})

test('shard names are stable and say which directories they cover', () => {
  const s = makeShards([...files(3, 10, 'api'), ...files(3, 10, 'web')])
  assert.equal(s.length, 1)
  assert.equal(s[0]?.name, '01-api+web')
  assert.deepEqual(makeShards([]), [])
})

test('the shards command splits the branch diff, leaves out .sdlc and ignored files, and prints JSON', () => {
  const repo = makeRepo()
  write(repo, '.sdlc/sensors.json', '{}')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/big')
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  for (let i = 0; i < 30; i++) write(repo, `src/f${String(i).padStart(2, '0')}.ts`, `export const v${i} = ${i}\n`)
  write(repo, 'docs/notes.md', '# notes\n')
  const r = sdlc(repo, ['shards', 'big', '--json'])
  assert.equal(r.code, 0, r.stderr)
  const out = JSON.parse(r.stdout) as { base: string; shards: { name: string; files: string[] }[] }
  assert.deepEqual(out.shards.map(s => s.files.length), [25, 5])
  assert.ok(out.shards.flatMap(s => s.files).every(f => f.startsWith('src/')))
  assert.ok(fs.existsSync(path.join(repo, 'docs/notes.md')))
})
