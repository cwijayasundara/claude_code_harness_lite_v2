// Closing the loop: bands config, the deterministic detector, the watch command and status, rig-watch.yml's scripts, loop metrics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write } from './testkit.ts'
import { parseConfig } from './model.ts'
import { evaluate, pointOf } from './watch.ts'

const ROOT = path.join(import.meta.dirname, '..')

test('bands: defaults, and every bad entry is a precise error', () => {
  const ok = parseConfig(JSON.stringify({ bands: [{ id: 'ci-failure-rate', query: 'gh run list --limit 50 --json conclusion', count: 'failure', tiers: { 2: { tools: 'Read,Grep,Bash(gh run view *)' }, 3: { routes: ['pull_request', 'runbook:rollback'] } } }] }))
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.config.bands, [{ id: 'ci-failure-rate', query: 'gh run list --limit 50 --json conclusion', count: 'failure', window: 30, step: 0.5, tools: 'Read,Grep,Bash(gh run view *)', routes: ['pull_request', 'runbook:rollback'] }])
  assert.deepEqual(parseConfig(JSON.stringify({ bands: [{ id: 'p95', query: 'cat p95.txt' }] })).config.bands[0], { id: 'p95', query: 'cat p95.txt', window: 30, step: 0.5, tools: 'Read,Grep,Glob', routes: ['pull_request'] })
  const errs = (bands: unknown): string => parseConfig(JSON.stringify({ bands })).errors.join('\n')
  assert.match(errs({ id: 'x' }), /bands must be a list/)
  assert.match(errs([{ id: 'CI_rate', query: 'x' }]), /bands\[0\]\.id must be a unique kebab-case name/)
  assert.match(errs([{ id: 'a', query: 'x' }, { id: 'a', query: 'y' }]), /bands\[1\]\.id must be a unique/)
  assert.match(errs([{ id: 'a' }]), /bands\[0\]\.query must be a command/)
  assert.match(errs([{ id: 'a', query: 'x', window: 3 }]), /bands\[0\]\.window must be a whole number of at least 5/)
  assert.match(errs([{ id: 'a', query: 'x', step: -1 }]), /bands\[0\]\.step must be a number from 0 to 3/)
  assert.match(errs([{ id: 'a', query: 'x', rules: 'nelson' }]), /bands\[0\]\.rules must be "western_electric"/)
  assert.match(errs([{ id: 'a', query: 'x', colour: 1 }]), /bands\[0\]: unknown key "colour"/)
  assert.match(errs([{ id: 'a', query: 'x', tiers: { 3: { routes: ['deploy'] } } }]), /unknown route "deploy"/)
  for (const tools of ['Read,Edit', 'Bash', 'Read,WebFetch', 'Write(./x)', 'NotebookEdit']) {
    assert.match(errs([{ id: 'a', query: 'x', tiers: { 2: { tools } } }]), /tiers\.2\.tools must be read-only/, tools)
  }
})

// A baseline of 20 points alternating 10 and 12 (mean 11, σ 1), then the eight points under test.
const series = (recent: number[]): number[] => [...Array.from({ length: 20 }, (_, i) => (i % 2 ? 12 : 10)), ...recent]
const steady = Array(8).fill(11) as number[]

test('evaluate: Western Electric rules against the window before the last eight points', () => {
  assert.equal(evaluate([10, 12, 11, 15], 30).tier, 0, 'too little history: learning')
  assert.match(evaluate([10, 12, 11, 15], 30).rule, /learning/)
  assert.deepEqual(evaluate(series(steady), 30), { tier: 0, mean: 11, sd: 1, rule: 'within band' })
  assert.equal(evaluate(series([...steady.slice(1), 15]), 30).tier, 3, 'one point beyond 3σ')
  assert.equal(evaluate(series([...steady.slice(3), 13.5, 11, 13.5].slice(-8)), 30).tier, 2, 'two of three beyond 2σ, none beyond 3σ')
  assert.equal(evaluate(series([...steady.slice(4), 12.5, 12.5, 11, 12.5, 12.5].slice(-8)), 30).tier, 1, 'four of five beyond 1σ')
  const drift = evaluate(series(Array(8).fill(11.5) as number[]), 30)
  assert.deepEqual([drift.tier, drift.rule], [1, 'eight in a row on one side'], 'a slow drift trips a rule with no point beyond 3σ')
  assert.equal(evaluate(series([...steady.slice(1), 7]), 30).tier, 3, 'below the band counts too')
})

test('evaluate: each dismissal widens every threshold by the band step', () => {
  assert.equal(evaluate(series([...steady.slice(1), 14.5]), 30, 0).tier, 3)
  assert.equal(evaluate(series([...steady.slice(1), 14.5]), 30, 1).tier, 0, 'z 3.5 is inside 3+1, and a single point trips no lower rule')
})

test('pointOf: a number, or with count, the share of a JSON list matching it; anything else is no point', () => {
  assert.equal(pointOf(' 4.5\n'), 4.5)
  for (const bad of ['', 'n/a', '4 5', 'NaN']) assert.equal(pointOf(bad), null, bad)
  assert.equal(pointOf(JSON.stringify([{ conclusion: 'failure' }, { conclusion: 'success' }, { conclusion: 'success' }, { conclusion: 'failure' }]), 'failure'), 0.5)
  assert.equal(pointOf('[]', 'failure'), null)
  assert.equal(pointOf('{"a":1}', 'failure'), null)
  assert.equal(pointOf('not json', 'failure'), null)
})

// A repo whose band reads value.txt, with `history` already recorded.
function watched(history: number[], band: Record<string, unknown> = {}): string {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ bands: [{ id: 'p95', query: 'cat value.txt', ...band }] }))
  write(repo, '.sdlc/watch/p95.jsonl', history.map((v, i) => JSON.stringify({ at: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), value: v })).join('\n') + '\n')
  return repo
}
const watchJson = (repo: string) => JSON.parse(sdlc(repo, ['watch', '--json']).stdout)
const history = series(steady).slice(0, -1)

test('watch records the point and prints the tier, the breach id and the tier-2 tools', () => {
  const repo = watched(history, { tiers: { 2: { tools: 'Read,Bash(gh run view *)' }, 3: { routes: ['pull_request', 'runbook:rollback'] } } })
  write(repo, 'value.txt', '15\n')
  const [v] = watchJson(repo)
  assert.equal(v.tier, 3)
  assert.match(v.breach, /^breach-p95-\d{8}$/)
  assert.equal(v.tools, 'Read,Bash(gh run view *)')
  assert.deepEqual(v.routes, ['pull_request', 'runbook:rollback'])
  const rows = fs.readFileSync(path.join(repo, '.sdlc/watch/p95.jsonl'), 'utf8').trim().split('\n')
  assert.deepEqual({ value: JSON.parse(rows.at(-1) ?? '{}').value, tier: JSON.parse(rows.at(-1) ?? '{}').tier }, { value: 15, tier: 3 })
  write(repo, 'value.txt', '11\n')
  assert.equal(watchJson(repo)[0].breach, null, 'below tier 2 there is no breach')
  assert.match(sdlc(repo, ['watch']).stdout, /^p95: tier \d \(11; /m)
})

test('a failed query is tier 0 with no point; two misses in a row warn in status', () => {
  const repo = watched(history, { query: 'exit 3' })
  const before = fs.readFileSync(path.join(repo, '.sdlc/watch/p95.jsonl'), 'utf8')
  const [v] = watchJson(repo)
  assert.deepEqual([v.tier, v.value, v.breach], [0, null, null])
  assert.match(v.rule, /query failed/)
  const rows = fs.readFileSync(path.join(repo, '.sdlc/watch/p95.jsonl'), 'utf8').slice(before.length).trim().split('\n')
  assert.deepEqual(rows.map(r => JSON.parse(r).miss), [true], 'a miss, never a point')
  assert.doesNotMatch(sdlc(repo, ['status']).stdout, /watch: p95/)
  watchJson(repo)
  assert.match(sdlc(repo, ['status']).stdout, /warn: watch: p95 query failed on the last two runs/)
})

test('a person closing a breach intent widens that band only', () => {
  const repo = watched(history)
  write(repo, 'value.txt', '14.5\n')
  assert.equal(watchJson(repo)[0].tier, 3)
  write(repo, '.sdlc/watch/p95.jsonl', history.map(v => JSON.stringify({ at: '2026-09-01T00:00:00Z', value: v })).join('\n') + '\n')
  write(repo, '.sdlc/intent/breach-p95-20260901.md', '---\nstatus: closed\n---\n# noise\n')
  write(repo, '.sdlc/intent/breach-p95-20260902.md', '---\nstatus: closed\n---\n# noise\n')
  write(repo, '.sdlc/intent/breach-other-20260902.md', '---\nstatus: closed\n---\n# another band\n')
  assert.equal(watchJson(repo)[0].tier, 0, 'two dismissals at step 0.5 widen by 1σ: z 3.5 no longer trips')
})

test('watch with no bands says so; the evidence is denied to the Edit tool in both templates', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  assert.match(sdlc(repo, ['watch']).stdout, /no bands in \.sdlc\/sensors\.json/)
  const tpl = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8')).permissions.deny as string[]
  assert.ok(tpl('settings.json').includes('Edit(/.sdlc/watch/*.jsonl)'))
  assert.ok(tpl('managed-settings.json').includes('Edit(./.sdlc/watch/*.jsonl)'))
})
