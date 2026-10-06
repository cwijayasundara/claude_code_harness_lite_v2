import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spliceBlock, blockBody, pageSkeleton, proseProblems, pageSummary, architecture, systemDiagram, linkBase, fileLink, startOrder, uniqueIds, BLOCKS } from './wikigen.ts'
import type { Graph } from './wikigraph.ts'

const graph = (edges: Record<string, Record<string, number>>, extra: Partial<Graph> = {}): Graph => ({
  moduleOf: new Map(), imports: new Map(), external: new Map(), unresolved: new Map(), uncomputed: new Map(),
  edges: new Map(Object.entries(edges).map(([a, row]) => [a, new Map(Object.entries(row))])), ...extra,
})

test('spliceBlock replaces only the block, keeps surrounding prose byte for byte, and is idempotent', () => {
  const page = '# m\n\nMy prose.\n\n<!-- rig:gen:files -->\nold\n<!-- /rig:gen -->\n\nMore prose.\n'
  const once = spliceBlock(page, 'files', '## Key files\n\nnew')
  assert.equal(once, '# m\n\nMy prose.\n\n<!-- rig:gen:files -->\n## Key files\n\nnew\n<!-- /rig:gen -->\n\nMore prose.\n')
  assert.equal(spliceBlock(once, 'files', '## Key files\n\nnew'), once)
  assert.equal(blockBody(once, 'files'), '## Key files\n\nnew')
  assert.equal(blockBody(once, 'tests'), null)
})

test('a missing block goes before the first later block, else at the end', () => {
  const withFiles = spliceBlock('# m\n\n<!-- rig:gen:tests -->\nt\n<!-- /rig:gen -->\n', 'files', 'F')
  assert.ok(withFiles.indexOf('rig:gen:files') < withFiles.indexOf('rig:gen:tests'))
  assert.equal(spliceBlock('# m\n\nprose\n', 'architecture', 'A'), '# m\n\nprose\n\n<!-- rig:gen:architecture -->\nA\n<!-- /rig:gen -->\n')
})

test('pageSkeleton lists every block in order, with prose sections pending around the architecture', () => {
  const s = pageSkeleton('auth')
  const at = BLOCKS.map(b => s.indexOf(`rig:gen:${b}`))
  assert.ok(at.every(i => i > 0))
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'blocks appear in BLOCKS order')
  assert.deepEqual(proseProblems(s), ['In plain words', 'Walk-through'])
  assert.ok(s.indexOf('## In plain words') < s.indexOf('rig:gen:architecture') && s.indexOf('rig:gen:architecture') < s.indexOf('## Walk-through'))
})

test('proseProblems flags missing, empty and pending sections only', () => {
  const ok = '# m\n\n## In plain words\n\nIt does a thing.\n\n<!-- rig:gen:architecture -->\n<!-- /rig:gen -->\n\n## Walk-through\n\nA request enters.\n'
  assert.deepEqual(proseProblems(ok), [])
  assert.deepEqual(proseProblems('# m\n\n## In plain words\n\n\n## Walk-through\n\n_pending: run /rig:wiki_\n'), ['In plain words', 'Walk-through'])
  assert.deepEqual(proseProblems('# m\n'), ['In plain words', 'Walk-through'])
})

test('pageSummary reads the first quote line and ignores the pending placeholder', () => {
  assert.equal(pageSummary('# m\n\n> Checks API keys.\n\ntext'), 'Checks API keys.')
  assert.equal(pageSummary('# m\n\n> _summary pending_\n'), '')
  assert.equal(pageSummary('# m\n'), '')
})

test('architecture draws neighbours both ways with counts, newest strongest first', () => {
  const g = graph({ 'm/a.md': { 'm/b.md': 3, 'm/c.md': 1 }, 'm/d.md': { 'm/a.md': 2 } })
  assert.equal(architecture(g, 'm/a.md'), [
    '## Architecture', '', '```mermaid', 'flowchart LR', '  C["a"]',
    '  n_m_b_md["b"]', '  C -->|3| n_m_b_md', '  n_m_d_md["d"]', '  n_m_d_md -->|2| C', '  n_m_c_md["c"]', '  C -->|1| n_m_c_md', '```',
  ].join('\n'))
})

test('architecture caps at 12 neighbours and collapses the rest; handles none and uncomputed languages; mutual edges draw both ways', () => {
  const many = graph({ 'm/a.md': Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`m/x${String(i).padStart(2, '0')}.md`, 1])) })
  const text = architecture(many, 'm/a.md')
  assert.equal((text.match(/-->\|1\|/g) ?? []).length, 12)
  assert.match(text, /more\["\+2 more"\]\n {2}C -\.- more/)
  assert.match(architecture(graph({}), 'm/a.md'), /_No imports to or from other modules\._/)
  const go = architecture(graph({}, { uncomputed: new Map([['m/a.md', ['.go']]]) }), 'm/a.md')
  assert.match(go, /Edges not computed for \.go/)
  assert.doesNotMatch(go, /mermaid/)
  const mutual = architecture(graph({ 'm/a.md': { 'm/b.md': 1 }, 'm/b.md': { 'm/a.md': 4 } }), 'm/a.md')
  assert.match(mutual, /C -->\|1\| n_m_b_md/)
  assert.match(mutual, /n_m_b_md -->\|4\| C/)
})

test('systemDiagram lists modules and clusters by directory above the threshold', () => {
  const small = systemDiagram(graph({ 'm/a.md': { 'm/b.md': 2 } }), ['m/a.md', 'm/b.md'], p => p.split('/')[0] ?? p, 30)
  assert.match(small, /n_m_a_md\["a"\]/)
  assert.match(small, /n_m_a_md -->\|2\| n_m_b_md/)
  const pages = Array.from({ length: 31 }, (_, i) => `${i % 2 ? 'x' : 'y'}/p${i}.md`)
  const big = systemDiagram(graph({ 'x/p1.md': { 'y/p0.md': 1, 'y/p2.md': 1 } }), pages, p => p.split('/')[0] ?? p, 30)
  assert.match(big, /g_x\["x"\]/)
  assert.match(big, /g_x -->\|2\| g_y/)
  assert.doesNotMatch(big, /p1/)
})

test('links: GitHub blob URLs from an https or ssh remote, relative paths otherwise, names percent-encoded', () => {
  for (const remote of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'https://github.com/o/r']) {
    assert.deepEqual(linkBase(remote, 'main'), { kind: 'github', base: 'https://github.com/o/r/blob/main' })
  }
  assert.deepEqual(linkBase(null, 'main'), { kind: 'relative' })
  assert.deepEqual(linkBase('https://gitlab.com/o/r.git', 'main'), { kind: 'relative' })
  const gh = { kind: 'github', base: 'https://github.com/o/r/blob/main' } as const
  assert.equal(fileLink(gh, 'src/a.js', 12), 'https://github.com/o/r/blob/main/src/a.js#L12')
  assert.equal(fileLink(gh, 'src/we|ird file.js'), 'https://github.com/o/r/blob/main/src/we%7Cird%20file.js')
  assert.equal(fileLink({ kind: 'relative' }, 'src/a.js', 12, 'docs/wiki/modules'), '../../../src/a.js#L12')
})

test('startOrder: manifest order first, then most depended on, then name', () => {
  const g = graph({ 'm/a.md': { 'm/c.md': 3 }, 'm/b.md': { 'm/c.md': 1, 'm/a.md': 1 } })
  const pages = ['m/a.md', 'm/b.md', 'm/c.md']
  assert.deepEqual(startOrder(g, pages, []), ['m/c.md', 'm/a.md', 'm/b.md'])
  assert.deepEqual(startOrder(g, pages, ['m/b.md']), ['m/b.md', 'm/c.md', 'm/a.md'])
})

test('uniqueIds keeps readable ids, suffixes only collisions in cmp order, and skips taken ids', () => {
  const base = (k: string): string => k.replace(/[^a-z]/g, '')
  assert.deepEqual([...uniqueIds(['b!', 'b', 'c'], base)], [['b', 'b'], ['b!', 'b_2'], ['c', 'c']])
  assert.deepEqual([...uniqueIds(['x1', 'x', 'x!', 'x_2'], k => (k === 'x1' ? 'x_2' : k.replace(/[^a-z]/g, '')))].map(([, v]) => v).sort(), ['x', 'x_2', 'x_3', 'x_4'])
})

test('colliding names stay distinct nodes with their own labels and edges', () => {
  const ids = (t: string): string[] => [...t.matchAll(/^ {2}(\w+)\["[^"]*"\]$/gm)].map(m => m[1] ?? '')
  for (const [a, b] of [['m/\u00e9.md', 'm/\u00e9!.md'], ['m/x y.md', 'm/x_y.md']] as const) {
    const t = architecture(graph({ 'm/c.md': { [a]: 1, [b]: 2 } }), 'm/c.md')
    const nodes = ids(t).filter(i => i !== 'C')
    assert.equal(new Set(nodes).size, 2, t)
    assert.equal((t.match(new RegExp(`\\["${a.slice(2, -3)}"\\]`, 'g')) ?? []).length, 1)
    assert.equal((t.match(/-->\|[12]\|/g) ?? []).length, 2)
    assert.equal(architecture(graph({ 'm/c.md': { [a]: 1, [b]: 2 } }), 'm/c.md'), t)
  }
  const pages = Array.from({ length: 31 }, (_, i) => `${i % 2 ? 'a-b' : 'a_b'}/p${i}.md`)
  const big = systemDiagram(graph({ 'a-b/p1.md': { 'a_b/p0.md': 1 } }), pages, p => p.split('/')[0] ?? p, 30)
  const gids = ids(big)
  assert.equal(new Set(gids).size, 2, big)
  assert.equal((big.match(/\["a-b"\]/g) ?? []).length, 1)
  assert.equal((big.match(/\["a_b"\]/g) ?? []).length, 1)
  assert.equal((big.match(/-->\|1\|/g) ?? []).length, 1)
  assert.equal(systemDiagram(graph({ 'a-b/p1.md': { 'a_b/p0.md': 1 } }), pages, p => p.split('/')[0] ?? p, 30), big)
})

test('CRLF pages: spliceBlock replaces the existing block, blockBody reads it', () => {
  const page = 'a\r\n<!-- rig:gen:files -->\r\nx\r\n<!-- /rig:gen -->\r\n'
  const out = spliceBlock(page, 'files', 'N')
  assert.equal((out.match(/rig:gen:files/g) ?? []).length, 1)
  assert.equal(blockBody(out, 'files'), 'N')
  assert.equal(blockBody(page, 'files'), 'x')
})
