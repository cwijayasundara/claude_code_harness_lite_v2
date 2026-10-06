// The harness obeys its own limits (v0.4 spec §12): scripts ≤ 500 lines, mod files ≤ 300, skills and guides ≤ 60.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const count = (f: string): number => fs.readFileSync(f, 'utf8').replace(/\n$/, '').split('\n').length
const filesIn = (dir: string, keep: (name: string) => boolean): string[] =>
  fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)).filter(keep).map(n => path.join(ROOT, dir, n)) : []

const LIMITS: [string, string[], number][] = [
  ['script', filesIn('scripts', n => n.endsWith('.ts') && !n.endsWith('.spec.ts') && n !== 'testkit.ts'), 500],
  ['mod file', filesIn('hooks', n => /\.tsx?$/.test(n)), 300],
  ['skill', filesIn('skills', () => true).map(d => path.join(d, 'SKILL.md')).filter(fs.existsSync), 60],
  ['guide', filesIn('guides', n => n.endsWith('.md')), 60],
]

for (const [kind, files, max] of LIMITS) {
  test(`every ${kind} is at most ${max} lines`, () => {
    const over = files.filter(f => count(f) > max).map(f => `${path.relative(ROOT, f)} (${count(f)})`)
    assert.deepEqual(over, [], `${kind}s over ${max} lines`)
  })
}

const isFile = (f: string): boolean => fs.statSync(f).isFile()
const CAPPED = [
  ...filesIn('scripts', n => n.endsWith('.ts') && !n.endsWith('.spec.ts') && n !== 'testkit.ts'),
  ...filesIn('hooks', () => true),
  ...filesIn('skills', () => true).map(d => path.join(d, 'SKILL.md')).filter(fs.existsSync),
  ...filesIn('agents', n => n.endsWith('.md')),
  ...filesIn('guides', n => n.endsWith('.md')),
  ...filesIn('templates', () => true),
  ...filesIn('.github/workflows', () => true),
  ...filesIn('.claude-plugin', n => n.endsWith('.json')),
  path.join(ROOT, 'package.json'),
].filter(isFile)

test('the harness is at most 6750 lines (tests and docs excluded)', () => {
  const total = CAPPED.reduce((n, f) => n + count(f), 0)
  assert.ok(total <= 6750, `harness is ${total} lines`)
})
