import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spliceBlock, blockBody, pageSkeleton, proseProblems, pageSummary, architecture, systemDiagram, linkBase, fileLink, startOrder, uniqueIds, BLOCKS } from './wikigen.ts'
import { buildGraph, type Graph } from './wikigraph.ts'
import { parseConfig } from './model.ts'
import { renderFiles, renderEntrypoints, renderDeps, renderTests, renderWhy, renderRecent, renderBlock, renderStart, renderModules, type Ctx } from './wikigen.ts'

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

function mk(m: Record<string, string>, pages: Record<string, { globs: string[] }>, extra: Partial<Ctx> = {}): Ctx {
  const files = Object.keys(m).sort()
  const read = (f: string): string => m[f] ?? ''
  return { pages, files, graph: buildGraph(pages, files, read), link: { kind: 'relative' }, config: parseConfig('').config, read, changes: [], commits: () => [], ...extra }
}
const A = { 'm/a.md': { globs: ['src/a/**'] } }

test('renderFiles: role from the first comment, tests excluded, links relative, hostile names escaped', () => {
  const c = mk({ 'src/a/x.js': '// Parses the key header\nexport const x = 1\n', 'src/a/x.test.js': 'test("t", () => {})\n', 'src/a/we|ird file.js': '// a | b\nx\n' }, A)
  const out = renderFiles(c, 'm/a.md')
  assert.match(out, /^## Key files/)
  assert.match(out, /\| \[`src\/a\/x\.js`\]\(\.\.\/\.\.\/\.\.\/src\/a\/x\.js\) \| Parses the key header \| 2 \|/)
  assert.doesNotMatch(out, /x\.test\.js/)
  assert.match(out, /\[`src\/a\/we\\\|ird file\.js`\]\(\.\.\/\.\.\/\.\.\/src\/a\/we%7Cird%20file\.js\) \| a \\\| b \| 2 \|/)
})

test('renderFiles: an empty module says so, and rows cap at 40', () => {
  assert.match(renderFiles(mk({}, A), 'm/a.md'), /_No source files match the module globs\._/)
  const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`src/a/f${String(i).padStart(2, '0')}.js`, 'x\n']))
  const out = renderFiles(mk(many, A), 'm/a.md')
  assert.equal((out.match(/^\| \[/gm) ?? []).length, 40)
  assert.match(out, /_\+5 more_/)
})

test('renderEntrypoints: exported lines with file:line links', () => {
  const c = mk({ 'src/a/x.js': 'const h = 1\nexport function check(k) {\n  return k\n}\nexport const y = 2\n' }, A)
  const out = renderEntrypoints(c, 'm/a.md')
  assert.match(out, /\| `export function check\(k\) \{` \| \[src\/a\/x\.js:2\]\(.*#L2\) \|/)
  assert.match(out, /export const y = 2/)
  assert.match(renderEntrypoints(mk({ 'src/a/x.js': 'const h = 1\n' }, A), 'm/a.md'), /_No exported symbols found\._/)
})

// Count the unescaped pipes in a table row: a stray one is a stray cell boundary.
const bareCells = (row: string): number => (row.replace(/\\\|/g, '').match(/\|/g) ?? []).length

test('hostile file names never add a cell boundary or a raw space or pipe to a link', () => {
  const names = ['src/a/we|ird file.js', 'src/a/back`tick.js', 'src/a/café.js']
  const m: Record<string, string> = {}
  for (const n of names) m[n] = '// role | x\nexport const v = 1\n'
  m['src/a/we|ird file.test.js'] = "test('t | u', () => {})\n"
  const c = mk(m, A)
  for (const [out, cols] of [[renderFiles(c, 'm/a.md'), 3], [renderEntrypoints(c, 'm/a.md'), 2]] as const) {
    const rows = out.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| File') && !l.startsWith('| Symbol'))
    assert.ok(rows.length >= 3)
    for (const r of rows) assert.equal(bareCells(r), cols + 1, r)
  }
  const tests = renderTests(c, 'm/a.md')
  for (const l of tests.split('\n').filter(l => l.startsWith('- '))) assert.equal(bareCells(l), 0, l)
  for (const out of [renderFiles(c, 'm/a.md'), renderEntrypoints(c, 'm/a.md'), tests]) {
    for (const [, target] of out.matchAll(/\]\(([^)]*)\)/g)) assert.doesNotMatch(target ?? '', /[ |`]/, target)
  }
})

const THREE = { 'm/a.md': { globs: ['src/a/**'] }, 'm/b.md': { globs: ['src/b/**'] }, 'm/c.md': { globs: ['src/c/**'] } }
const SRC3 = { 'src/a/x.js': "import a from '../b/y.js'\nimport _ from 'lodash'\n", 'src/b/y.js': 'export const y = 1\n', 'src/c/z.js': "import { y } from '../b/y.js'\n" }

test('renderDeps: depends on, used by, and the top external packages', () => {
  const c = mk(SRC3, THREE)
  const a = renderDeps(c, 'm/a.md')
  assert.match(a, /\*\*Depends on\*\*\n\n- \[b\]\(b\.md\) · 1 import\n/)
  assert.match(a, /- `lodash` · 1/)
  assert.match(renderDeps(c, 'm/b.md'), /\*\*Used by\*\*\n\n- \[a\]\(a\.md\) · 1 import\n- \[c\]\(c\.md\) · 1 import/)
  assert.match(renderDeps(c, 'm/c.md'), /\*\*Used by\*\*\n\n_No other module\._/)
})

test('renderTests: tests inside the module and tests that import it, with test names', () => {
  const c = mk({
    'src/a/x.js': 'export const x = 1\n',
    'test/x.test.js': "import { x } from '../src/a/x.js'\ntest('x is one', () => {})\nit(\"and two\", () => {})\n",
    'test/other.test.js': "test('unrelated', () => {})\n",
  }, A)
  const out = renderTests(c, 'm/a.md')
  assert.match(out, /test\/x\.test\.js.*x is one; and two/)
  assert.doesNotMatch(out, /other\.test/)
  assert.match(renderTests(mk({ 'src/a/x.js': 'x\n' }, A), 'm/a.md'), /_No test file found for this module\._/)
})

test('renderWhy: matching changes newest first, other modules excluded, commits fill the remaining rows without repeating a listed change', () => {
  const c = mk({ 'src/a/x.js': 'x\n' }, { ...A, 'm/b.md': { globs: ['src/b/**'] } }, {
    changes: [
      { slug: 'old-one', type: 'chore', summary: 'tidy', created: '2026-10-01T00:00:00Z', plan: ['src/a/**'] },
      { slug: 'add-auth', type: 'feature', summary: 'Add key checks | fast', created: '2026-10-05T00:00:00Z', plan: ['src/a/**'] },
      { slug: 'elsewhere', type: 'bugfix', summary: 'x', created: '2026-10-06T00:00:00Z', plan: ['src/b/**'] },
    ],
    commits: () => [{ sha: 'abc1234', date: '2026-10-04', subject: 'tweak a' }, { sha: 'def5678', date: '2026-10-03', subject: 'ship add-auth' }],
  })
  const out = renderWhy(c, 'm/a.md')
  assert.ok(out.indexOf('add-auth') < out.indexOf('old-one'), 'newest first')
  assert.doesNotMatch(out, /elsewhere/)
  assert.match(out, /\[add-auth\]\(\.\.\/\.\.\/\.\.\/\.sdlc\/changes\/add-auth\/intent\.md\) · feature · Add key checks \\\| fast/)
  assert.match(out, /`abc1234` · commit · tweak a/)
  assert.doesNotMatch(out, /def5678/)
  assert.match(renderWhy(mk({ 'src/a/x.js': 'x\n' }, A), 'm/a.md'), /_No recorded change touches this module yet\._/)
})

test('renderWhy caps at 8 rows', () => {
  const changes = Array.from({ length: 10 }, (_, i) => ({ slug: `c${i}`, type: 'chore', summary: 's', created: `2026-10-0${i}T00:00:00Z`, plan: ['src/a/**'] }))
  assert.equal((renderWhy(mk({ 'src/a/x.js': 'x\n' }, A, { changes }), 'm/a.md').match(/^- \[/gm) ?? []).length, 8)
})

test('renderRecent lists commits, or says there are none; renderBlock dispatches by name', () => {
  const commits = () => [{ sha: 'abc1234', date: '2026-10-04', subject: 'tweak a' }]
  assert.match(renderRecent(mk({ 'src/a/x.js': 'x\n' }, A, { commits }), 'm/a.md'), /- `abc1234` 2026-10-04 · tweak a/)
  assert.match(renderRecent(mk({ 'src/a/x.js': 'x\n' }, A), 'm/a.md'), /_No commits yet\._/)
  const c = mk(SRC3, THREE)
  assert.equal(renderBlock(c, 'm/a.md', 'deps'), renderDeps(c, 'm/a.md'))
})

test('index renderers: a numbered start-here list and a module table', () => {
  assert.equal(renderModules(['m/a.md'], () => 'Checks keys'), ['## Modules', '', '| Module | What it does | Page |', '|---|---|---|', '| a | Checks keys | [m/a.md](m/a.md) |'].join('\n'))
  assert.equal(renderModules(['m/a.md'], () => ''), ['## Modules', '', '| Module | What it does | Page |', '|---|---|---|', '| a | — | [m/a.md](m/a.md) |'].join('\n'))
  assert.equal(renderStart(['m/b.md', 'm/a.md'], p => (p === 'm/a.md' ? 'A' : '')), ['## Start here', '', '1. [b](m/b.md)', '2. [a](m/a.md): A'].join('\n'))
})

test('role: skips comment decoration, JSDoc openers, preprocessor lines and directives', () => {
  const roleOf = (text: string): string => {
    const out = renderFiles(mk({ 'src/a/x.js': text }, A), 'm/a.md')
    return /^\| \[[^\n]*?\]\([^)]*\) \| (.*) \| \d+ \|$/m.exec(out)?.[1] ?? 'NOROW'
  }
  assert.equal(roleOf('/**\n * Real doc\n */\nexport const x = 1\n'), 'Real doc')
  assert.equal(roleOf('///\n/// Parses it\nx\n'), 'Parses it')
  assert.equal(roleOf('/\nx\n'), '')
  assert.equal(roleOf('*/\nx\n'), '')
  assert.equal(roleOf('#include <stdio.h>\n// Parses headers\n'), 'Parses headers')
  assert.equal(roleOf('# ====\n# Real line\n'), 'Real line')
  assert.equal(roleOf('#!/usr/bin/env node\n// eslint-disable\n// After\n'), 'After')
})
