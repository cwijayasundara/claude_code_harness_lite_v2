import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadMemConfig } from './config.ts'
import { allEntries, findEntry, loadStore, newId, parseTopic, searchEntries, serializeTopic, similarity, type Store } from './store.ts'
import { buildMemoryMd, MEMORY_HEADER } from './memorymd.ts'
import { makeRepo } from '../shared/testkit.ts'

const E = '- Run tests with `npm test`; `npx jest` misses the loader. [source: s1; added: 2026-10-01; id: m-abc123]'

test('loadMemConfig defaults to disabled with spec defaults', () => {
  assert.deepEqual(loadMemConfig(makeRepo({}, { git: false })), { enabled: false, minSignals: 3, cooldownMin: 30, maxDreamsPerDay: 6, model: 'haiku', maxFiles: 12, maxEntriesPerFile: 80 })
  const dir = makeRepo({ '.sdlc/memory.json': JSON.stringify({ enabled: true, minSignals: 1, model: 'sonnet' }) }, { git: false })
  assert.equal(loadMemConfig(dir).enabled, true); assert.equal(loadMemConfig(dir).minSignals, 1); assert.equal(loadMemConfig(dir).model, 'sonnet')
})

test('loadMemConfig falls back on bad values', () => {
  for (const body of ['null', '"x"', '{{', JSON.stringify({ enabled: 'yes', minSignals: -1, cooldownMin: '5', model: 'a b; rm -rf' })]) {
    const c = loadMemConfig(makeRepo({ '.sdlc/memory.json': body }, { git: false }))
    assert.equal(c.enabled, false); assert.equal(c.minSignals, 3); assert.equal(c.cooldownMin, 30); assert.equal(c.model, 'haiku')
  }
})

test('parseTopic reads header, description and entries; serialize round-trips', () => {
  const text = `# commands\n> Build and test\n\n${E}\n`
  const t = parseTopic('commands.md', text)
  assert.equal(t.description, 'Build and test')
  assert.deepEqual(t.lines, [{ text: 'Run tests with `npm test`; `npx jest` misses the loader.', source: 's1', added: '2026-10-01', id: 'm-abc123' }])
  assert.equal(serializeTopic(t), text)
})

test('parseTopic keeps non-entry lines', () => {
  const text = `# gotchas\n> Traps\n\nA note a person wrote.\n${E}\n- broken entry [source: x]\n`
  const t = parseTopic('gotchas.md', text)
  assert.equal(t.lines.length, 3)
  assert.equal(t.lines[0], 'A note a person wrote.')
  assert.equal(t.lines[2], '- broken entry [source: x]')
  assert.equal(serializeTopic(t), text)
})

test('loadStore has default topics, reads lowercase .md files, skips MEMORY.md and bad names', () => {
  const dir = makeRepo({
    '.sdlc/memory/MEMORY.md': '# Memory\n', '.sdlc/memory/commands.md': `# commands\n> x\n\n${E}\n`,
    '.sdlc/memory/Bad Name.md': `${E}\n`, '.sdlc/memory/notes.txt': `${E}\n`,
  }, { git: false })
  const s = loadStore(dir)
  assert.deepEqual([...s.keys()].sort(), ['commands.md', 'conventions.md', 'dead-ends.md', 'gotchas.md'])
  assert.equal(allEntries(s).length, 1)
  assert.equal(findEntry(s, 'm-abc123')?.topic.file, 'commands.md')
  assert.equal(findEntry(s, 'm-zzzzzz'), null)
  assert.equal(loadStore(makeRepo({}, { git: false })).size, 4)
})

test('similarity is token Jaccard over normalized text', () => {
  assert.equal(similarity('Use `npm test`.', 'use npm test'), 1)
  assert.ok(similarity('use npm test for tests', 'use pnpm for installs') < 0.5)
})

test('newId is m- plus 6 hex and extends on collision', () => {
  const a = newId('hello', new Set())
  assert.match(a, /^m-[0-9a-f]{6}$/)
  const b = newId('hello', new Set([a]))
  assert.match(b, /^m-[0-9a-f]{7}$/); assert.ok(b.startsWith(a))
})

test('searchEntries matches all terms case-insensitively in text or file name', () => {
  const s = loadStore(makeRepo({ '.sdlc/memory/commands.md': `# commands\n> x\n\n${E}\n` }, { git: false }))
  assert.equal(searchEntries(s, ['NPM', 'jest']).length, 1)
  assert.equal(searchEntries(s, ['commands']).length, 1)
  assert.equal(searchEntries(s, ['npm', 'pnpm']).length, 0)
})

test('buildMemoryMd lists topics with counts and recent entries, deterministic and <= 60 lines', () => {
  const s: Store = loadStore(makeRepo({}, { git: false }))
  s.get('commands.md')!.lines.push({ id: 'm-000001', text: 'old', source: 's', added: '2026-01-01' }, { id: 'm-000002', text: 'new', source: 's', added: '2026-02-01' })
  const md = buildMemoryMd(s)
  assert.equal(md, [
    '# Memory', MEMORY_HEADER, 'Search with `/rig-util:memory-find <terms>` or grep `.sdlc/memory/`.', '',
    '## Topics', '- [[commands]] (2): Build, test and run invocations that work', '',
    '## Recent', '- new ([[commands]], m-000002)', '- old ([[commands]], m-000001)', '',
  ].join('\n'))
  assert.equal(buildMemoryMd(s), md)
  for (let i = 0; i < 100; i++) s.get('gotchas.md')!.lines.push({ id: `m-${String(i).padStart(6, '0')}`, text: `t${i}`, source: 's', added: '2026-03-01' })
  assert.ok(buildMemoryMd(s).split('\n').length <= 61)
  assert.match(buildMemoryMd(loadStore(makeRepo({}, { git: false }))), /## Topics\n- \(none yet\)/)
})
