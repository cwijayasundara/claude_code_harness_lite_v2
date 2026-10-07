// The harness must not tax Claude Code: per-turn and per-edit work stays flat as history grows, and nothing runs twice.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
  sdlc(repo, ['init'])
})

// Every git process a command starts, by subcommand (GIT_TRACE logs each one).
function gitCalls(args: string[]): { out: string; calls: string[] } {
  const trace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rig-trace-')), 'trace')
  const r = sdlc(repo, args, { env: { GIT_TRACE: trace } })
  const calls = fs.existsSync(trace) ? [...fs.readFileSync(trace, 'utf8').matchAll(/trace: (?:built-in|exec): git (\S+)/g)].map(m => m[1] ?? '') : []
  return { out: r.stdout, calls }
}

function shipped(slug: string, commit: boolean): void {
  sdlc(repo, ['new', slug, '--type', 'chore', '--tier', 'S'])
  write(repo, `.sdlc/changes/${slug}/ship.json`, '{}\n')
  if (commit) { gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', `ship ${slug}`) }
}

test('status reads shipped changes with one ls-tree, never a git log per change, however many there are', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) shipped(`old-${n}`, true)
  shipped('live', false)
  const { out, calls } = gitCalls(['status', '--json'])
  assert.equal(calls.filter(c => c === 'log').length, 0, `git log calls: ${calls.join(' ')}`)
  assert.equal(calls.filter(c => c === 'ls-tree').length, 1)
  const changes = JSON.parse(out).changes as { slug: string; next: unknown }[]
  assert.equal(changes.find(c => c.slug === 'old-3')?.next, null, 'a committed ship.json is shipped')
  assert.notEqual(changes.find(c => c.slug === 'live')?.next, null, 'an uncommitted ship.json is not')
})

test('status --band carries only the active change and skips the per-change warnings', () => {
  for (const n of [1, 2, 3]) shipped(`old-${n}`, true)
  sdlc(repo, ['new', 'live', '--type', 'chore', '--tier', 'S'])
  const band = JSON.parse(sdlc(repo, ['status', '--json', '--band']).stdout)
  assert.equal(band.active, 'live')
  assert.deepEqual(band.changes.map((c: { slug: string }) => c.slug), ['live'])
  assert.ok(!('warnings' in band) && !('stale' in band) && 'step' in band && 'sensors' in band && 'flow' in band)
})

test('Stop does not re-run a fast command the recorder ran green on this exact tree, and does once the tree moves', () => {
  const cmd = `node -e "require('fs').appendFileSync('.sdlc/count.txt','x')"`
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: cmd } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/a.js', 'export const a = 1\n')
  sdlc(repo, ['run', '--', cmd])
  const count = (): number => fs.readFileSync(path.join(repo, '.sdlc/count.txt'), 'utf8').length
  assert.equal(count(), 1)
  hook(repo, 'stop', { session_id: 's1' })
  assert.equal(count(), 1, 'the recorded green run covers this tree')
  write(repo, 'src/a.js', 'export const a = 2\n')
  hook(repo, 'stop', { session_id: 's1' })
  assert.equal(count(), 2, 'a changed tree runs the command again')
})
