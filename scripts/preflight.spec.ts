// Preflight: every check runs and reports once; the toolchain is judged against the build's own source of truth; nothing retries.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { parseVersion, satisfies, requirements, hostVersion, realRunner } from './toolchain.ts'
import { resolveCommand, httpsFallback, checkRemote, parseAnswers, runPreflight, sshEnv } from './preflight.ts'

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pf-'))

test('versions parse the way each tool prints them', () => {
  assert.deepEqual(parseVersion('21.0.2'), { major: 21, minor: 0 })
  assert.deepEqual(parseVersion('1.8.0_292', 'java'), { major: 8, minor: 0 })
  assert.deepEqual(parseVersion('>=18'), { major: 18, minor: 0 })
  assert.deepEqual(parseVersion('temurin-17.0.1', 'java'), { major: 17, minor: 0 })
  assert.equal(parseVersion('latest'), null)
  assert.equal(satisfies({ major: 22, minor: 1 }, { major: 20, minor: 5 }, 'node'), true)
  assert.equal(satisfies({ major: 20, minor: 1 }, { major: 20, minor: 5 }, 'node'), true, 'node and java compare majors only')
  assert.equal(satisfies({ major: 1, minor: 21 }, { major: 1, minor: 22 }, 'go'), false, 'go compares minors')
  assert.equal(satisfies({ major: 17, minor: 0 }, { major: 21, minor: 0 }, 'java'), false)
})

test('host versions come from the version the tool names, not the first number it prints', () => {
  const java = hostVersion('java', () => 'Picked up JAVA_TOOL_OPTIONS: -Xmx512m\nopenjdk version "21.0.2" 2024-01-16\n', '.')
  assert.deepEqual(java, { major: 21, minor: 0 })
  assert.deepEqual(hostVersion('go', () => 'go version go1.22.3 darwin/arm64\n', '.'), { major: 1, minor: 22 })
  assert.deepEqual(hostVersion('python', () => 'Python 3.11.4\n', '.'), { major: 3, minor: 11 })
  assert.equal(hostVersion('go', () => null, '.'), null, 'a tool that is not installed has no version')
})

test('host probes run in the project root with GOTOOLCHAIN=local, so go never switches to a go.mod toolchain', () => {
  const bin = tmp()
  const root = tmp()
  fs.writeFileSync(path.join(bin, 'go'), '#!/bin/sh\necho "go version go1.22.0 toolchain=$GOTOOLCHAIN"\npwd\n', { mode: 0o755 })
  const saved = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${saved}`
  try {
    const text = realRunner('go', ['version'], root) ?? ''
    assert.match(text, /toolchain=local/)
    if (process.platform !== 'win32') assert.equal(fs.realpathSync(text.trim().split('\n').at(-1) ?? ''), fs.realpathSync(root))
  } finally { process.env.PATH = saved }
  const cwds: string[] = []
  fs.writeFileSync(path.join(root, 'go.mod'), 'module x\n\ngo 1.22\n')
  runPreflight({ root, run: (_c, _a, cwd) => { cwds.push(cwd); return 'go version go1.22.0' }, reach: () => false, answers: {} })
  assert.deepEqual(cwds, [root], 'the probe gets the project root, not process.cwd()')
})

test('the SSH probe keeps the user\'s own ssh command and only adds BatchMode', () => {
  assert.equal(sshEnv({}, null).GIT_SSH_COMMAND, 'ssh -o BatchMode=yes')
  assert.equal(sshEnv({}, 'ssh -i ~/.ssh/work').GIT_SSH_COMMAND, 'ssh -i ~/.ssh/work -o BatchMode=yes')
  assert.equal(sshEnv({ GIT_SSH_COMMAND: 'ssh -i k' }, 'ssh -i other').GIT_SSH_COMMAND, 'ssh -i k', 'an explicit env command is left alone')
  assert.equal(sshEnv({ GIT_SSH: '/usr/bin/plink' }, null).GIT_SSH_COMMAND, undefined, 'GIT_SSH is not overridden')
})

test('Maven: the java version comes from the effective parent chain, not from another manifest', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'svc'))
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project><properties><java.version>21</java.version></properties></project>')
  fs.writeFileSync(path.join(root, 'svc/pom.xml'), '<project><parent><groupId>g</groupId><relativePath>../pom.xml</relativePath></parent></project>')
  fs.writeFileSync(path.join(root, 'svc/.tool-versions'), 'java 25\n')
  const java = requirements(path.join(root, 'svc')).filter(r => r.tool === 'java')
  assert.equal(java[0]?.required, '21')
  assert.match(java[0]?.source ?? '', /pom\.xml/)
  assert.equal(java[1]?.required, '25', 'the other manifest is kept only to warn about')
})

test('node, go and python sources are read in order', () => {
  const root = tmp()
  fs.writeFileSync(path.join(root, '.nvmrc'), 'v20.11.1\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '>=18' } }))
  fs.writeFileSync(path.join(root, 'go.mod'), 'module x\n\ngo 1.22\n')
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nrequires-python = ">=3.10"\n')
  const reqs = requirements(root)
  assert.deepEqual(reqs.filter(r => r.tool === 'node').map(r => r.required), ['v20.11.1', '>=18'])
  assert.equal(reqs.find(r => r.tool === 'go')?.required, '1.22')
  assert.equal(reqs.find(r => r.tool === 'python')?.required, '>=3.10')
})

test('declared commands resolve against package scripts, Makefile targets, files and PATH', () => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
  fs.writeFileSync(path.join(root, 'Makefile'), 'lint:\n\techo ok\n')
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n')
  assert.equal(resolveCommand('npm test', root), null)
  assert.equal(resolveCommand('npm run test', root), null)
  assert.match(resolveCommand('npm run build', root) ?? '', /no "build" script/)
  assert.equal(resolveCommand('make lint', root), null)
  assert.match(resolveCommand('make deploy', root) ?? '', /no "deploy" target/)
  assert.equal(resolveCommand('./run.sh', root), null)
  assert.match(resolveCommand('./missing.sh', root) ?? '', /not found/)
  assert.equal(resolveCommand('node -e 1', root), null)
  assert.match(resolveCommand('definitely-not-a-tool-xyz --x', root) ?? '', /not on PATH/)
  assert.equal(resolveCommand('CI=1 node -e 1', root), null, 'leading assignments are skipped')
})

test('the remote check retries once over HTTPS for an SSH URL and never more', () => {
  assert.equal(httpsFallback('git@github.com:o/r.git'), 'https://github.com/o/r.git')
  assert.equal(httpsFallback('ssh://git@host.example/o/r'), 'https://host.example/o/r.git')
  assert.equal(httpsFallback('https://github.com/o/r.git'), null)
  assert.equal(httpsFallback('git@github.com:o/r.git;touch x'), null, 'a path outside a plain charset gets no suggested command')
  const calls: string[] = []
  const viaHttps = checkRemote('git@github.com:o/r.git', u => { calls.push(u); return u.startsWith('https:') })
  assert.equal(viaHttps.status, 'pass')
  assert.match(viaHttps.line, /over HTTPS/)
  assert.deepEqual(calls, ['git@github.com:o/r.git', 'https://github.com/o/r.git'])
  const dead: string[] = []
  assert.equal(checkRemote('git@github.com:o/r.git', u => (dead.push(u), false)).status, 'fail')
  assert.equal(dead.length, 2)
  assert.equal(checkRemote(null, () => true).status, 'skip')
})

test('the remote check never prints credentials and never passes an option-like URL to git', () => {
  const r = checkRemote('https://user:s3cret@github.com/o/r.git', () => false)
  assert.doesNotMatch(`${r.line} ${r.fix ?? ''}`, /s3cret/)
  const tried: string[] = []
  const opt = checkRemote('--upload-pack=touch pwned', u => (tried.push(u), true))
  assert.equal(opt.status, 'fail')
  assert.deepEqual(tried, [], 'never handed to git')
})

test('answers must be a small object of the known keys with one-line values', () => {
  assert.deepEqual(parseAnswers(JSON.stringify({ gates: 'design for M and L', valueRate: '$100/h', consumers: [] })), { gates: 'design for M and L', valueRate: '$100/h', consumers: '[]' })
  for (const bad of ['[]', 'null', '"x"', '{', JSON.stringify({ other: 'x' }), JSON.stringify({ gates: 'a\nresult: pass' }), JSON.stringify({ gates: 'x'.repeat(600) }), JSON.stringify({ gates: 'a\u0007' })]) {
    assert.equal(typeof parseAnswers(bad), 'string', bad.slice(0, 40))
  }
  assert.equal(typeof parseAnswers('{"gates":"' + 'x'.repeat(5000) + '"}'), 'string', 'the raw input is capped')
})

let repo: string
beforeEach(() => { repo = makeRepo() })
const report = (): string => fs.readFileSync(path.join(repo, '.sdlc/PREFLIGHT.md'), 'utf8')

test('preflight runs every check even when the first fails, and writes one report', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'npm run nope' }, consumers: [{ name: 'billing', path: '../no-such-clone', repo: 'o/billing' }] }))
  write(repo, 'package.json', JSON.stringify({ scripts: {} }))
  const r = sdlc(repo, ['preflight'])
  assert.equal(r.code, 1)
  const text = report()
  assert.match(text, /^result: fail$/m)
  for (const id of ['stack', 'toolchain', 'commands', 'base', 'remote', 'consumers', 'protection']) assert.match(text, new RegExp(`\\| ${id} \\|`), id)
  assert.match(text, /commands.*no "nope" script/)
  assert.match(text, /consumers.*billing.*git clone https:\/\/github\.com\/o\/billing\.git/)
  assert.match(text, /remote \| skip/, 'no origin remote is a skip, not a failure')
})

test('repo-supplied names cannot break the report table or smuggle a command into a fix', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'evil|x\nresult: pass', path: '../x; rm -rf ~', repo: 'o/r; curl bad' }] }))
  sdlc(repo, ['preflight'])
  const text = report()
  assert.doesNotMatch(text, /^result: pass$/m)
  const row = text.split('\n').find(l => l.startsWith('| consumers |')) ?? ''
  assert.equal(row.split('|').length, 5, row)
  assert.doesNotMatch(text, /git clone/)
})

test('a planted symlink at PREFLIGHT.md is replaced, never followed', () => {
  const outside = path.join(tmp(), 'target.txt')
  fs.writeFileSync(outside, 'keep\n')
  fs.mkdirSync(path.join(repo, '.sdlc'), { recursive: true })
  fs.symlinkSync(outside, path.join(repo, '.sdlc/PREFLIGHT.md'))
  sdlc(repo, ['preflight'])
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n')
  assert.ok(!fs.lstatSync(path.join(repo, '.sdlc/PREFLIGHT.md')).isSymbolicLink())
  assert.match(report(), /^# Preflight$/m)
})

test('bad answers are refused before anything is written', () => {
  const r = sdlc(repo, ['preflight', '--answers', JSON.stringify({ gates: 'x\n## Fix these first' })])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--answers/)
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/PREFLIGHT.md')))
})

test('the protection check wants the evidence deny rules in .claude/settings.json', () => {
  assert.match(sdlc(repo, ['preflight']).stdout, /protection \| fail/)
  sdlc(repo, ['init', '--full'])
  assert.match(sdlc(repo, ['preflight']).stdout, /protection \| pass/)
})

test('pre-v0.6.0 settings (approvals denied, PREFLIGHT.md not) fail protection; both rules pass', () => {
  write(repo, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Edit(/.sdlc/approvals.jsonl)'] } }))
  assert.match(sdlc(repo, ['preflight']).stdout, /protection \| fail/)
  write(repo, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Edit(/.sdlc/approvals.jsonl)', 'Edit(/.sdlc/PREFLIGHT.md)'] } }))
  assert.match(sdlc(repo, ['preflight']).stdout, /protection \| pass/)
})

test('a host older than the build requires fails with the exact fix; a newer host passes', () => {
  const bin = tmp()
  fs.writeFileSync(path.join(bin, 'java'), '#!/bin/sh\necho \'openjdk version "17.0.9" 2023-10-17\' >&2\n', { mode: 0o755 })
  write(repo, 'pom.xml', '<project><properties><java.version>21</java.version></properties></project>')
  const old = sdlc(repo, ['preflight'], { env: { PATH: `${bin}:${process.env.PATH}` } })
  assert.match(old.stdout, /toolchain \| fail \| java 17 is older than the 21 pom\.xml requires/)
  fs.writeFileSync(path.join(bin, 'java'), '#!/bin/sh\necho \'openjdk version "21.0.2" 2024-01-16\' >&2\n', { mode: 0o755 })
  const ok = sdlc(repo, ['preflight'], { env: { PATH: `${bin}:${process.env.PATH}` } })
  assert.match(ok.stdout, /toolchain \| pass/)
})

test('answers are recorded verbatim; unanswered ones become open items', () => {
  sdlc(repo, ['preflight', '--answers', JSON.stringify({ gates: 'design for M and L', valueRate: '$100/h' })])
  const text = report()
  assert.match(text, /## Answers[\s\S]*gates: design for M and L[\s\S]*valueRate: \$100\/h/)
  assert.match(text, /open item: consumers was not answered/)
})

test('a repo with no manifests, a detached HEAD and a dirty tree still gets a complete report', () => {
  gitIn(repo, 'checkout', '-q', '--detach')
  write(repo, 'dirty.txt', 'x\n')
  const r = sdlc(repo, ['preflight'])
  assert.match(report(), /base \| warn/)
  assert.match(report(), /^head: [0-9a-f]{7,}$/m)
  assert.ok(r.code === 0 || r.code === 1)
})

test('status flags a missing or older PREFLIGHT.md for an initialised repo', () => {
  write(repo, '.sdlc/sensors.json', '{}')
  sdlc(repo, ['new', 'any-change', '--type', 'chore', '--tier', 'S']) // status lists stale items once there is a change to report on
  assert.match(sdlc(repo, ['status']).stdout, /stale: .*PREFLIGHT\.md is missing/)
  sdlc(repo, ['preflight'])
  const t = new Date(Date.now() - 600_000); fs.utimesSync(path.join(repo, '.sdlc/PREFLIGHT.md'), t, t)
  write(repo, '.sdlc/sensors.json', '{"limits":{"fileLines":400}}')
  assert.match(sdlc(repo, ['status']).stdout, /PREFLIGHT\.md is older than \.sdlc\/sensors\.json/)
})
