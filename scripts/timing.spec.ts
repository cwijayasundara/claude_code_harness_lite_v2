// Work, span and idle from command and lane intervals: overlaps count once, a long gap is idle, nothing is measured to "now".
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, hook, write } from './testkit.ts'
import { timing } from './timing.ts'

const m = (min: number): number => min * 60_000

test('overlapping intervals count once toward work', () => {
  const t = timing([[0, m(10)], [m(5), m(20)]], [], m(15))
  assert.equal(t.workMs, m(20))
  assert.equal(t.spanMs, m(20))
  assert.equal(t.idleMs, 0)
})

test('a gap longer than the idle threshold is idle, a shorter one is not', () => {
  const t = timing([[0, m(5)], [m(10), m(15)], [m(15 + 180), m(15 + 185)]], [], m(15))
  assert.equal(t.workMs, m(15))
  assert.equal(t.idleMs, m(180), 'the 3 h gap')
  assert.equal(t.spanMs, m(200))
})

test('single events (stamps) extend the span and break up idle time, but are not work', () => {
  const t = timing([[0, m(5)]], [m(60), m(100)], m(15))
  assert.equal(t.workMs, m(5))
  assert.equal(t.spanMs, m(100))
  assert.equal(t.idleMs, m(55) + m(40), 'two gaps over the threshold')
  assert.equal(t.lastAt, m(100))
})

test('no data gives zeros and a null last activity', () => {
  assert.deepEqual(timing([], [], m(15)), { workMs: 0, spanMs: 0, idleMs: 0, lastAt: null })
})

let repo: string
beforeEach(() => { repo = makeRepo(); sdlc(repo, ['new', 'lanes', '--type', 'chore', '--tier', 'S']) })
const events = (): { kind?: string; verdict: string; agent?: string; id?: string; ms?: number }[] =>
  fs.readFileSync(path.join(repo, '.sdlc/changes/lanes/events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))

test('subagent hooks append lane events with a duration measured from the matching start', async () => {
  hook(repo, 'subagent-start', { agent_id: 'a1', agent_type: 'rig:implementer' })
  await new Promise(r => setTimeout(r, 30))
  hook(repo, 'subagent-stop', { agent_id: 'a1', agent_type: 'rig:implementer' })
  const lanes = events().filter(e => e.kind === 'lane')
  assert.deepEqual(lanes.map(e => e.verdict), ['start', 'stop'])
  assert.equal(lanes[1]?.agent, 'rig:implementer')
  assert.ok((lanes[1]?.ms ?? 0) >= 20, `ms ${lanes[1]?.ms}`)
})

test('concurrent lanes are matched by id, a stop with no start records 0 ms, and no change means no event', () => {
  hook(repo, 'subagent-start', { agent_id: 'a', agent_type: 'rig:scout' })
  hook(repo, 'subagent-start', { agent_id: 'b', agent_type: 'rig:scout' })
  hook(repo, 'subagent-stop', { agent_id: 'b', agent_type: 'rig:scout' })
  hook(repo, 'subagent-stop', { agent_id: 'ghost', agent_type: 'rig:scout' })
  const stops = events().filter(e => e.verdict === 'stop')
  assert.equal(stops.find(e => e.id === 'ghost')?.ms, 0)
  const bare = makeRepo()
  assert.equal(hook(bare, 'subagent-start', { agent_id: 'x' }).code, 0)
  assert.ok(!fs.existsSync(path.join(bare, '.sdlc')))
})

test('a malformed payload never fails the hook', () => {
  assert.equal(hook(repo, 'subagent-start', { agent_id: { not: 'a string' }, agent_type: 7 }).code, 0)
  assert.equal(hook(repo, 'subagent-stop', {}).code, 0)
})

test('the scorecard reports work, span and idle for a change', () => {
  const t0 = Date.now() - 4 * 3_600_000
  write(repo, '.sdlc/changes/lanes/runs.jsonl', JSON.stringify({ at: new Date(t0 + m(10)).toISOString(), cmd: 'npm test', exit: 0, ms: m(10), tail: '' }) + '\n'
    + JSON.stringify({ at: new Date(t0 + 3 * 3_600_000).toISOString(), cmd: 'npm test', exit: 0, ms: m(10), tail: '' }) + '\n')
  const s = JSON.parse(sdlc(repo, ['scorecard', 'lanes', '--json']).stdout)
  assert.equal(Math.round(s.workMs / 60_000), 20)
  assert.ok(s.idleMs > 2 * 3_600_000, `idle ${s.idleMs}`)
  assert.ok(s.spanMs >= s.workMs)
  assert.match(sdlc(repo, ['scorecard', 'lanes']).stdout, /\| Time \| work 20m · span [\dhm ]+ · idle [\dhm ]+ \|/)
})
