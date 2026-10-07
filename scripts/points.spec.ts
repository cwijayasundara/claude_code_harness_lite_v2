// Story points: tier defaults, an explicit value kept in evidence, re-tier behaviour, and the velocity and cost metrics.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })
const points = (slug: string): { points: number; source: string } => JSON.parse(sdlc(repo, ['points', slug, '--json']).stdout)
const ratchet = (slug: string) => JSON.parse(fs.readFileSync(path.join(repo, `.sdlc/changes/${slug}/ratchet.json`), 'utf8'))

test('a new change gets the tier default: S 5, M 7, L 11', () => {
  for (const [tier, n] of [['S', 5], ['M', 7], ['L', 11]] as const) {
    sdlc(repo, ['new', `t-${tier.toLowerCase()}`, '--type', 'chore', '--tier', tier])
    assert.deepEqual(points(`t-${tier.toLowerCase()}`), { points: n, source: 'tier' })
  }
})

test('the defaults come from sensors.json points', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ points: { M: 8 } }))
  sdlc(repo, ['new', 'm-one', '--type', 'feature', '--tier', 'M'])
  assert.equal(points('m-one').points, 8)
})

test('new --points records an explicit value in ratchet.json and shows it in intent.md', () => {
  sdlc(repo, ['new', 'big-s', '--type', 'chore', '--tier', 'S', '--points', '13'])
  assert.deepEqual(points('big-s'), { points: 13, source: 'set' })
  assert.equal(ratchet('big-s').points, 13)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/big-s/intent.md'), 'utf8'), /^points: 13$/m)
})

test('points must be a positive integer', () => {
  for (const bad of ['0', '-3', '1.5', 'many']) {
    const r = sdlc(repo, ['new', 'bad-pts', '--type', 'chore', '--tier', 'S', '--points', bad])
    assert.notEqual(r.code, 0, bad)
    assert.match(r.stderr, /points must be a positive integer/, bad)
    assert.ok(!fs.existsSync(path.join(repo, '.sdlc/changes/bad-pts')), 'nothing was created')
  }
  sdlc(repo, ['new', 'ok-pts', '--type', 'chore', '--tier', 'S'])
  assert.notEqual(sdlc(repo, ['points', 'ok-pts', '0']).code, 0)
})

test('points <slug> <N> sets, a re-tier changes only tier-sourced points', () => {
  sdlc(repo, ['new', 'grow', '--type', 'feature', '--tier', 'M'])
  assert.equal(points('grow').points, 7)
  sdlc(repo, ['points', 'grow', '9'])
  assert.deepEqual(points('grow'), { points: 9, source: 'set' })
  sdlc(repo, ['new', 'follow', '--type', 'feature', '--tier', 'M'])
  const f = path.join(repo, '.sdlc/changes/follow/ratchet.json')
  const r = ratchet('follow'); r.tier = 'L'; fs.writeFileSync(f, JSON.stringify(r))
  assert.deepEqual(points('follow'), { points: 11, source: 'tier' }, 'the tier default follows the tier in force')
  sdlc(repo, ['points', 'follow', '4'])
  r.tier = 'S'; fs.writeFileSync(f, JSON.stringify({ ...ratchet('follow'), tier: 'S' }))
  assert.deepEqual(points('follow'), { points: 4, source: 'set' }, 'an explicit value survives a re-tier')
})

test('a model cannot inflate points by editing intent.md', () => {
  sdlc(repo, ['new', 'sneaky', '--type', 'chore', '--tier', 'S'])
  const intent = path.join(repo, '.sdlc/changes/sneaky/intent.md')
  fs.writeFileSync(intent, fs.readFileSync(intent, 'utf8').replace(/^points: .*$/m, 'points: 99\npoints_source: set'))
  assert.deepEqual(points('sneaky'), { points: 5, source: 'tier' })
})

test('status and the scorecard show points', () => {
  sdlc(repo, ['new', 'shown', '--type', 'chore', '--tier', 'S', '--points', '3'])
  assert.match(sdlc(repo, ['status']).stdout, /shown\s+chore\s+S\s+\S+.*3pt/)
  assert.match(sdlc(repo, ['scorecard', 'shown']).stdout, /\| Story points \| 3 \(set\) \|/)
})

test('metrics: points are unmeasured below five shipped changes', () => {
  sdlc(repo, ['new', 'one', '--type', 'chore', '--tier', 'S'])
  const m = JSON.parse(sdlc(repo, ['metrics', '--json']).stdout)
  assert.deepEqual(m.metrics.points, { n: 0, shipped_points: 0, velocity_per_week: null, cost_per_point: null })
})

test('metrics: five shipped changes give velocity and cost per point', () => {
  write(repo, '.sdlc/sensors.json', '{}')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  const usage: string[] = []
  for (let i = 0; i < 5; i++) {
    const slug = `ship-${i}`
    sdlc(repo, ['new', slug, '--type', 'chore', '--tier', 'S'])
    write(repo, `.sdlc/changes/${slug}/ship.json`, JSON.stringify({ at: new Date().toISOString() }))
    usage.push(JSON.stringify({ at: new Date().toISOString(), kind: 'main', change: slug, stage: 'build', usd: 2 }))
    gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', `ship ${slug}`)
  }
  write(repo, '.sdlc/usage.jsonl', usage.join('\n') + '\n')
  const p = JSON.parse(sdlc(repo, ['metrics', '--json', '--days', '28']).stdout).metrics.points
  assert.equal(p.n, 5)
  assert.equal(p.shipped_points, 25)
  assert.equal(p.velocity_per_week, 6.25)
  assert.equal(p.cost_per_point, 0.4)
})
