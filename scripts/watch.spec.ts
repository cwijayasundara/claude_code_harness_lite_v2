// Closing the loop: bands config, the deterministic detector, the watch command and status, rig-watch.yml's scripts, loop metrics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { parseConfig } from './model.ts'
import { evaluate, pointOf } from './watch.ts'

const ROOT = path.join(import.meta.dirname, '..')
const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rig-watch-'))
const posix = { skip: process.platform === 'win32' ? 'POSIX shell only' : false }

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

const yml = fs.readFileSync(path.join(ROOT, 'templates', 'rig-watch.yml'), 'utf8')
// A script cut from between its markers, dedented, run with bash -e in a fresh folder with a fake gh first on PATH.
function runCut(marker: string, files: Record<string, string>, env: Record<string, string> = {}, gh = 'exit 1') {
  const start = yml.indexOf(`# ${marker}:start`)
  const end = yml.indexOf(`# ${marker}:end`)
  assert.ok(start >= 0 && end > start, `rig-watch.yml carries both ${marker} markers`)
  const lines = yml.slice(start, end).split('\n')
  const indent = (lines[0] ?? '').match(/^ */)?.[0].length ?? 0
  const dir = tmpDir()
  const bin = path.join(dir, '.bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${dir}/gh.log"\n${gh}\n`, { mode: 0o755 })
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text) }
  const output = path.join(dir, 'output.txt')
  const r = spawnSync('bash', ['-e', '-c', lines.map(l => l.slice(indent)).join('\n')], { cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'ghs_testtoken', ...env } })
  const outputs = Object.fromEntries((fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '').split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  return { code: r.status, out: r.stdout + r.stderr, outputs, dir }
}
const verdict = (tier: number, extra: Record<string, unknown> = {}) => JSON.stringify([
  { id: 'calm', tier: 1, value: 11, mean: 11, sd: 1, rule: 'within band', breach: null, tools: 'Read', routes: ['pull_request'] },
  { id: 'p95', tier, value: 15, mean: 11, sd: 1, rule: 'one point beyond 3σ', breach: tier >= 2 ? 'breach-p95-20261008' : null, tools: 'Read,Bash(gh run view *)', routes: ['pull_request'], ...extra },
])

test('rig-watch decide: tier 2 or above becomes a breach to diagnose; below that, nothing', posix, () => {
  const quiet = runCut('watch-decide', { 'watch.json': verdict(1) })
  assert.equal(quiet.code, 0, quiet.out)
  assert.deepEqual(quiet.outputs, {})
  const r = runCut('watch-decide', { 'watch.json': verdict(2) })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.outputs, { breach: 'breach-p95-20261008', band: 'p95', tier: '2', tools: 'Read,Bash(gh run view *)', summary: '15 against mean 11 (sd 1): one point beyond 3σ', rollback: 'false' })
})

test('rig-watch decide: a breach already in the inbox or open as a branch is not raised twice; a bad id is refused', posix, () => {
  assert.deepEqual(runCut('watch-decide', { 'watch.json': verdict(3), '.sdlc/intent/breach-p95-20261008.md': 'x' }).outputs, {})
  const branch = runCut('watch-decide', { 'watch.json': verdict(3) }, {}, 'case "$*" in *branches/rig-watch/breach-p95-20261008*) exit 0 ;; *) exit 1 ;; esac')
  assert.deepEqual(branch.outputs, {})
  const bad = runCut('watch-decide', { 'watch.json': verdict(3, { breach: 'breach-../../x-1' }) })
  assert.notEqual(bad.code, 0)
})

test('rig-watch decide: tier 3 rolls back only with the route and a green last rehearsal', posix, () => {
  const rehearsal = (c: string) => `case "$*" in *rig-rehearse*) echo ${c} ;; *) exit 1 ;; esac`
  const routes = { routes: ['pull_request', 'runbook:rollback'] }
  assert.equal(runCut('watch-decide', { 'watch.json': verdict(3, routes) }, {}, rehearsal('success')).outputs.rollback, 'true')
  const red = runCut('watch-decide', { 'watch.json': verdict(3, routes) }, {}, rehearsal('failure'))
  assert.equal(red.outputs.rollback, 'false')
  assert.match(red.out, /last rollback rehearsal did not pass/)
  assert.equal(runCut('watch-decide', { 'watch.json': verdict(3, routes) }, {}, 'exit 1').outputs.rollback, 'false', 'unreadable rehearsal: no rollback')
  assert.equal(runCut('watch-decide', { 'watch.json': verdict(3) }, {}, rehearsal('success')).outputs.rollback, 'false', 'no rollback route')
  assert.equal(runCut('watch-decide', { 'watch.json': verdict(2, routes) }, {}, rehearsal('success')).outputs.rollback, 'false', 'tier 2 never rolls back')
})

const DIAG = '## Problem\np95 rose to 15 ms.\n## Proposed outcome\nBack under 12.\n## Affected users and systems\nCheckout.\n## Constraints\nNone.\n## Open questions\nWhich deploy?\n'
const intentEnv = { BREACH: 'breach-p95-20261008', BAND: 'p95', TIER: '3', SUMMARY: '15 against mean 11 (sd 1): one point beyond 3σ' }

test('rig-watch intent: a checked diagnosis becomes a draft Stage 1 intent; credentials, oversize and bad ids are refused', posix, () => {
  const r = runCut('watch-intent', { 'diagnosis.md': DIAG }, intentEnv)
  assert.equal(r.code, 0, r.out)
  const text = fs.readFileSync(path.join(r.dir, 'intent/breach-p95-20261008.md'), 'utf8')
  assert.match(text, /^---\nstatus: draft\nsource: rig-watch\nband: p95\nband_tier: 3\ndetected: \d{4}-\d\d-\d\dT[\d:]+Z\n---\n# Intent: p95 left its band\n/)
  assert.match(text, /Detector: 15 against mean 11/)
  assert.match(text, /## Open questions\nWhich deploy\?/)
  assert.notEqual(runCut('watch-intent', { 'diagnosis.md': `${DIAG}token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA\n` }, intentEnv).code, 0)
  assert.notEqual(runCut('watch-intent', { 'diagnosis.md': `${DIAG}ghs_testtoken\n` }, intentEnv).code, 0)
  assert.notEqual(runCut('watch-intent', { 'diagnosis.md': 'x'.repeat(8001) }, intentEnv).code, 0)
  assert.notEqual(runCut('watch-intent', { 'diagnosis.md': '' }, intentEnv).code, 0)
  assert.notEqual(runCut('watch-intent', { 'diagnosis.md': DIAG }, { ...intentEnv, BREACH: '../x' }).code, 0)
})

test('rig-watch: hourly, a read-only model job, a model-free publish job, and a rollback behind the production environment', () => {
  assert.match(yml, /schedule:\n\s+- cron: '[^']+'/)
  assert.match(yml, /--model claude-haiku-5-5/)
  assert.match(yml, /node --disable-warning=ExperimentalWarning \.sdlc\/bin\/sdlc\.ts watch --json > watch\.json/)
  assert.match(yml, /actions\/cache@v4[\s\S]*path: \.sdlc\/watch/)
  const watchJob = yml.slice(yml.indexOf('\n  watch:\n'), yml.indexOf('\n  publish:\n'))
  const publishJob = yml.slice(yml.indexOf('\n  publish:\n'), yml.indexOf('\n  rollback:\n'))
  const rollbackJob = yml.slice(yml.indexOf('\n  rollback:\n'))
  assert.match(watchJob, /contents: read/)
  assert.doesNotMatch(watchJob, /contents: write|pull-requests: write/)
  assert.match(watchJob, /persist-credentials: false/)
  assert.match(watchJob, /claude-code-action/)
  assert.doesNotMatch(publishJob, /claude/i, 'the job that pushes runs no model')
  assert.match(publishJob, /contents: write/)
  assert.match(rollbackJob, /environment: production/)
  assert.match(rollbackJob, /if: needs\.watch\.outputs\.rollback == 'true'/)
  assert.match(rollbackJob, /vars\.RIG_ROLLBACK_COMMAND/)
  assert.doesNotMatch(yml, /run: .*\$\{\{/, 'no expression is interpolated into a one-line run script')
})

test('metrics: findings_merged_share and dismissal_rate per band, from breach intents', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  const intent = (f: string, status: string) => write(repo, `.sdlc/intent/${f}`, `---\nstatus: ${status}\n---\n# x\n`)
  intent('breach-p95-20261001.md', 'closed')
  intent('breach-p95-20261002.md', 'closed')
  intent('breach-p95-20261003.md', 'accepted')
  intent('breach-ci-rate-20261001.md', 'accepted')
  intent('breach-ci-rate-20261002.md', 'closed')
  intent('breach-ci-rate-20261003.md', 'draft')
  intent('not-a-breach.md', 'closed')
  sdlc(repo, ['new', 'fix-p95', '--type', 'bugfix', '--tier', 'S', '--source', '.sdlc/intent/breach-p95-20261003.md'])
  write(repo, '.sdlc/changes/fix-p95/ship.json', '{}')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'ship')
  const m = JSON.parse(sdlc(repo, ['metrics', '--json']).stdout).metrics
  assert.deepEqual({ v: m.dismissal_rate.value, n: m.dismissal_rate.n }, { v: 3 / 5, n: 5 })
  assert.deepEqual(m.dismissal_rate.by_band, { p95: Number((2 / 3).toFixed(3)), 'ci-rate': 0.5 })
  assert.deepEqual({ v: m.findings_merged_share.value, n: m.findings_merged_share.n }, { v: 1 / 5, n: 5 })
})

test('dismissals widen a band by at most 2σ in total, so closing breach intents can never silence it', () => {
  const repo = watched(history, { step: 3 })
  for (let d = 1; d <= 5; d++) write(repo, `.sdlc/intent/breach-p95-2026090${d}.md`, '---\nstatus: closed\n---\n# noise\n')
  write(repo, 'value.txt', '16.5\n')
  const [v] = watchJson(repo)
  assert.equal(v.tier, 3, 'z 5.5 is beyond 3 + the 2σ cap')
})

test('rig-watch runs rig\'s own secrets scanner on the diagnosis before the intent is written', () => {
  const step = yml.slice(yml.indexOf('- name: Write the draft intent (no model)'), yml.indexOf('# watch-intent:start'))
  assert.match(step, /node --disable-warning=ExperimentalWarning \.sdlc\/bin\/sdlc\.ts secrets diagnosis\.md > \/dev\/null \|\| \{[^}]*exit 1; \}/)
})
