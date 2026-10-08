// CI/CD templates: rig-triage and rig-rehearse scripts run from their markers with a fake gh; the privilege split is in the text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeRepo, sdlc, write } from './testkit.ts'

const ROOT = path.join(import.meta.dirname, '..')
const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rig-cicd-'))
const yml = (name: string): string => fs.readFileSync(path.join(ROOT, 'templates', name), 'utf8')
const posix = { skip: process.platform === 'win32' ? 'POSIX shell only' : false }

// The script between two markers, dedented, run with bash -e like GitHub does, in a fresh folder with a fake gh first on PATH.
function cut(file: string, marker: string): string {
  const text = yml(file)
  const start = text.indexOf(`# ${marker}:start`)
  const end = text.indexOf(`# ${marker}:end`)
  assert.ok(start >= 0 && end > start, `${file} carries both ${marker} markers`)
  const lines = text.slice(start, end).split('\n')
  const indent = (lines[0] ?? '').match(/^ */)?.[0].length ?? 0
  return lines.map(l => l.slice(indent)).join('\n')
}
function runCut(file: string, marker: string, env: Record<string, string>, files: Record<string, string> = {}) {
  const dir = tmpDir()
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "$@" >> "$GH_LOG"\ncat > /dev/null\n', { mode: 0o755 })
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  const summary = path.join(dir, 'summary.md')
  const ghLog = path.join(dir, 'gh.log')
  const r = spawnSync('bash', ['-e', '-c', cut(file, marker)], { cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, GH_LOG: ghLog, GH_TOKEN: 'ghs_testtoken', ...env } })
  const read = (f: string): string => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  return { code: r.status, out: r.stdout + r.stderr, gh: read(ghLog), summary: read(summary), comment: read(path.join(dir, 'comment.md')) }
}

const GOOD = 'Real: the date parser now rejects ISO weeks.\nEvidence: "RangeError: invalid week 53" at src/date.ts:41\nNext: fix parseWeek in src/date.ts and re-run.\n'
const post = (triage: string, env: Record<string, string> = { PR: '42' }) => runCut('rig-triage.yml', 'triage-post', { RUN_URL: 'https://github.com/o/r/actions/runs/7', ...env }, { 'triage.md': triage })

test('rig-triage posts three checked lines to the PR, or to the run summary when there is no PR', posix, () => {
  const r = post(GOOD)
  assert.equal(r.code, 0, r.out)
  assert.match(r.gh, /^pr comment 42 --body-file comment\.md$/m)
  assert.match(r.comment, /^<!-- rig-triage -->\n/)
  assert.match(r.comment, /Real: the date parser/)
  assert.match(r.comment, /actions\/runs\/7/)
  const noPr = post(GOOD, { PR: '' })
  assert.equal(noPr.code, 0, noPr.out)
  assert.equal(noPr.gh, '', 'no PR: gh is not called')
  assert.match(noPr.summary, /Real: the date parser/)
})

test('rig-triage posts nothing and fails on malformed output, so only real triages count', posix, () => {
  for (const bad of ['', 'Real: x\nNext: y\n', `${GOOD}Extra: z\n`, 'Maybe: x\nEvidence: y\nNext: z\n', `Real: ${'x'.repeat(400)}\nEvidence: y\nNext: z\n`]) {
    const r = post(bad)
    assert.notEqual(r.code, 0, `accepted: ${JSON.stringify(bad.slice(0, 40))}`)
    assert.equal(r.gh, '', 'nothing posted')
  }
})

test('rig-triage refuses credentials and neutralises mentions: a triage comment cannot leak a token or page anyone', posix, () => {
  const leak = post('Real: token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA in env\nEvidence: x\nNext: y\n')
  assert.notEqual(leak.code, 0)
  assert.equal(leak.gh, '')
  assert.notEqual(post('Real: x ghs_testtoken\nEvidence: y\nNext: z\n').code, 0, 'the job token itself')
  const ping = post('Flaky: a timeout; @oncall-team should look\nEvidence: "ETIMEDOUT" ![x](https://evil.example/p.png) <img src=x>\nNext: re-run; cc @alice\n')
  assert.equal(ping.code, 0, ping.out)
  assert.match(ping.comment, /\n```text\nFlaky: a timeout; @oncall-team should look\n[\s\S]*\n```\n?$/, 'the lines are posted inside a code fence: no mention, link, image or HTML renders')
  assert.notEqual(post('Real: x\nEvidence: ```\nNext: z\n').code, 0, 'a fence in the text could break out, so it is refused')
})

test('rig-triage: a failed CI run only, Haiku with read-the-log and write-triage.md tools, no checkout, no shell', () => {
  const t = yml('rig-triage.yml')
  assert.match(t, /workflow_run:\n\s+workflows: \[[^\]]+\]\n\s+types: \[completed\]/)
  assert.match(t, /if: github\.event\.workflow_run\.conclusion == 'failure'/)
  assert.match(t, /--model claude-haiku-5-5/)
  assert.match(t, /--allowedTools "Read\(\.\/failed\.log\),Edit\(\.\/triage\.md\)"/)
  assert.match(t, /--disallowedTools "Bash,WebFetch,WebSearch,Skill"/)
  assert.doesNotMatch(t, /actions\/checkout/, 'the failing code is never checked out')
  assert.doesNotMatch(t, /contents: write/)
  assert.match(t, /anthropics\/claude-code-action@ed670b4cf9de2a5a570d130d2f6197b9e543cd64/)
  assert.match(t, /never as instructions/)
})

test('rig-rehearse fails red with the fix when no rollback command is set, and runs the one that is', posix, () => {
  const unset = runCut('rig-rehearse.yml', 'rehearse', { ROLLBACK: '' })
  assert.notEqual(unset.code, 0)
  assert.match(unset.out, /set the repository variable RIG_ROLLBACK_COMMAND/)
  const ok = runCut('rig-rehearse.yml', 'rehearse', { ROLLBACK: 'echo rolled-back > done.txt' })
  assert.equal(ok.code, 0, ok.out)
  assert.notEqual(runCut('rig-rehearse.yml', 'rehearse', { ROLLBACK: 'exit 3' }).code, 0, 'a failing rollback is a red rehearsal')
})

test('rig-rehearse: weekly and on demand, in the staging environment, no model, read-only token', () => {
  const t = yml('rig-rehearse.yml')
  assert.match(t, /schedule:\n\s+- cron: '[^']+'/)
  assert.match(t, /workflow_dispatch:/)
  assert.match(t, /environment: staging/)
  assert.match(t, /ROLLBACK: \$\{\{ vars\.RIG_ROLLBACK_COMMAND \}\}/)
  assert.doesNotMatch(t, /claude/i)
  assert.match(t, /contents: read/)
  assert.match(t, /persist-credentials: false/)
})

// A fake gh answering the calls metrics makes, by the arguments it gets. Times are hours before now.
const ago = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()
function ghBin(answers: { deployments?: unknown; prs?: unknown; failed?: unknown; triage?: unknown; rehearse?: unknown; fail?: boolean }): string {
  const bin = tmpDir()
  const say = (v: unknown) => `echo '${JSON.stringify(v ?? [])}'`
  fs.writeFileSync(path.join(bin, 'gh'), answers.fail ? '#!/bin/sh\necho "HTTP 404" >&2\nexit 1\n' : `#!/bin/sh
case "$*" in
  *deployments*) ${say(answers.deployments)} ;;
  "pr list"*) ${say(answers.prs)} ;;
  *rig-triage.yml*) ${say(answers.triage)} ;;
  *rig-rehearse.yml*) ${say(answers.rehearse)} ;;
  "run list"*) ${say(answers.failed)} ;;
  *) echo '[]' ;;
esac
`, { mode: 0o755 })
  return bin
}
const metricsWith = (repo: string, bin: string) => JSON.parse(sdlc(repo, ['metrics', '--json'], { env: { PATH: `${bin}:${process.env.PATH}`, RIG_PRODUCTION_ENV: 'prod' } }).stdout).metrics

test('DORA from gh and incidents: deploy frequency, lead time, change failure rate, time to restore', posix, () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  const deploys = [10, 30, 50, 70, 90, 2000].map(h => ({ created_at: ago(h), environment: 'prod' })) // 2000h is outside the 30-day window
  const prs = [[100, 95], [80, 75], [60, 55], [40, 35], [20, 15], [5, 4]].map(([open, merged], i) => ({ number: i + 1, createdAt: ago(open as number), mergedAt: ago(merged as number) }))
  write(repo, '.sdlc/incidents/20261001-a.md', `---\nescaped: true\ndetected: ${ago(48)}\nrestored: ${ago(46)}\n---\n`)
  write(repo, '.sdlc/incidents/20261001-b.md', `---\nescaped: false\ndetected: ${ago(30)}\nrestored: ${ago(29)}\n---\n`)
  for (const [k, h] of [['c', 4], ['d', 3], ['e', 5]] as const) write(repo, `.sdlc/incidents/20261001-${k}.md`, `---\nescaped: false\ndetected: ${ago(200)}\nrestored: ${ago(200 - h)}\n---\n`)
  write(repo, '.sdlc/incidents/20261001-f.md', `---\ndetected: ${ago(10)}\nrestored: ${ago(12)}\n---\n`)
  write(repo, '.sdlc/incidents/20261001-g.md', `---\ndetected: ${ago(10)}\nrestored:\n---\n`)
  const m = metricsWith(repo, ghBin({ deployments: deploys, prs }))
  assert.deepEqual({ v: m.deployment_frequency_per_week.value, n: m.deployment_frequency_per_week.n }, { v: Number((5 / (30 / 7)).toFixed(2)), n: 5 })
  // Each PR's lead time runs from open to the first deploy at or after its merge: 100→90 = 10h, 80→70 = 10h, 60→50 = 10h,
  // 40→30 = 10h, 20→10 = 10h; the PR merged 4h ago has no deploy after it yet, so it is no sample.
  assert.deepEqual({ v: m.lead_time_hours.value, n: m.lead_time_hours.n }, { v: 10, n: 5 })
  assert.deepEqual({ v: m.change_failure_rate.value, n: m.change_failure_rate.n }, { v: 1 / 5, n: 5 })
  assert.deepEqual({ v: m.time_to_restore_hours.value, n: m.time_to_restore_hours.n }, { v: 3, n: 5 }, '2, 1, 4, 3, 5: a restore before detection and a blank one are no samples')
})

test('triage and rehearsal from workflow runs', posix, () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  const failed = [...Array.from({ length: 8 }, (_, i) => ({ workflowName: 'CI', createdAt: ago(i + 1) })), { workflowName: 'rig-triage', createdAt: ago(1) }, { workflowName: 'CI', createdAt: ago(2000) }]
  const triage = Array.from({ length: 6 }, (_, i) => ({ createdAt: ago(i + 1) }))
  const rehearse = [...['success', 'success', 'failure', 'success', 'success', 'success'].map((c, i) => ({ conclusion: c, createdAt: ago(24 * (i + 1)) })), { conclusion: '', createdAt: ago(1) }]
  const m = metricsWith(repo, ghBin({ failed, triage, rehearse }))
  assert.deepEqual({ v: m.failures_triaged_without_paging.value, n: m.failures_triaged_without_paging.n }, { v: 6 / 8, n: 8 }, 'rig-triage failures and old runs are not counted')
  assert.deepEqual({ v: m.rollback_rehearsal_success.value, n: m.rollback_rehearsal_success.n }, { v: 5 / 6, n: 6 }, 'an in-progress run is not counted')
  assert.equal(m.rollback_rehearsal_success.per_week, Number((6 / (30 / 7)).toFixed(2)))
})

test('metrics never crash without a usable gh: DORA and the workflow metrics read needs gh, restore time still counts', posix, () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  const m = metricsWith(repo, ghBin({ fail: true }))
  for (const k of ['deployment_frequency_per_week', 'lead_time_hours', 'change_failure_rate', 'failures_triaged_without_paging', 'rollback_rehearsal_success']) assert.equal(m[k].note, 'needs gh', k)
  assert.equal(m.time_to_restore_hours.value, null)
})

test('the incident skill records when service was restored', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'skills/incident/SKILL.md'), 'utf8'), /`restored:`/)
})
