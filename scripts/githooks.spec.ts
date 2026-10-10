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
  write(repo, '.rig/sensors.json', '{}')
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

test('a failing fast command blocks; a long-line warning prints but does not block', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ fast: { test: 'node -e "process.exit(1)"' }, limits: { lineChars: 10 } }))
  stage('src/a.js', 'export const a = 1\n')
  const red = commit()
  assert.equal(red.code, 1)
  assert.match(red.stdout, /fast\.test/)
  write(repo, '.rig/sensors.json', JSON.stringify({ limits: { lineChars: 10 } }))
  stage('src/big.js', Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n')
  const warn = commit()
  assert.equal(warn.code, 0)
  assert.match(warn.stdout, /size/)
})

test('a staged file that crosses the line limit blocks at commit; one already over the limit does not', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ limits: { fileLines: 10 } }))
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
  stage('src/a.js', lines(8))
  stage('src/over.js', lines(30))
  gitIn(repo, 'commit', '-qm', 'base')
  stage('src/a.js', lines(15))
  const crossed = commit()
  assert.equal(crossed.code, 1, crossed.stdout)
  assert.match(crossed.stdout, /size/)
  assert.match(crossed.stdout, /grew to 15 lines/)
  gitIn(repo, 'reset', '-q')
  gitIn(repo, 'checkout', '--', 'src/a.js')
  stage('src/over.js', lines(32))
  const already = commit()
  assert.equal(already.code, 0, already.stdout)
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
  write(fresh, '.rig/sensors.json', '{}')
  write(fresh, 'src/a.js', SECRET)
  gitIn(fresh, 'add', 'src/a.js')
  const r = sdlc(fresh, ['check', '--at', 'commit'])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /secrets/)
})

test('a merge or rebase is read from git state, not the environment; it skips only the fast commands', () => {
  stage('src/a.js', SECRET)
  const spoof = sdlc(repo, ['check', '--at', 'commit'], { env: { GIT_REFLOG_ACTION: 'rebase (pick)' } })
  assert.equal(spoof.code, 1, 'the env var alone skips nothing')
  assert.match(spoof.stdout, /secrets/)
  fs.writeFileSync(path.join(repo, '.git/MERGE_HEAD'), gitIn(repo, 'rev-parse', 'HEAD') + '\n')
  const merging = commit()
  assert.equal(merging.code, 1, 'the sensors still run during a merge')
  assert.match(merging.stdout, /secrets/)
  gitIn(repo, 'reset', '-q')
  fs.rmSync(path.join(repo, '.git/MERGE_HEAD'), { force: true })
  write(repo, '.rig/sensors.json', JSON.stringify({ fast: { test: 'node -e "process.exit(1)"' } }))
  stage('src/b.js', 'export const b = 1\n')
  assert.equal(commit().code, 1, 'no merge: the failing fast command blocks')
  fs.writeFileSync(path.join(repo, '.git/MERGE_HEAD'), gitIn(repo, 'rev-parse', 'HEAD') + '\n')
  const merge = commit()
  assert.equal(merge.code, 0, merge.stdout)
  assert.match(merge.stdout, /merge\/rebase in progress, fast commands skipped/)
  fs.rmSync(path.join(repo, '.git/MERGE_HEAD'))
  write(repo, '.git/rebase-merge/head-name', 'refs/heads/main\n')
  const rebase = commit()
  assert.equal(rebase.code, 0, rebase.stdout)
  assert.match(rebase.stdout, /fast commands skipped/)
  fs.rmSync(path.join(repo, '.git/rebase-merge'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.git/rebase-apply'))
  assert.equal(commit().code, 1, 'an empty rebase-apply directory (no rebasing marker) is not a rebase')
})

test('hooks install needs the vendored checker, writes executable scripts and sets core.hooksPath', () => {
  const early = sdlc(repo, ['hooks', 'install'])
  assert.equal(early.code, 1)
  assert.match(early.stderr, /vendor/)
  assert.equal(sdlc(repo, ['vendor']).code, 0)
  for (const n of ['pre-commit', 'pre-push']) assert.ok(fs.statSync(path.join(repo, '.rig/githooks', n)).mode & 0o111, `${n} is executable after vendor`)
  const r = sdlc(repo, ['hooks', 'install'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.rig/githooks')
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
  assert.match(r.stderr, /sh \.rig\/githooks\/pre-commit/)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.husky')
  assert.equal(sdlc(repo, ['hooks', 'install', '--force']).code, 0)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.rig/githooks')
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
  const r = spawnSync('/bin/sh', [path.join(repo, '.rig/githooks/pre-commit')], { cwd: repo, env: { PATH: bin }, encoding: 'utf8' })
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
  assert.equal(fs.readdirSync(path.join(repo, '.rig/changes')).filter(s => s.startsWith('adhoc-')).length, 1)
  push(head(), base)
  assert.equal(fs.readdirSync(path.join(repo, '.rig/changes')).filter(s => s.startsWith('adhoc-')).length, 1, 'reused, not recreated')
  write(repo, '.rig/sensors.json', JSON.stringify({ githooks: { prePush: 'off' } }))
  const off = push(head(), base)
  assert.equal(off.code, 0)
  assert.match(off.stdout, /off/)
})

// main gains four source files (already judged there): a tier M ad-hoc change if a push wrongly counts them.
const mainGainsFour = () => {
  gitIn(repo, 'checkout', '-q', 'main')
  for (const n of ['a', 'b', 'c', 'd']) stage(`src/${n}.js`, `export const ${n} = 1\n`)
  gitIn(repo, 'commit', '-qm', 'main work')
}
const featBranch = () => {
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-q', '-b', 'feat')
  stage('src/f.js', 'export const f = 1\n')
  gitIn(repo, 'commit', '-qm', 'f')
  return head()
}

test('push after merging main judges only the branch work, as CI does', () => {
  const remoteSha = featBranch()
  mainGainsFour()
  gitIn(repo, 'checkout', '-q', 'feat')
  gitIn(repo, 'merge', '-q', '--no-edit', 'main')
  const r = push(head(), remoteSha, 'refs/heads/feat')
  assert.equal(r.code, 0, r.stdout)
  assert.doesNotMatch(r.stdout, /adhoc/)
})

test('a rebase and force-push judges only the branch work', () => {
  const remoteSha = featBranch()
  mainGainsFour()
  gitIn(repo, 'checkout', '-q', 'feat')
  gitIn(repo, 'rebase', '-q', 'main')
  const r = push(head(), remoteSha, 'refs/heads/feat')
  assert.equal(r.code, 0, r.stdout)
  assert.doesNotMatch(r.stdout, /adhoc/)
})

test('pushing another branch than HEAD uses that branch\'s merge-base, not HEAD\'s', () => {
  const other = featBranch()
  mainGainsFour()
  gitIn(repo, 'checkout', '-q', '-b', 'third')
  const r = pushRaw('refs/heads/feat', other, 'refs/heads/feat', ZERO)
  assert.equal(r.code, 0, r.stdout)
  assert.doesNotMatch(r.stdout, /adhoc/)
  stage('src/s.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad', '--no-verify')
  const bad = head()
  gitIn(repo, 'checkout', '-q', 'feat')
  const refused = pushRaw('refs/heads/third', bad, 'refs/heads/third', ZERO)
  assert.equal(refused.code, 1, refused.stdout)
  assert.match(refused.stdout, /secrets/)
})

const LINT = `node -e "for (const f of require('fs').readdirSync('.')) if (f.startsWith('bad')) console.log(f)"`

test('push blocks a quality regression against the base', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ quality: { lint: { cmd: LINT, count: 'lines' } } }))
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
  write(repo, '.rig/sensors.json', JSON.stringify({ full: { slow: 'node -e "setTimeout(()=>{},3000)"' }, githooks: { budgetMs: 500 } }))
  const base = head()
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'x')
  const r = push(head(), base)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /^  ! commands: .*(?:budget|timed out).* → /m)
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

test('pushing a change branch after the change finished is judged as that change, not a new ad-hoc one', () => {
  gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-qm', 'cfg')
  const base = head()
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, '.rig/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  for (const n of ['app', 'b', 'c', 'd']) write(repo, `src/${n}.js`, `export const ${n} = 1\n`)
  gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-qm', 'work')
  // Shipped and reviewed: nothing is active any more, as after /rig:pr-review (STATE.md names no change).
  write(repo, '.rig/STATE.md', '---\nchange:\n---\n# State\n\nNo active change. Last shipped: tiny.\n')
  const state = fs.readFileSync(path.join(repo, '.rig/STATE.md'), 'utf8')
  const r = pushRaw('refs/heads/sdlc/tiny', head(), 'refs/heads/sdlc/tiny', base)
  assert.doesNotMatch(r.stdout, /adhoc/, r.stdout)
  assert.deepEqual(fs.readdirSync(path.join(repo, '.rig/changes')), ['tiny'])
  assert.equal(fs.readFileSync(path.join(repo, '.rig/STATE.md'), 'utf8'), state)
})

test('a Stop that passes with a warning tells the person, and the next prompt tells the agent once', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ limits: { lineChars: 10 } }))
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
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.rig/githooks')
  const again = JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.doesNotMatch(again, /Git hooks/)
  gitIn(repo, 'config', '--local', 'core.hooksPath', '.husky')
  const other = JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.match(other, /Git hooks: core\.hooksPath is \.husky/)
  assert.match(other, /ask the person to run `node \.rig\/bin\/sdlc\.ts hooks install --force`/)
})

test('a checker crash inside a git hook warns and allows; stop, ship and ci still fail closed', () => {
  assert.equal(sdlc(repo, ['vendor']).code, 0)
  const bin = path.join(repo, '.rig/bin')
  const boom = (file: string, fn: string) => {
    const text = fs.readFileSync(path.join(bin, file), 'utf8')
    fs.writeFileSync(path.join(bin, file), text.replace(new RegExp(`(export function ${fn}\\([^)]*\\): void \\{)`), "$1\n  throw new Error('boom')"))
  }
  boom('check.ts', 'cmdCheck')
  boom('githooks.ts', 'cmdCheckPush')
  const run = (...at: string[]) => spawnSync('node', ['--disable-warning=ExperimentalWarning', path.join(bin, 'sdlc.ts'), 'check', '--at', ...at], { cwd: repo, input: '', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo, NODE_TEST_CONTEXT: '' } })
  for (const at of ['commit', 'push']) {
    const r = run(at)
    assert.equal(r.status, 0, `${at}: ${r.stderr}`)
    assert.match(r.stderr, /rig: the checker crashed \(boom\); allowing — CI still checks/)
  }
  for (const at of [['stop'], ['ship'], ['ci', '--base', 'HEAD']]) {
    const r = run(...at)
    assert.equal(r.status, 1, `${at[0]}: ${r.stderr}`)
    assert.match(r.stderr, /fails closed/)
  }
})

test('an older vendored checker without githooks.ts is not wired: install and session start say to re-run vendor', () => {
  sdlc(repo, ['vendor'])
  fs.rmSync(path.join(repo, '.rig/bin/githooks.ts'))
  const r = sdlc(repo, ['hooks', 'install'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /re-run `vendor`/)
  const note = JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.match(note, /re-run `vendor`/)
  assert.throws(() => gitIn(repo, 'config', '--local', 'core.hooksPath'))
})

test('warnings at commit print with their fix text, five at most plus a count', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ limits: { lineChars: 10 } }))
  const big = Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n'
  stage('src/big.js', big)
  const one = commit()
  assert.equal(one.code, 0, one.stdout)
  assert.match(one.stdout, /^  ! size src\/big\.js: .+ → .+$/m)
  for (const n of [1, 2, 3, 4, 5, 6]) stage(`src/big${n}.js`, big)
  const many = commit()
  assert.equal(many.stdout.split('\n').filter(l => l.startsWith('  ! ')).length, 5, many.stdout)
  assert.match(many.stdout, /^  \+2 more$/m)
})

const context = () => JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext as string

test('hooks uninstall is an opt-out session start respects; install clears it; the install note names it', () => {
  sdlc(repo, ['vendor'])
  const note = context()
  assert.match(note, /Git hooks: installed .*\(core\.hooksPath = \.rig\/githooks\)\. Opt out with: node \.rig\/bin\/sdlc\.ts hooks uninstall/)
  assert.equal(sdlc(repo, ['hooks', 'uninstall']).code, 0)
  assert.equal(gitIn(repo, 'config', '--local', 'rig.githooks'), 'off')
  assert.doesNotMatch(context(), /Git hooks/)
  assert.throws(() => gitIn(repo, 'config', '--local', 'core.hooksPath'), 'not reinstalled')
  assert.equal(sdlc(repo, ['hooks', 'install']).code, 0)
  assert.throws(() => gitIn(repo, 'config', '--local', 'rig.githooks'), 'install clears the opt-out')
})

test('an opt-out before the hooks were ever wired still holds', () => {
  sdlc(repo, ['vendor'])
  assert.equal(sdlc(repo, ['hooks', 'uninstall']).code, 0)
  assert.doesNotMatch(context(), /Git hooks/)
  assert.throws(() => gitIn(repo, 'config', '--local', 'core.hooksPath'))
})

test('hooks uninstall leaves a foreign core.hooksPath alone', () => {
  sdlc(repo, ['vendor'])
  gitIn(repo, 'config', 'core.hooksPath', '.husky')
  sdlc(repo, ['hooks', 'uninstall'])
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.husky')
})

test('a failed git config set is reported, not claimed as installed', () => {
  sdlc(repo, ['vendor'])
  fs.rmSync(path.join(repo, '.git'), { recursive: true })
  const r = sdlc(repo, ['hooks', 'install'])
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stderr, /could not set core\.hooksPath/)
})

test('hooks state sees any config scope and reads ./ and trailing-slash spellings as installed', () => {
  sdlc(repo, ['vendor'])
  for (const p of ['./.rig/githooks', '.rig/githooks/']) {
    gitIn(repo, 'config', '--local', 'core.hooksPath', p)
    assert.match(sdlc(repo, ['hooks', 'status']).stdout, /^rig git hooks installed/, p)
  }
  gitIn(repo, 'config', '--local', '--unset', 'core.hooksPath')
  const global = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rig-global-')), 'gitconfig')
  fs.writeFileSync(global, '[core]\n\thooksPath = /elsewhere\n')
  const env = { GIT_CONFIG_GLOBAL: global }
  assert.match(sdlc(repo, ['hooks', 'status'], { env }).stdout, /core\.hooksPath is \/elsewhere/)
  assert.equal(sdlc(repo, ['hooks', 'install'], { env }).code, 1, 'a global hooksPath is not silently shadowed')
})

test('install rewrites a hook script only when its content or mode differs', () => {
  sdlc(repo, ['vendor'])
  const file = path.join(repo, '.rig/githooks/pre-commit')
  const before = fs.statSync(file).mtimeMs
  sdlc(repo, ['hooks', 'install'])
  assert.equal(fs.statSync(file).mtimeMs, before)
  fs.chmodSync(file, 0o644)
  sdlc(repo, ['hooks', 'install'])
  assert.ok(fs.statSync(file).mode & 0o111)
})

test('push says when the commands judge the working tree, and names refs it skipped in a mixed push', () => {
  const base = head()
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'a')
  const a = head()
  const clean = push(a, base)
  assert.doesNotMatch(clean.stdout, /working tree/)
  stage('src/b.js', 'export const b = 1\n')
  gitIn(repo, 'commit', '-qm', 'b')
  assert.match(push(a, base).stdout, /the full commands and quality ratchet run against your working tree/, 'pushing a commit that is not HEAD')
  write(repo, 'src/b.js', 'export const b = 2\n')
  assert.match(push(head(), base).stdout, /working tree/, 'a dirty tree')
  const mixed = sdlc(repo, ['check', '--at', 'push'], { input: `refs/tags/v1 ${head()} refs/tags/v1 ${ZERO}\nrefs/heads/main ${head()} refs/heads/main ${base}\n` })
  assert.match(mixed.stdout, /refs\/tags\/v1: skipped \(a delete or tag\)/)
})

const bigFile = Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n'

test('more than five warnings at Stop say how many more, to the person and to the agent', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ limits: { lineChars: 10 } }))
  hook(repo, 'prompt-submit', { session_id: 's' })
  for (const n of [1, 2, 3, 4, 5, 6, 7]) write(repo, `src/big${n}.js`, bigFile)
  const stop = JSON.parse(hook(repo, 'stop', { session_id: 's' }).stdout).systemMessage
  assert.match(stop, /7 warning.*\+2 more/)
  const next = JSON.parse(hook(repo, 'prompt-submit', { session_id: 's' }).stdout).hookSpecificOutput.additionalContext
  assert.match(next, /\+2 more/)
})

test('a real git push runs the installed pre-push hook: clean work goes, a secret committed with --no-verify does not', () => {
  sdlc(repo, ['vendor'])
  sdlc(repo, ['hooks', 'install'])
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'harness')
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-'))
  gitIn(remote, 'init', '-q', '--bare', '-b', 'main')
  gitIn(repo, 'remote', 'add', 'origin', remote)
  gitIn(repo, 'push', '-q', 'origin', 'main')
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'clean')
  gitIn(repo, 'push', '-q', 'origin', 'main')
  assert.equal(gitIn(remote, 'rev-parse', 'main'), head())
  stage('src/b.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad', '--no-verify')
  const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /secrets/)
  assert.notEqual(gitIn(remote, 'rev-parse', 'main'), head())
})

test('a failing full command still blocks at push; only a budget overrun is softened', () => {
  write(repo, '.rig/sensors.json', JSON.stringify({ full: { test: 'node -e "process.exit(3)"' } }))
  const base = head()
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'x')
  const r = push(head(), base)
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /full\.test failed/)
})

test('pre-push skips the full commands and the quality ratchet for a change stamped on exactly this tree', () => {
  const OK = 'node -e "process.exit(0)"'
  const m = path.join(os.tmpdir(), `rig-push-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  const bump = `node -e "require('fs').appendFileSync('${m}','x')"`
  write(repo, '.rig/sensors.json', JSON.stringify({ fast: { test: OK }, full: { mark: bump }, quality: { lint: { cmd: bump, count: 'exit' } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, '.rig/changes/tiny/plan.md', `## Files\n- src/app.js\n## Verification\n- \`${OK}\`\n`)
  write(repo, 'src/app.js', 'x\n')
  assert.equal(sdlc(repo, ['verify', 'tiny']).code, 0)
  assert.equal(sdlc(repo, ['quality', 'tiny']).code, 0)
  const seen = fs.readFileSync(m, 'utf8').length
  gitIn(repo, 'add', 'src/app.js'); gitIn(repo, 'commit', '-qm', 'work')
  const head = gitIn(repo, 'rev-parse', 'HEAD')
  const r = sdlc(repo, ['check', '--at', 'push'], { input: `refs/heads/sdlc/tiny ${head} refs/heads/sdlc/tiny ${base}\n` })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(fs.readFileSync(m, 'utf8').length, seen, 'nothing ran again')
})

test('pre-push does not skip when an untracked file was in the stamped tree, even with status.showUntrackedFiles=no', () => {
  const OK = 'node -e "process.exit(0)"'
  const m = path.join(os.tmpdir(), `rig-push-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  const bump = `node -e "require('fs').appendFileSync('${m}','x')"`
  gitIn(repo, 'config', 'status.showUntrackedFiles', 'no')
  write(repo, '.rig/sensors.json', JSON.stringify({ fast: { test: OK }, full: { mark: bump }, quality: { lint: { cmd: bump, count: 'exit' } } }))
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'cfg')
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  gitIn(repo, 'checkout', '-qb', 'sdlc/tiny')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, '.rig/changes/tiny/plan.md', `## Files\n- src/app.js\n## Verification\n- \`${OK}\`\n`)
  write(repo, 'src/app.js', 'x\n')
  write(repo, 'src/helper.js', 'untracked helper\n')
  assert.equal(sdlc(repo, ['verify', 'tiny']).code, 0)
  assert.equal(sdlc(repo, ['quality', 'tiny']).code, 0)
  const seen = fs.readFileSync(m, 'utf8').length
  gitIn(repo, 'add', 'src/app.js'); gitIn(repo, 'commit', '-qm', 'work')
  const head = gitIn(repo, 'rev-parse', 'HEAD')
  const r = sdlc(repo, ['check', '--at', 'push'], { input: `refs/heads/sdlc/tiny ${head} refs/heads/sdlc/tiny ${base}\n` })
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.ok(fs.readFileSync(m, 'utf8').length > seen, 'the commands ran again')
})
