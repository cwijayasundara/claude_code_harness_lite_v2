import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readSignals } from './capture.ts'
import { commitAll, makeRepo } from '../shared/testkit.ts'

const cli = path.resolve('memory/memory.ts')
const run = (dir: string, args: string[], input = '', env: Record<string, string> = {}) =>
  spawnSync('node', ['--disable-warning=ExperimentalWarning', cli, ...args], { cwd: dir, input, encoding: 'utf8', env: { ...process.env, RIG_BRAIN_DREAMING: '', ...env } })
const on = () => makeRepo({ '.sdlc/memory.json': JSON.stringify({ enabled: true, minSignals: 99 }) })
const failing = (dir: string) => JSON.stringify({ cwd: dir, session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npx jest' }, tool_response: { exit_code: 1, stderr: 'not found' } })

test('every hook exits 0 silently on garbage input', () => {
  const dir = on()
  for (const ev of ['session-start', 'post-bash', 'tool-fail', 'post-edit', 'prompt', 'stop', 'bogus']) {
    const r = run(dir, ['hook', ev], 'not json {{{')
    assert.equal(r.status, 0, ev); assert.equal(r.stdout, '', ev); assert.equal(r.stderr, '', ev)
  }
})

test('hooks capture only when enabled and not inside a dream', () => {
  const off = makeRepo({})
  run(off, ['hook', 'post-bash'], failing(off))
  assert.equal(readSignals(off).length, 0)
  const dir = on()
  run(dir, ['hook', 'post-bash'], failing(dir), { RIG_BRAIN_DREAMING: '1' })
  assert.equal(readSignals(dir).length, 0)
  run(dir, ['hook', 'post-bash'], failing(dir))
  assert.equal(readSignals(dir)[0].kind, 'cmd-fail')
  assert.equal(run(dir, ['hook', 'stop'], JSON.stringify({ cwd: dir })).stdout, '')
  assert.equal(fs.existsSync(path.join(dir, '.sdlc/memory/.cache/dream.lock')), false)
})

test('hook resolves the repo root from a subdirectory cwd', () => {
  const dir = on()
  fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true })
  run(path.join(dir, 'src/deep'), ['hook', 'post-bash'], failing(path.join(dir, 'src/deep')))
  assert.equal(readSignals(dir).length, 1)
})

test('session-start prints memory; find, forget and status work', () => {
  const dir = on()
  const md = '# commands\n> x\n\n- use npm test [source: s; added: 2026-10-09; id: m-abc123]\n'
  fs.mkdirSync(path.join(dir, '.sdlc/memory'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sdlc/memory/commands.md'), md)
  fs.writeFileSync(path.join(dir, '.sdlc/memory/MEMORY.md'), '# Memory\n')
  assert.doesNotMatch(run(dir, ['hook', 'session-start'], JSON.stringify({ cwd: dir })).stdout, /Memory from past sessions/)
  commitAll(dir, 'mem')
  assert.match(run(dir, ['hook', 'session-start'], JSON.stringify({ cwd: dir })).stdout, /Memory from past sessions[\s\S]*# Memory/)
  assert.equal(run(dir, ['find', 'NPM']).stdout, 'm-abc123 commands.md use npm test\n')
  assert.equal(run(dir, ['find', 'zzz']).stdout, 'no matches\n')
  assert.match(run(dir, ['status']).stdout, /enabled: true\nentries: 1\npending signals: 0\nlast dream: never/)
  assert.equal(run(dir, ['forget', 'm-abc123']).stdout, 'removed m-abc123\n')
  assert.equal(run(dir, ['forget', 'm-abc123']).stdout, 'not found: m-abc123\n')
})

test('forget without an id prints usage; non-hook commands target the repo root from a subdirectory', () => {
  const dir = on()
  assert.equal(run(dir, ['forget']).stdout, 'usage: memory.ts forget <id>\n')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  assert.match(run(path.join(dir, 'src'), ['status']).stdout, /enabled: true/)
  assert.match(run(dir, ['status', '--root']).stdout, /enabled: true/)
})

test('a failing hook stays silent but is logged', () => {
  const dir = on()
  fs.mkdirSync(path.join(dir, '.sdlc/memory/.cache/signals.jsonl'), { recursive: true })
  const r = run(dir, ['hook', 'post-bash'], failing(dir))
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '')
  assert.match(fs.readFileSync(path.join(dir, '.sdlc/memory/.cache/log'), 'utf8'), /hook post-bash failed: /)
})

test('dream rejects unsafe batch ids', () => {
  const dir = on()
  assert.equal(run(dir, ['dream', '../../x']).stdout, 'usage: memory.ts dream <batch-id>|--now\n')
})
