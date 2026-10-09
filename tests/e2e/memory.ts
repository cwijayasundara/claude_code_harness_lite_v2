import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const plugin = path.resolve('.')
const cli = path.join(plugin, 'memory/memory.ts')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigutil-mem-e2e-'))
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', private: true, scripts: { test: "node -e \"console.log('tests ok')\"" } }, null, 2))
fs.mkdirSync(path.join(dir, '.sdlc'), { recursive: true })
fs.writeFileSync(path.join(dir, '.sdlc/memory.json'), JSON.stringify({ enabled: true, minSignals: 1, cooldownMin: 0 }))
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: 10 * 60_000 })
sh('git', ['init', '-q', '-b', 'main']); sh('git', ['add', '-A']); sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

const r = sh('claude', ['-p', 'Run the unit tests with `npx --no-install jest`. If that fails, read package.json, run the right test command, and stop. Do not install anything.',
  '--plugin-dir', plugin, '--allowedTools', 'Bash', 'Read'])
assert.equal(r.status, 0, r.stderr)
const signals = fs.readFileSync(path.join(dir, '.sdlc/memory/.cache/signals.jsonl'), 'utf8')
assert.match(signals, /"kind":"cmd-fail"/)

// the Stop hook may have started a background dream; wait for its lock to clear, then dream in the foreground if needed
const lock = path.join(dir, '.sdlc/memory/.cache/dream.lock')
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (let i = 0; i < 150 && fs.existsSync(lock); i++) sleep(2000)
const entries = () => fs.readdirSync(path.join(dir, '.sdlc/memory')).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
  .flatMap(f => fs.readFileSync(path.join(dir, '.sdlc/memory', f), 'utf8').split('\n').filter(l => l.startsWith('- ')))
if (!entries().length) console.log(spawnSync('node', ['--disable-warning=ExperimentalWarning', cli, 'dream', '--now'], { cwd: dir, encoding: 'utf8', timeout: 10 * 60_000 }).stdout.trim())
assert.ok(entries().some(l => /npm (run )?test|jest/i.test(l)), `expected a lesson about the test command, got:\n${entries().join('\n')}\nlog:\n${fs.readFileSync(path.join(dir, '.sdlc/memory/.cache/log'), 'utf8')}`)
console.log(`memory e2e ok in ${dir}:\n${entries().join('\n')}`)
