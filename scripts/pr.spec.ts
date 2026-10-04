// The PR node: ship's gates plus pr.md, push and gh pr create; follow-ups; checks; no remote means local-only.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn, verified, ratcheted } from './testkit.ts'
import { checksVerdict } from './pr.ts'

let repo: string
const ready = (slug: string) => {
  sdlc(repo, ['new', slug, '--type', 'chore', '--tier', 'S'])
  verified(repo, slug)
  write(repo, 'src/app.js', 'x\n')
  write(repo, `.sdlc/changes/${slug}/plan.md`, '## Files\n- src/app.js\n')
  ratcheted(repo, slug)
}
const withRemote = () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-remote-'))
  gitIn(bare, 'init', '-q', '--bare')
  gitIn(repo, 'remote', 'add', 'origin', bare)
  return bare
}
const fakeGh = (script: string) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-gh-'))
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" > "$0.args"\n${script}\n`, { mode: 0o755 })
  return { bin, env: { PATH: `${bin}:${process.env.PATH}` } }
}
const events = (slug: string) => fs.readFileSync(path.join(repo, `.sdlc/changes/${slug}/events.jsonl`), 'utf8')
beforeEach(() => { repo = makeRepo() })

test('with no remote, pr commits locally, writes pr.md as local-only, and keeps the change active', () => {
  ready('tiny')
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'])
  assert.equal(r.code, 0, r.stderr)
  const pr = fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/pr.md'), 'utf8')
  assert.match(pr, /^state: local-only$/m)
  assert.match(pr, /## Scorecard/)
  assert.match(gitIn(repo, 'show', '--name-only', '--format=', 'HEAD'), /\.sdlc\/changes\/tiny\/pr\.md/)
  assert.match(sdlc(repo, ['status']).stdout, /▶ tiny[\s\S]*pr-review/)
})

test('pr.md is committed in the same commit as ship.json, so the change is not read as a v0.1 shipped change', () => {
  ready('tiny')
  assert.equal(sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny']).code, 0)
  const files = gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')
  assert.match(files, /\.sdlc\/changes\/tiny\/ship\.json/)
  assert.match(files, /\.sdlc\/changes\/tiny\/pr\.md/)
  const status = sdlc(repo, ['status']).stdout
  assert.match(status, /▶ tiny\s+chore\s+S\s+pr-review/)
  assert.doesNotMatch(status, /tiny\s+chore\s+S\s+done/)
})

test('with a remote, pr pushes the branch and calls gh pr create with pr.md as the body', () => {
  ready('tiny')
  const bare = withRemote()
  const gh = fakeGh('echo https://github.com/o/r/pull/7')
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  assert.equal(r.code, 0, r.stderr)
  assert.match(fs.readFileSync(path.join(gh.bin, 'gh.args'), 'utf8'), /pr create --title chore: tiny --body-file .*pr\.md/)
  assert.ok(gitIn(bare, 'branch', '--list', 'sdlc/tiny').includes('sdlc/tiny'))
  assert.equal(gitIn(bare, 'branch', '--list', 'main'), '')
  assert.match(events('tiny'), /"kind":"pr","target":"https:\/\/github.com\/o\/r\/pull\/7"/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/pr.md'), 'utf8'), /^state: open$/m)
})

test('a title longer than 200 characters is truncated, and the body comes from the file, never argv', () => {
  ready('tiny')
  withRemote()
  const gh = fakeGh('echo https://github.com/o/r/pull/8')
  const msg = 'chore: ' + 'x'.repeat(300)
  assert.equal(sdlc(repo, ['pr', 'tiny', '--message', `${msg}\nsecret body line`], { env: gh.env }).code, 0)
  const args = fs.readFileSync(path.join(gh.bin, 'gh.args'), 'utf8')
  assert.doesNotMatch(args, /secret body line/)
  assert.ok(args.includes('--title chore: xxx') && !args.includes('x'.repeat(201)) && args.includes('x'.repeat(190)))
})

test('pr refuses to push when HEAD is not sdlc/<slug>', () => {
  ready('tiny')
  const bare = withRemote()
  gitIn(repo, 'checkout', '-q', '-b', 'feature/other')
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /only sdlc\/tiny is pushed/)
  assert.equal(gitIn(bare, 'branch', '--list'), '')
})

test('a failing gh pr create blocks the change', () => {
  ready('tiny')
  withRemote()
  const gh = fakeGh('exit 1')
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /gh pr create failed/)
  assert.match(sdlc(repo, ['next', 'tiny']).stdout, /^blocked/)
})

test('ship is an alias for pr', () => {
  ready('tiny')
  assert.equal(sdlc(repo, ['ship', 'tiny', '--message', 'chore: tiny']).code, 0)
})

test('pr rejects an invalid slug before touching anything', () => {
  const r = sdlc(repo, ['pr', '../etc', '--message', 'x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /invalid change name/)
})

test('a follow-up commits review fixes on the same branch', () => {
  ready('tiny')
  sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'])
  write(repo, 'src/app.js', 'y\n')
  const r = sdlc(repo, ['pr', 'tiny', '--followup', '--message', 'fix: review findings'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(gitIn(repo, 'log', '-1', '--format=%s'), 'fix: review findings')
  assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'sdlc/tiny')
})

test('a follow-up pushes to the same branch when there is a remote', () => {
  ready('tiny')
  const bare = withRemote()
  const gh = fakeGh('echo https://github.com/o/r/pull/9')
  sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  write(repo, 'src/app.js', 'y\n')
  assert.equal(sdlc(repo, ['pr', 'tiny', '--followup', '--message', 'fix: review findings']).code, 0)
  assert.equal(gitIn(bare, 'log', '-1', '--format=%s', 'sdlc/tiny'), 'fix: review findings')
})

test('pr-checks records local-only with no remote', () => {
  ready('tiny')
  const r = sdlc(repo, ['pr-checks', 'tiny'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /local-only/)
  assert.match(events('tiny'), /"verdict":"local-only","kind":"checks"/)
})

test('pr-checks maps gh output to a verdict and fails closed on garbage', () => {
  ready('tiny')
  withRemote()
  const check = (body: string) => sdlc(repo, ['pr-checks', 'tiny'], { env: fakeGh(`echo '${body}'`).env })
  assert.match(check('[{"state":"SUCCESS"},{"state":"SKIPPED"}]').stdout, /checks: pass/)
  assert.match(check('[{"state":"QUEUED"}]').stdout, /checks: pending/)
  assert.match(check('[{"state":"SUCCESS"},{"state":"ACTION_REQUIRED"}]').stdout, /checks: fail/)
  assert.equal(check('[{"state":"FAILURE"}]').code, 2)
  assert.match(check('not json').stdout, /checks: unknown/)
  assert.match(check('{"state":"SUCCESS"}').stdout, /checks: unknown/)
})

test('checksVerdict fails closed', () => {
  assert.equal(checksVerdict([]), 'unknown')
  assert.equal(checksVerdict(null), 'unknown')
  assert.equal(checksVerdict(['SUCCESS', 'ACTION_REQUIRED']), 'fail')
  assert.equal(checksVerdict(['TIMED_OUT']), 'fail')
  assert.equal(checksVerdict(['SUCCESS', 'SKIPPED']), 'pass')
  assert.equal(checksVerdict(['QUEUED']), 'pending')
})

test('with a remote, pr-review is not done until the checks pass', () => {
  ready('tiny')
  withRemote()
  const gh = fakeGh('echo https://github.com/o/r/pull/7')
  sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  write(repo, '.sdlc/changes/tiny/review.md', '---\nresult: pass\n---\n# Review\n')
  assert.match(sdlc(repo, ['next', 'tiny']).stdout, /pr-review|review/)
  sdlc(repo, ['pr-checks', 'tiny'], { env: fakeGh(`echo '[{"state":"SUCCESS"}]'`).env })
  assert.match(sdlc(repo, ['next', 'tiny']).stdout, /^ready/)
})

test('ship commits code plus artifacts on a branch', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, 'src/app.js', 'x\n')
  write(repo, '.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n## Verification\n- npm test\n')
  assert.match(sdlc(repo, ['status']).stdout, /next: \/sdlc:pr tiny/)
  const shipped = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'])
  assert.equal(shipped.code, 0, shipped.stderr)
  assert.match(shipped.stdout, /sdlc\/tiny/)
  const files = gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')
  assert.match(files, /src\/app\.js/)
  assert.match(files, /\.sdlc\/changes\/tiny\/verification\.md/)
  assert.doesNotMatch(files, /usage\.jsonl/)
  assert.match(sdlc(repo, ['status']).stdout, /pr-review/)
})


test('ship refuses scope drift and unfinished changes', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  assert.match(sdlc(repo, ['pr', 'tiny', '--message', 'chore: x']).stderr, /not ready to ship/)
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, '.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  write(repo, 'src/other.js', 'y\n')
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /scope drift/)
})


test('pr stages STATE.md and .sdlc/.gitignore and keeps the change active; STATE.md is cleared at ready', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, 'src/app.js', 'x\n')
  write(repo, '.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n## Verification\n- npm test\n')
  const shipped = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'])
  assert.equal(shipped.code, 0, shipped.stderr)
  const files = gitIn(repo, 'show', '--name-only', '--format=', 'HEAD')
  assert.match(files, /\.sdlc\/STATE\.md/)
  assert.match(files, /\.sdlc\/\.gitignore/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/STATE.md'), 'utf8'), /^change: tiny$/m) // the change stays active for pr-review
  assert.equal(gitIn(repo, 'status', '--porcelain').trim(), '')
  assert.match(sdlc(repo, ['status']).stdout, /▶ tiny[\s\S]*next: \/sdlc:pr-review/)
  write(repo, '.sdlc/changes/tiny/review.md', '---\nresult: pass\n---\n# Review\n')
  assert.doesNotMatch(sdlc(repo, ['status']).stdout, /next: /) // ready: STATE.md is cleared now
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/STATE.md'), 'utf8'), /No active change\. Last shipped: tiny\./)
})


test('a change started on another change\'s branch is warned, refused at ship, and diff --trunk lists the branch', () => {
  sdlc(repo, ['new', 'first', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'first')
  ratcheted(repo, 'first')
  write(repo, 'src/a.js', 'x\n')
  write(repo, '.sdlc/changes/first/plan.md', '## Files\n- src/a.js\n')
  assert.equal(sdlc(repo, ['pr', 'first', '--message', 'chore: first']).code, 0)
  const started = sdlc(repo, ['new', 'second', '--type', 'chore', '--tier', 'S'])
  assert.match(started.stdout, /warning: HEAD is on sdlc\/first[\s\S]*git checkout -b sdlc\/second/)
  assert.match(sdlc(repo, ['diff', '--trunk']).stdout, /A src\/a\.js/)
  verified(repo, 'second')
  ratcheted(repo, 'second')
  write(repo, 'src/b.js', 'y\n')
  write(repo, '.sdlc/changes/second/plan.md', '## Files\n- src/b.js\n')
  const refused = sdlc(repo, ['pr', 'second', '--message', 'chore: second'])
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /not shipping: HEAD is on sdlc\/first/)
})


test('activeSlug never falls back to a finished change', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, 'src/app.js', 'x\n')
  write(repo, '.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'])
  write(repo, '.sdlc/changes/tiny/review.md', '---\nresult: pass\n---\n# Review\n')
  fs.rmSync(path.join(repo, '.sdlc/STATE.md'))
  assert.doesNotMatch(sdlc(repo, ['status']).stdout, /▶ tiny/)
})


test('I3: ship ratchets a known-red full command that now passes and commits the tightened sensors.json', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ full: { t: 'node -e "process.exit(0)"' }, knownRed: ['full.t'] }, null, 2) + '\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'cfg')
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  verified(repo, 'tiny')
  ratcheted(repo, 'tiny')
  write(repo, 'src/app.js', 'x\n')
  write(repo, '.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  const shipped = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'])
  assert.equal(shipped.code, 0, shipped.stderr)
  const committed = gitIn(repo, 'show', 'HEAD:.sdlc/sensors.json')
  assert.deepEqual(JSON.parse(committed).knownRed, [])
  assert.equal(gitIn(repo, 'status', '--porcelain').trim(), '')
})


test('pr-checks with no checks: no-ci without workflows, pending with them; both feed pr-review', () => {
  ready('tiny')
  withRemote()
  const gh = fakeGh('echo https://github.com/o/r/pull/7')
  sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  write(repo, '.sdlc/changes/tiny/review.md', '---\nresult: pass\n---\n# Review\n')
  const empty = fakeGh(`echo '[]'`).env
  assert.match(sdlc(repo, ['pr-checks', 'tiny'], { env: empty }).stdout, /checks: no-ci/)
  assert.match(sdlc(repo, ['next', 'tiny']).stdout, /^ready/)
  write(repo, '.github/workflows/ci.yml', 'name: ci\n')
  assert.match(sdlc(repo, ['pr-checks', 'tiny'], { env: empty }).stdout, /checks: pending/)
  assert.doesNotMatch(sdlc(repo, ['next', 'tiny']).stdout, /^ready/)
})

test('a failed gh pr create leaves the pr node not done; a second pr run resumes without a second commit', () => {
  ready('tiny')
  const bare = withRemote()
  const gh = fakeGh('[ -f "$0.ok" ] || exit 1\necho https://github.com/o/r/pull/11')
  const first = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  assert.notEqual(first.code, 0)
  assert.match(first.stderr, /gh pr create/)
  const next = JSON.parse(sdlc(repo, ['next', 'tiny', '--json']).stdout)
  assert.equal(next.verdict, 'blocked')
  assert.match(next.reason, /gh pr create/)
  assert.equal(next.node, 'pr')
  assert.doesNotMatch(events('tiny'), /"kind":"pr"/)
  const head = gitIn(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(gh.bin, 'gh.ok'), '')
  const second = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  assert.equal(second.code, 0, second.stderr)
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), head)
  assert.match(events('tiny'), /"kind":"pr","target":"https:\/\/github.com\/o\/r\/pull\/11"/)
  assert.ok(gitIn(bare, 'branch', '--list', 'sdlc/tiny').includes('sdlc/tiny'))
  assert.equal(JSON.parse(sdlc(repo, ['next', 'tiny', '--json']).stdout).node, 'pr-review')
})

test('gh printing no url records no pr event', () => {
  ready('tiny')
  withRemote()
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: fakeGh('echo created').env })
  assert.notEqual(r.code, 0)
  assert.doesNotMatch(events('tiny'), /"kind":"pr"/)
})

test('a follow-up is refused until the pr node is done', () => {
  ready('tiny')
  withRemote()
  sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: fakeGh('exit 1').env })
  write(repo, 'src/app.js', 'y\n')
  const r = sdlc(repo, ['pr', 'tiny', '--followup', '--message', 'fix: x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /pr node of tiny is not done/)
})

test('a local-only change that later gets an origin resumes: pr pushes, opens the PR and moves to pr-review', () => {
  ready('tiny')
  assert.equal(sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny']).code, 0)
  assert.equal(JSON.parse(sdlc(repo, ['next', 'tiny', '--json']).stdout).node, 'pr-review')
  const bare = withRemote()
  assert.equal(JSON.parse(sdlc(repo, ['next', 'tiny', '--json']).stdout).node, 'pr')
  const head = gitIn(repo, 'rev-parse', 'HEAD')
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: fakeGh('echo https://github.com/o/r/pull/12').env })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), head)
  assert.ok(gitIn(bare, 'branch', '--list', 'sdlc/tiny').includes('sdlc/tiny'))
  assert.match(events('tiny'), /"kind":"pr","target":"https:\/\/github.com\/o\/r\/pull\/12"/)
  assert.equal(JSON.parse(sdlc(repo, ['next', 'tiny', '--json']).stdout).node, 'pr-review')
})

test('gh saying the PR already exists records the existing url instead of blocking', () => {
  ready('tiny')
  withRemote()
  const gh = fakeGh(`case "$1 $2" in "pr create") echo 'a pull request for branch already exists' >&2; exit 1;; "pr view") echo https://github.com/o/r/pull/5;; esac`)
  const r = sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny'], { env: gh.env })
  assert.equal(r.code, 0, r.stderr)
  assert.match(events('tiny'), /"kind":"pr","target":"https:\/\/github.com\/o\/r\/pull\/5"/)
  assert.equal(JSON.parse(sdlc(repo, ['next', 'tiny', '--json']).stdout).node, 'pr-review')
})
