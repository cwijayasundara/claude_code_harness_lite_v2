// Integration: baselines and diffs, sdlc check at each point, ship verdicts. Each test gets a fresh temp repo.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn, verified } from './testkit.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, 'src/app.js', 'export const a = 1\n')
  write(repo, 'notes.txt', 'untracked before the turn\n')
  gitIn(repo, 'add', 'src/app.js')
  gitIn(repo, 'commit', '-qm', 'app')
})

const turnFiles = () => JSON.parse(sdlc(repo, ['diff', '--turn', '--json']).stdout).map((d: { file: string; status: string }) => `${d.status} ${d.file}`).sort()

test('the turn diff holds tracked edits, Bash-style writes and new untracked files, not older untracked ones', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 2\n')
  fs.appendFileSync(path.join(repo, 'src/app.js'), '// via sed\n')
  write(repo, 'src/new.js', 'export const b = 1\n')
  assert.deepEqual(turnFiles(), ['A src/new.js', 'M src/app.js'])
})

test('an untracked file changed during the turn counts; a staged-only change counts', () => {
  hook(repo, 'prompt-submit', {})
  fs.appendFileSync(path.join(repo, 'notes.txt'), 'edited\n')
  write(repo, 'src/app.js', 'export const a = 3\n')
  gitIn(repo, 'add', 'src/app.js')
  assert.deepEqual(turnFiles(), ['A notes.txt', 'M src/app.js'])
})

test('an untracked .sdlc/sensors.json created during the turn appears in the turn diff', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', '{"ignore":["**"]}\n')
  assert.ok(turnFiles().includes('A .sdlc/sensors.json'))
})

test('a diff over 1 MB is parsed, not silently empty', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/big.js', Array.from({ length: 80_000 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  gitIn(repo, 'add', 'src/big.js')
  const diffs = JSON.parse(sdlc(repo, ['diff', '--turn', '--json']).stdout)
  assert.equal(diffs.find((d: { file: string }) => d.file === 'src/big.js')?.added.length, 80_000)
})

test('the branch diff covers commits since the merge-base plus the working tree', () => {
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, 'src/app.js', 'export const a = 4\n')
  gitIn(repo, 'commit', '-qam', 'wip')
  write(repo, 'src/later.js', 'x\n')
  const files = JSON.parse(sdlc(repo, ['diff', '--base', 'main', '--json']).stdout).map((d: { file: string }) => d.file).filter((f: string) => !f.startsWith('.sdlc/')).sort()
  assert.deepEqual(files, ['notes.txt', 'src/app.js', 'src/later.js'])
})

test('no commits yet: prompt-submit is silent and writes no baseline', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bare-'))
  gitIn(bare, 'init', '-q')
  sdlc(bare, ['init'])
  const r = hook(bare, 'prompt-submit', {})
  assert.deepEqual([r.code, r.stdout], [0, ''])
  assert.ok(!fs.existsSync(path.join(bare, '.sdlc/.baseline')))
})
