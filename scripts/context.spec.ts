// Context sensor and background-session count (proposal 2026-10-08 §3.3.2, §3.3.3): the first call of a session that
// arrives heavy, turns over the hard limit, and the hook-spawned sessions a plugin runs behind the model's back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextWarnings, FIRST_CALL_LIMIT, TURN_LIMIT, backgroundSessions, projectSlug, enabledPlugins } from './context.ts'
import { makeRepo, sdlc, write } from './testkit.ts'

test('a first call under the limit and a normal turn warn about nothing', () => {
  assert.deepEqual(contextWarnings({ kind: 'main', first: true, ctx: FIRST_CALL_LIMIT }, []), [])
  assert.deepEqual(contextWarnings({ kind: 'main', ctx: TURN_LIMIT }, []), [])
  assert.deepEqual(contextWarnings({ kind: 'agent', first: true, ctx: 400_000 }, []), [])
})

test('a heavy first call names the enabled plugins; a turn over the hard limit asks for /compact', () => {
  const w = contextWarnings({ kind: 'main', first: true, ctx: 57_000 }, ['a@m', 'b@m'])
  assert.equal(w.length, 1)
  assert.match(w[0]!, /first call of this session is 57k tokens before any work \(limit 25k\)/)
  assert.match(w[0]!, /enabled plugins: a@m, b@m/)
  const t = contextWarnings({ kind: 'main', ctx: 151_000 }, [])
  assert.equal(t.length, 1)
  assert.match(t[0]!, /context is 151k \(over 150k\): finish this step, then \/compact/)
})

test('enabledPlugins lists the true entries of the user and project settings, project last', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-home-'))
  const repo = makeRepo()
  fs.mkdirSync(path.join(home, '.claude'))
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'x@m': true, 'off@m': false } }))
  write(repo, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'y@m': true } }))
  assert.deepEqual(enabledPlugins(home, repo), ['x@m', 'y@m'])
  assert.deepEqual(enabledPlugins(path.join(home, 'nowhere'), path.join(repo, 'nowhere')), [])
})

test('backgroundSessions counts transcripts by entrypoint, cli left out, in the window', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-home-'))
  const root = '/Users/me/work/my_repo'
  const dir = path.join(home, '.claude', 'projects', projectSlug(root))
  fs.mkdirSync(dir, { recursive: true })
  const line = (entry: string, at: string): string => JSON.stringify({ type: 'user', timestamp: at, entrypoint: entry, sessionId: 's' }) + '\n'
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line('sdk-py', '2026-10-08T10:00:00Z'))
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line('sdk-py', '2026-10-08T11:00:00Z'))
  fs.writeFileSync(path.join(dir, 'c.jsonl'), line('sdk-ts', '2026-10-08T12:00:00Z'))
  fs.writeFileSync(path.join(dir, 'd.jsonl'), line('cli', '2026-10-08T12:00:00Z'))
  fs.writeFileSync(path.join(dir, 'old.jsonl'), line('sdk-py', '2026-01-01T00:00:00Z'))
  fs.writeFileSync(path.join(dir, 'junk.jsonl'), 'not json\n')
  const r = backgroundSessions(root, Date.parse('2026-10-01T00:00:00Z'), home)
  assert.equal(r.total, 3)
  assert.deepEqual(r.by_entrypoint, { 'sdk-py': 2, 'sdk-ts': 1 })
  assert.deepEqual(r.sessions.map(s => s.entrypoint), ['sdk-py', 'sdk-py', 'sdk-ts'])
  assert.equal(backgroundSessions(root, 0, path.join(home, 'none')).total, 0)
})

test('projectSlug matches the directory Claude Code uses', () => {
  assert.equal(projectSlug('/Users/me/Documents/learning_101/harness_v2'), '-Users-me-Documents-learning-101-harness-v2')
})

test('log-usage prints the context warnings for the mod to show and keeps the first flag on the row', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-home-'))
  fs.mkdirSync(path.join(home, '.claude'))
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'heavy@m': true } }))
  const r = sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', first: true, ctx: 60_000, usd: 0.1 })], { env: { HOME: home } })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /first call of this session is 60k/)
  assert.match(r.stdout, /heavy@m/)
  const rows = fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(rows.at(-1).first, true)
  assert.equal(sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', ctx: 20_000, usd: 0.1 })], { env: { HOME: home } }).stdout, '')
})

test('metrics report the heaviest first call and the background sessions found in the project transcripts', () => {
  const repo = makeRepo()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-home-'))
  const env = { HOME: home }
  sdlc(repo, ['new', 'add-login', '--type', 'feature', '--tier', 'S'], { env })
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', first: true, ctx: 57_000, usd: 0.1 })], { env })
  sdlc(repo, ['log-usage', JSON.stringify({ kind: 'main', ctx: 90_000, usd: 0.1 })], { env })
  const dir = path.join(home, '.claude', 'projects', projectSlug(repo))
  fs.mkdirSync(dir, { recursive: true })
  const at = new Date().toISOString()
  fs.writeFileSync(path.join(dir, 'review.jsonl'), JSON.stringify({ type: 'user', timestamp: at, entrypoint: 'sdk-py' }) + '\n')
  fs.writeFileSync(path.join(dir, 'me.jsonl'), JSON.stringify({ type: 'user', timestamp: at, entrypoint: 'cli' }) + '\n')
  const m = JSON.parse(sdlc(repo, ['metrics', '--json'], { env }).stdout).metrics
  assert.equal(m.cost.first_call_context, 57_000)
  assert.equal(m.cost.heavy_session_starts, 1)
  assert.equal(m.background.sessions, 1)
  assert.deepEqual(m.background.by_entrypoint, { 'sdk-py': 1 })
  assert.deepEqual(m.background.per_change, { 'add-login': 1 })
})
