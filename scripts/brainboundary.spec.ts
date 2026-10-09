import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BRAIN = path.join(ROOT, 'brain')
const SKIP = new Set(['node_modules', '.git', '.cache', 'dist'])
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (SKIP.has(e.name)) return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? tsFiles(p) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : []
  })
}
const relative = (file: string): string[] =>
  [...fs.readFileSync(file, 'utf8').matchAll(IMPORT)].map(m => m[1]).filter(s => s.startsWith('.')).map(s => path.resolve(path.dirname(file), s))

test('brain imports nothing from rig core: it may only reach its own files', () => {
  const escapes = tsFiles(BRAIN).flatMap(f => relative(f).filter(t => t !== BRAIN && !t.startsWith(BRAIN + path.sep)).map(t => `${path.relative(ROOT, f)} -> ${path.relative(ROOT, t)}`))
  assert.deepEqual(escapes, [])
})

test('rig core imports nothing from brain', () => {
  const top = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && !SKIP.has(e.name) && e.name !== 'brain' && !e.name.startsWith('.'))
  const reach = top.flatMap(d => tsFiles(path.join(ROOT, d.name))).flatMap(f => relative(f).filter(t => t === BRAIN || t.startsWith(BRAIN + path.sep)).map(t => `${path.relative(ROOT, f)} -> ${path.relative(ROOT, t)}`))
  assert.deepEqual(reach, [])
})

test('both plugins are listed by the one marketplace, each with its own manifest', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'))
  assert.deepEqual(m.plugins.map((p: any) => [p.name, p.source]), [['rig', './'], ['rig-brain', './brain']])
  assert.equal(JSON.parse(fs.readFileSync(path.join(BRAIN, '.claude-plugin/plugin.json'), 'utf8')).name, 'rig-brain')
})
