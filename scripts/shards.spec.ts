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

test('the shards command splits the branch diff, leaves out .rig and ignored files, and prints JSON', () => {
  const repo = makeRepo()
  write(repo, '.rig/sensors.json', '{}')
  write(repo, 'src/old-auth.ts', 'export const check = () => true\nexport const other = 1\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/big')
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  for (let i = 0; i < 30; i++) write(repo, `src/f${String(i).padStart(2, '0')}.ts`, `export const v${i} = ${i}\n`)
  write(repo, 'docs/notes.md', '# notes\n')
  fs.rmSync(path.join(repo, 'src/old-auth.ts'))
  const r = sdlc(repo, ['shards', 'big', '--json'])
  assert.equal(r.code, 0, r.stderr)
  const out = JSON.parse(r.stdout) as { base: string; shards: { name: string; files: string[] }[] }
  assert.deepEqual(out.shards.map(s => s.files.length), [25, 6])
  assert.ok(out.shards.flatMap(s => s.files).every(f => f.startsWith('src/')))
  assert.ok(out.shards.flatMap(s => s.files).includes('src/old-auth.ts'), 'a deleted file is still reviewed')
  assert.ok(fs.existsSync(path.join(repo, 'docs/notes.md')))
})

test('shard order is locale-independent: plain code-point order, uppercase before lowercase, non-ASCII last', () => {
  const s = makeShards(['b.ts', 'B.ts', 'é.ts', 'a.ts', 'Z.ts'].map(file => ({ file, lines: 1 })))
  assert.deepEqual(s[0]?.files, ['B.ts', 'Z.ts', 'a.ts', 'b.ts', 'é.ts'])
})

test('shards group by the key the caller gives, so a scope stays together', () => {
  const key = (f: string): string => (f.startsWith('api/') ? 'api' : 'web')
  const s = makeShards([{ file: 'web/a.ts', lines: 1 }, { file: 'api/b.ts', lines: 1 }, { file: 'web/c.ts', lines: 1 }], 25, 5000, key)
  assert.deepEqual(s.map(x => x.files), [['api/b.ts', 'web/a.ts', 'web/c.ts']])
  assert.equal(s[0]?.name, '01-api+web')
  const split = makeShards([{ file: 'api/b.ts', lines: 1 }, { file: 'web/a.ts', lines: 1 }], 1, 5000, key)
  assert.deepEqual(split.map(x => x.name), ['01-api', '02-web'])
})

test('the shards command uses scope names when scopes are declared and (unscoped) for the rest', () => {
  const repo = makeRepo()
  write(repo, '.rig/sensors.json', JSON.stringify({ scopes: { 'api/**': { name: 'api', root: 'api' } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'sdlc/big')
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, 'api/a.ts', 'export {}\n'); write(repo, 'loose/b.ts', 'export {}\n')
  const out = JSON.parse(sdlc(repo, ['shards', 'big', '--json']).stdout) as { shards: { name: string; files: string[] }[] }
  assert.deepEqual(out.shards.map(s => s.name), ['01-(unscoped)+api'])
})
