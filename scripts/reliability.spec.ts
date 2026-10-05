// Reliability under load and concurrency: parallel hooks, big untracked trees, vendoring guards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { makeRepo, sdlc, hook, write } from './testkit.ts'

const SCRIPT = path.join(import.meta.dirname, 'sdlc.ts')
const runHook = (repo: string, name: string, input: object): Promise<void> => new Promise(resolve => {
  const p = spawn('node', ['--disable-warning=ExperimentalWarning', SCRIPT, 'hook', name], { cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, stdio: ['pipe', 'ignore', 'ignore'] })
  p.on('close', () => resolve())
  p.stdin.end(JSON.stringify(input))
})

test('parallel post-edit hooks all land in .gate, and parallel subagent baselines all survive', async () => {
  const repo = makeRepo()
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  const n = 10
  for (let i = 0; i < n; i++) write(repo, `f${i}.ts`, `export const v${i} = ${i}\n`)
  await Promise.all(Array.from({ length: n }, (_, i) => runHook(repo, 'post-edit', { tool_input: { file_path: path.join(repo, `f${i}.ts`) }, agent_id: `a${i}` })))
  const gate = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/.gate'), 'utf8')) as { tool: string[] }
  assert.equal(gate.tool.length, n, `recorded ${gate.tool.length} of ${n}`)
  await Promise.all(Array.from({ length: n }, (_, i) => runHook(repo, 'subagent-start', { agent_id: `a${i}` })))
  const base = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/.baseline'), 'utf8')) as { agents: Record<string, unknown> }
  assert.equal(Object.keys(base.agents).length, n)
  assert.deepEqual(fs.readdirSync(path.join(repo, '.sdlc')).filter(f => f.endsWith('.lock') || f.endsWith('.tmp')), [], 'no lock or temp file is left behind')
})

test('a stale lock does not wedge a hook', () => {
  const repo = makeRepo()
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const lock = path.join(repo, '.sdlc/.gate.lock')
  fs.mkdirSync(lock)
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(lock, old, old)
  hook(repo, 'prompt-submit', {})
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/.gate')))
})

test('a turn on a tree with many untracked files is fast and still sees a changed one', () => {
  const repo = makeRepo()
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  fs.mkdirSync(path.join(repo, 'gen'))
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(repo, 'gen', `g${i}.txt`), `x${i}`)
  const t0 = Date.now()
  hook(repo, 'prompt-submit', {})
  assert.ok(Date.now() - t0 < 10_000, `prompt-submit took ${Date.now() - t0} ms`)
  write(repo, 'gen/g7.txt', 'a much longer line than before')
  const r = sdlc(repo, ['check', '--at', 'stop', '--json'])
  assert.match(r.stdout, /findings/)
})

test('vendor refuses a downgrade, and a settings file with comments, before writing anything', () => {
  const repo = makeRepo()
  const plugin = path.join(import.meta.dirname, '..')
  const vend = (...extra: string[]) => spawnSync('node', ['--disable-warning=ExperimentalWarning', path.join(plugin, 'scripts/sdlc.ts'), 'vendor', '--standalone', ...extra], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } })
  write(repo, '.claude/settings.json', '{\n  // a comment\n  "model": "x"\n}\n')
  const bad = vend()
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr + bad.stdout, /not plain JSON/)
  assert.equal(fs.existsSync(path.join(repo, '.sdlc/bin')), false, 'nothing written')
  fs.rmSync(path.join(repo, '.claude'), { recursive: true })
  assert.equal(vend().status, 0)
  write(repo, '.sdlc/bin/VERSION', '99.0.0\n')
  const down = vend()
  assert.notEqual(down.status, 0)
  assert.match(down.stderr + down.stdout, /newer than this plugin/)
  assert.equal(vend('--force').status, 0)
})
