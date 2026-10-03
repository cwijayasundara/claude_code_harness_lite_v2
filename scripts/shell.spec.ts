// The read-only tokenizer must split words exactly as the real shells do, and what it allows must write nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tokenize, readOnlyDenial } from './shell.ts'

const shells = ['bash', 'zsh'].filter(sh => spawnSync(sh, ['-c', 'true']).status === 0)
const argvIn = (sh: string, cmd: string): string[] =>
  spawnSync(sh, ['-c', `printf '%s\\0' ${cmd}`], { encoding: 'utf8' }).stdout.split('\0').slice(0, -1)

test('tokenize yields the words bash and zsh pass to the command', { skip: shells.length === 0 }, () => {
  const args = ["'-o' F x", '\\-o F x', '"--output=F" x', `-name z \\( -a -o -b \\) '-delete'`, `"say \\"hi\\"" 'a\\|b' "\\bfoo\\b"`,
    `-exe'c' a"b"c ''`, 'a\\\nb "c\\\nd"', `"%h -> %s" -5 -t, -k2`, `'$x' "a\\$b" a\\'b`, `a\tb   c`]
  for (const sh of shells) {
    for (const a of args) assert.deepEqual(tokenize(`cmd ${a}`).segs, [['cmd', ...argvIn(sh, a)]], `${sh}: ${a}`)
  }
})

test('tokenize refuses what it does not model and splits on every separator', () => {
  for (const c of ["echo $'\\''", 'cat x #c', 'ls *(e:x:)', 'cat =(x)', 'a {b,c}', 'a > f', 'a "unterminated', 'a \\']) assert.ok(tokenize(c).bad, c)
  assert.deepEqual(tokenize('a 2>&1 | b && c || d ; e & f\ng 2>/dev/null').segs, [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']])
})

test('allowed read-only commands write nothing when the real shell runs them', { skip: shells.length === 0 }, () => {
  const cmds = ['sort -k2 -t, f', 'find . \\( -name a -o -name f \\) -print', 'cat f 2>/dev/null | head', "sed -n '1p' f", "awk '{print $1}' f", 'echo a#b', 'grep -n a f >/dev/null 2>&1']
  for (const sh of shells) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-'))
    fs.writeFileSync(path.join(dir, 'f'), 'a b\n')
    for (const c of cmds) {
      assert.equal(readOnlyDenial(c, 'sdlc:reviewer', () => new Set()), null, c)
      spawnSync(sh, ['-c', c], { cwd: dir })
    }
    assert.deepEqual(fs.readdirSync(dir), ['f'], sh)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
