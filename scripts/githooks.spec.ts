// Git hooks: check --at commit and push, install, the hook scripts, warning carry-over and the model's bypass denials.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'

const SECRET = 'const apikey = "abcdefghijklmnop12345678"\n'
let repo: string
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', '{}')
})
const stage = (rel: string, text: string): void => {
  write(repo, rel, text)
  gitIn(repo, 'add', rel)
}
const commit = () => sdlc(repo, ['check', '--at', 'commit'])

test('check --at commit blocks a staged secret and ignores what is not staged', () => {
  stage('src/a.js', SECRET)
  const bad = commit()
  assert.equal(bad.code, 1)
  assert.match(bad.stdout, /secrets/)
  gitIn(repo, 'reset', '-q')
  assert.equal(commit().code, 0, 'nothing staged: nothing to judge')
  stage('src/b.js', 'export const ok = 1\n')
  write(repo, 'src/c.js', SECRET) // untracked and unstaged: not part of this commit
  assert.equal(commit().code, 0, commit().stdout)
})

test('the index is what counts, not the working copy', () => {
  stage('src/a.js', SECRET)
  write(repo, 'src/a.js', 'export const ok = 1\n') // working copy cleaned after staging
  assert.equal(commit().code, 1, 'the staged secret still blocks')
  gitIn(repo, 'reset', '-q')
  stage('src/a.js', 'export const ok = 1\n')
  write(repo, 'src/a.js', SECRET) // secret only in the working copy
  assert.equal(commit().code, 0)
})

test('staged assertion removal blocks as test-tamper', () => {
  stage('test/a.test.js', "import assert from 'node:assert'\nassert.equal(1, 1)\nassert.equal(2, 2)\n")
  gitIn(repo, 'commit', '-qm', 'tests')
  stage('test/a.test.js', "import assert from 'node:assert'\n")
  const r = commit()
  assert.equal(r.code, 1)
  assert.match(r.stdout, /test-tamper/)
})

test('a failing fast command blocks; a size warning prints but does not block', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "process.exit(1)"' }, limits: { fileLines: 5 } }))
  stage('src/a.js', 'export const a = 1\n')
  const red = commit()
  assert.equal(red.code, 1)
  assert.match(red.stdout, /fast\.test/)
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { fileLines: 5 } }))
  stage('src/big.js', Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n')
  const warn = commit()
  assert.equal(warn.code, 0)
  assert.match(warn.stdout, /size/)
})

test('file names with spaces are judged; a binary file is skipped without a crash', () => {
  stage('src/my file.js', SECRET)
  const r = commit()
  assert.equal(r.code, 1)
  assert.match(r.stdout, /my file\.js/)
  gitIn(repo, 'reset', '-q')
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0, 0, 1, 2, 3]))
  gitIn(repo, 'add', 'logo.png')
  assert.equal(commit().code, 0)
})

test('a repo with no commits yet is judged against nothing, not a crash', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-fresh-'))
  gitIn(fresh, 'init', '-q', '-b', 'main')
  write(fresh, '.sdlc/sensors.json', '{}')
  write(fresh, 'src/a.js', SECRET)
  gitIn(fresh, 'add', 'src/a.js')
  const r = sdlc(fresh, ['check', '--at', 'commit'])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /secrets/)
})

test('a merge or rebase in progress is skipped, and the skip says so', () => {
  stage('src/a.js', SECRET)
  const rebase = sdlc(repo, ['check', '--at', 'commit'], { env: { GIT_REFLOG_ACTION: 'rebase (pick)' } })
  assert.equal(rebase.code, 0)
  assert.match(rebase.stdout, /skipped/)
  fs.writeFileSync(path.join(repo, '.git/MERGE_HEAD'), gitIn(repo, 'rev-parse', 'HEAD') + '\n')
  const merge = commit()
  assert.equal(merge.code, 0)
  assert.match(merge.stdout, /skipped/)
})

test('a stale wiki page warns at commit and does not block', () => {
  write(repo, 'src/a.js', 'export const a = 1\n')
  write(repo, 'docs/wiki/manifest.json', JSON.stringify({ pages: { 'modules/src.md': { globs: ['src/**'] } } }))
  write(repo, 'docs/wiki/modules/src.md', '# src\n\nsee src/a.js:1\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'base')
  stage('src/clean.js', 'export const ok = 1\n')
  const r = commit()
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /wiki-stale/)
})

test('hooks install needs the vendored checker, writes executable scripts and sets core.hooksPath', () => {
  const early = sdlc(repo, ['hooks', 'install'])
  assert.equal(early.code, 1)
  assert.match(early.stderr, /vendor/)
  assert.equal(sdlc(repo, ['vendor']).code, 0)
  for (const n of ['pre-commit', 'pre-push']) assert.ok(fs.statSync(path.join(repo, '.sdlc/githooks', n)).mode & 0o111, `${n} is executable after vendor`)
  const r = sdlc(repo, ['hooks', 'install'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.sdlc/githooks')
  assert.match(sdlc(repo, ['hooks', 'status']).stdout, /installed/)
  assert.equal(sdlc(repo, ['hooks', 'uninstall']).code, 0)
  assert.match(sdlc(repo, ['hooks', 'status']).stdout, /not installed/)
})

test('hooks install leaves another core.hooksPath alone unless --force', () => {
  sdlc(repo, ['vendor'])
  gitIn(repo, 'config', 'core.hooksPath', '.husky')
  const r = sdlc(repo, ['hooks', 'install'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /\.husky/)
  assert.match(r.stderr, /sh \.sdlc\/githooks\/pre-commit/)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.husky')
  assert.equal(sdlc(repo, ['hooks', 'install', '--force']).code, 0)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.sdlc/githooks')
})

test('with hooks installed, git commit refuses a staged secret (also from a subdirectory) and accepts clean code', () => {
  sdlc(repo, ['vendor'])
  sdlc(repo, ['hooks', 'install'])
  stage('src/a.js', SECRET)
  assert.throws(() => gitIn(repo, 'commit', '-qm', 'bad'))
  assert.throws(() => execFileSync('git', ['commit', '-qm', 'bad'], { cwd: path.join(repo, 'src'), stdio: 'ignore' }), 'a subdirectory commit is judged too')
  gitIn(repo, 'reset', '-q')
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'ok')
  assert.equal(gitIn(repo, 'log', '-1', '--format=%s'), 'ok')
})

test('a hook that cannot find node warns and lets the commit through', () => {
  sdlc(repo, ['vendor'])
  sdlc(repo, ['hooks', 'install'])
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-path-'))
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'))
  const r = spawnSync('/bin/sh', [path.join(repo, '.sdlc/githooks/pre-commit')], { cwd: repo, env: { PATH: bin }, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /Node >= 22\.18 not found/)
})

const ZERO = '0'.repeat(40)
const push = (local: string, remote: string, ref = 'refs/heads/main') => sdlc(repo, ['check', '--at', 'push'], { input: `${ref} ${local} ${ref} ${remote}\n` })
const head = () => gitIn(repo, 'rev-parse', 'HEAD')

test('push judges the commits the remote lacks, including a direct push to trunk', () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-'))
  gitIn(remote, 'init', '-q', '--bare', '-b', 'main')
  gitIn(repo, 'remote', 'add', 'origin', remote)
  gitIn(repo, 'push', '-q', 'origin', 'main')
  const remoteSha = head()
  stage('src/a.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad', '--no-verify')
  const r = push(head(), remoteSha)
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /secrets/)
  gitIn(repo, 'reset', '-q', '--hard', remoteSha)
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'ok')
  assert.equal(push(head(), remoteSha).code, 0)
})

test('push skips deletes, tags and a new branch with no base, and says so', () => {
  assert.match(push(ZERO, head()).stdout, /nothing to judge/)
  assert.match(push(head(), ZERO, 'refs/tags/v1').stdout, /nothing to judge/)
  stage('src/a.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad')
  const r = push(head(), ZERO, 'refs/heads/feat')
  assert.equal(r.code, 0)
  assert.match(r.stdout, /no base/)
})

test('a new branch is judged against the merge-base with the default branch', () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-'))
  gitIn(remote, 'init', '-q', '--bare', '-b', 'main')
  gitIn(repo, 'remote', 'add', 'origin', remote)
  gitIn(repo, 'push', '-q', 'origin', 'main')
  gitIn(repo, 'checkout', '-q', '-b', 'feat')
  stage('src/a.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad')
  const r = push(head(), ZERO, 'refs/heads/feat')
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /secrets/)
})

test('an unplanned tier M ad-hoc change is refused at push; prePush off skips; a second push reuses the change', () => {
  const base = head()
  for (const n of ['a', 'b', 'c', 'd']) stage(`src/${n}.js`, `export const ${n} = 1\n`)
  gitIn(repo, 'commit', '-qm', 'four files')
  const r = push(head(), base)
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /adhoc/)
  assert.equal(fs.readdirSync(path.join(repo, '.sdlc/changes')).filter(s => s.startsWith('adhoc-')).length, 1)
  push(head(), base)
  assert.equal(fs.readdirSync(path.join(repo, '.sdlc/changes')).filter(s => s.startsWith('adhoc-')).length, 1, 'reused, not recreated')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ githooks: { prePush: 'off' } }))
  const off = push(head(), base)
  assert.equal(off.code, 0)
  assert.match(off.stdout, /off/)
})

const bash = (command: string) => {
  const r = hook(repo, 'pre-bash', { tool_input: { command } })
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined
}

test('the model may not bypass the git hooks; ordinary commits and pushes are untouched', () => {
  sdlc(repo, ['init'])
  for (const cmd of [
    'git commit --no-verify -m x', 'git commit -nm x', 'git commit -m x --no-verif', 'git push --no-verify origin main',
    'git config core.hooksPath /dev/null', 'git -c core.hooksPath=/x commit -m y',
    'git config "core.hooksPath" /x', 'git -c "core.hooksPath=/x" commit -m y', 'git commit "--no-verify" -m x',
  ]) assert.equal(bash(cmd), 'deny', cmd)
  for (const cmd of ['git commit -m "fix the -n flag"', 'git commit -am x', 'git push origin main', 'git status', 'git commit --amend --no-edit', 'git push -n origin main', 'git commit -m "docs: say --no-verify"']) assert.notEqual(bash(cmd), 'deny', cmd)
})

const LINT = `node -e "for (const f of require('fs').readdirSync('.')) if (f.startsWith('bad')) console.log(f)"`

test('push blocks a quality regression against the base', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { lint: { cmd: LINT, count: 'lines' } } }))
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'config')
  const base = head()
  stage('bad1.js', 'export const x = 1\n')
  gitIn(repo, 'commit', '-qm', 'adds a lint finding')
  const r = push(head(), base)
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /quality\.lint/)
  gitIn(repo, 'reset', '-q', '--hard', base)
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'clean')
  assert.equal(push(head(), base).code, 0)
})

test('an overrun push budget warns and lets the push through', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ full: { slow: 'node -e "setTimeout(()=>{},3000)"' }, githooks: { budgetMs: 500 } }))
  const base = head()
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'x')
  const r = push(head(), base)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /budget|timed out/)
  assert.match(r.stdout, /quality ratchet skipped/)
})

const pushRaw = (localRef: string, local: string, remoteRef: string, remote: string) => sdlc(repo, ['check', '--at', 'push'], { input: `${localRef} ${local} ${remoteRef} ${remote}\n` })

test('push judges by the destination ref, whatever the local side is named', () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-'))
  gitIn(remote, 'init', '-q', '--bare', '-b', 'main')
  gitIn(repo, 'remote', 'add', 'origin', remote)
  gitIn(repo, 'push', '-q', 'origin', 'main')
  const remoteSha = head()
  stage('src/a.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad', '--no-verify')
  const bad = head()
  const viaHead = pushRaw('HEAD', bad, 'refs/heads/main', remoteSha)
  assert.equal(viaHead.code, 1, viaHead.stdout)
  assert.match(viaHead.stdout, /secrets/)
  const viaSha = pushRaw(bad, bad, 'refs/heads/main', remoteSha)
  assert.equal(viaSha.code, 1, viaSha.stdout)
  assert.match(viaSha.stdout, /secrets/)
  assert.match(pushRaw('HEAD', bad, 'refs/tags/v1', ZERO).stdout, /nothing to judge/)
  assert.match(pushRaw('(delete)', ZERO, 'refs/heads/main', remoteSha).stdout, /nothing to judge/)
})

test('a Stop that passes with a warning tells the person, and the next prompt tells the agent once', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { fileLines: 5 } }))
  hook(repo, 'prompt-submit', { session_id: 's' })
  write(repo, 'src/big.js', Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n')
  const stop = hook(repo, 'stop', { session_id: 's' })
  assert.match(JSON.parse(stop.stdout).systemMessage, /1 warning.*size.*big\.js/)
  const next = JSON.parse(hook(repo, 'prompt-submit', { session_id: 's' }).stdout)
  assert.equal(next.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(next.hookSpecificOutput.additionalContext, /big\.js/)
  assert.equal(hook(repo, 'prompt-submit', { session_id: 's' }).stdout, '', 'shown once, not again')
})

test('session-start installs the git hooks when they are committed but not wired, and stays quiet once they are', () => {
  sdlc(repo, ['vendor'])
  sdlc(repo, ['hooks', 'install'])
  gitIn(repo, 'config', '--local', '--unset', 'core.hooksPath')
  const first = JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.match(first, /Git hooks: installed/)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.sdlc/githooks')
  const again = JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.doesNotMatch(again, /Git hooks/)
  gitIn(repo, 'config', '--local', 'core.hooksPath', '.husky')
  assert.match(JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext, /Git hooks: core\.hooksPath is \.husky/)
})
