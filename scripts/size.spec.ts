// The harness obeys its own limits (spec §12): scripts ≤ 500 lines, mod files ≤ 300, skills and guides ≤ 60.
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
  ['mod file', filesIn('hooks', n => n.endsWith('.tsx')), 300],
  ['skill', filesIn('skills', () => true).map(d => path.join(d, 'SKILL.md')).filter(fs.existsSync), 60],
  ['guide', filesIn('guides', n => n.endsWith('.md')), 60],
]

for (const [kind, files, max] of LIMITS) {
  test(`every ${kind} is at most ${max} lines`, () => {
    const over = files.filter(f => count(f) > max).map(f => `${path.relative(ROOT, f)} (${count(f)})`)
    assert.deepEqual(over, [], `${kind}s over ${max} lines`)
  })
}
