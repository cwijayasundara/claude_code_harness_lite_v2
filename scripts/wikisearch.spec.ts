import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchDocs, termsOf, type Doc } from './wikisearch.ts'

const docs: Doc[] = [
  { page: 'modules/auth.md', text: '# auth\n\n## In plain words\n\nChecks API keys.\n\n- `src/auth/key.js:1` exports check\n', symbols: [{ ref: 'src/auth/key.js:2', text: 'export function checkKey(k)' }], files: ['src/auth/key.js'] },
  { page: 'modules/billing.md', text: '# billing\n\nCharges cards. Mentions auth once.\n', symbols: [], files: ['src/billing/charge.js'] },
]

test('title and symbol hits outrank a body mention; hits carry path:line refs', () => {
  const r = searchDocs(docs, 'auth key')
  assert.deepEqual(r.map(h => h.page), ['modules/auth.md', 'modules/billing.md'])
  assert.ok((r[0]?.score ?? 0) > (r[1]?.score ?? 0))
  assert.ok(r[0]?.hits.some(h => h.ref === 'src/auth/key.js:2'))
  assert.ok(r[0]?.hits.some(h => /^docs\/wiki\/modules\/auth\.md:\d+$/.test(h.ref)))
})

test('no usable terms or no match returns nothing; one-letter words are dropped; limit applies; ties break by page name', () => {
  assert.deepEqual(searchDocs(docs, 'a ?'), [])
  assert.deepEqual(searchDocs(docs, 'zzzz'), [])
  assert.equal(searchDocs(docs, 'auth', 1).length, 1)
  const tie: Doc[] = [{ page: 'b.md', text: '# xx\n', symbols: [], files: ['f'] }, { page: 'a.md', text: '# xx\n', symbols: [], files: ['f'] }]
  assert.deepEqual(searchDocs(tie, 'xx').map(h => h.page), ['a.md', 'b.md'])
})

test('search is deterministic', () => {
  assert.equal(JSON.stringify(searchDocs(docs, 'auth key')), JSON.stringify(searchDocs(docs, 'auth key')))
})

test('hostile queries: huge, punctuation-only and regex-like input neither crash nor hang', () => {
  assert.deepEqual(searchDocs(docs, '.*+?^${}()|[]\\'.repeat(1000)), [])
  assert.deepEqual(searchDocs(docs, '!!! --- ???'), [])
  assert.deepEqual(searchDocs(docs, '(auth'), searchDocs(docs, 'auth'))
  const big = 'auth '.repeat(200_000)
  assert.equal(searchDocs(docs, big).length, 2)
  assert.ok(termsOf(Array.from({ length: 500 }, (_, i) => `term${i}`).join(' ')).length <= 20)
  assert.deepEqual(termsOf('x'.repeat(1_000_000)).map(t => t.length), [200])
})

test('terms inside generated blocks neither rank a page nor become page hits; symbols, files and prose still do', () => {
  const text = '# alpha\n\nProse about zebra.\n\n<!-- rig:gen:architecture -->\n## Architecture\n\n```mermaid\n  C --> n_gizmo\n```\n<!-- /rig:gen -->\n\n<!-- rig:gen:files -->\n| [`src/x.js`](x) | gizmo widget | 3 |\n<!-- /rig:gen -->\n'
  const docs = [{ page: 'modules/alpha.md', text, symbols: [{ ref: 'src/x.js:1', text: 'export const sprocket = 1' }], files: ['src/x.js'] }]
  assert.deepEqual(searchDocs(docs, 'gizmo'), [])
  assert.deepEqual(searchDocs(docs, 'architecture'), [])
  assert.equal(searchDocs(docs, 'sprocket')[0]?.page, 'modules/alpha.md')
  const prose = searchDocs(docs, 'zebra')
  assert.deepEqual(prose[0]?.hits, [{ ref: 'docs/wiki/modules/alpha.md:3', text: 'Prose about zebra.' }])
})
