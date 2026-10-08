// CI/CD templates: rig-triage and rig-rehearse scripts run from their markers with a fake gh; the privilege split is in the text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

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
  const ping = post('Flaky: a timeout; @oncall-team should look\nEvidence: "ETIMEDOUT"\nNext: re-run; cc @alice\n')
  assert.equal(ping.code, 0, ping.out)
  assert.doesNotMatch(ping.comment, /@oncall-team|@alice/)
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
