// Manual evals: a prompt plus deterministic checks, run with claude -p in a throwaway worktree. A stub stands in for claude.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { isProtected } from './sensors.ts'
import { parseEval, skillsLoaded, summarize, type EvalResult } from './evals.ts'

const STUB = `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), gh: process.env.GH_TOKEN }) + '\\n')
if (process.env.STUB_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLEEP))
if (process.env.STUB_WRITE) fs.writeFileSync(process.env.STUB_WRITE, 'done by stub\\n')
if (process.env.STUB_SKILL) console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: process.env.STUB_SKILL } }] } }))
console.log(JSON.stringify({ type: 'result', is_error: false }))
process.exit(Number(process.env.STUB_EXIT || 0))
`
let repo: string
let stub: string
let log: string
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', '{}\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'sdlc')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-stub-'))
  stub = path.join(dir, 'claude')
  fs.writeFileSync(stub, STUB, { mode: 0o755 })
  log = path.join(dir, 'log.jsonl')
})
const evals = (args: string[], env: Record<string, string> = {}) => sdlc(repo, ['evals', ...args], { env: { RIG_CLAUDE: stub, STUB_LOG: log, ...env } })
const defineEval = (id: string, body: object) => write(repo, `.sdlc/evals/${id}.json`, JSON.stringify(body))
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { cwd: string; args: string[]; gh?: string })
const results = () => fs.readFileSync(path.join(repo, '.sdlc/evals/results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as EvalResult)

test('parseEval accepts a full definition and rejects what it cannot trust', () => {
  const e = parseEval(JSON.stringify({ prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }, { kind: 'skill-loaded', name: 'build' }], base: 'abc', files: ['t.js'], source: 'change:x' }), 'one')
  assert.deepEqual(e, { id: 'one', prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }, { kind: 'skill-loaded', name: 'build' }], base: 'abc', files: ['t.js'], source: 'change:x' })
  assert.match(parseEval('{', 'x') as string, /not valid JSON/)
  assert.match(parseEval(JSON.stringify({ prompt: 'p', checks: [] }), 'x') as string, /at least one check/)
  assert.match(parseEval(JSON.stringify({ prompt: 'p', checks: [{ kind: 'vibes' }] }), 'x') as string, /unknown or incomplete check/)
})

test('skillsLoaded reads Skill tool calls from stream-json and ignores everything else', () => {
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Skill', input: { skill: 'rig-build' } }] } }),
    'not json',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('\n')
  assert.deepEqual(skillsLoaded(stream), ['rig-build'])
})

test('summarize: pass at minPass, fail below it, unmeasured past maxErrors', () => {
  const row = (pass: boolean, error?: string): EvalResult => ({ at: 't', run: 'r', id: 'x', pass, ...(error ? { error } : {}), checks: [], ms: 0 })
  const cfg = { minPass: 0.5, maxErrors: 1 }
  assert.equal(summarize([row(true), row(false)], cfg)?.verdict, 'pass')
  assert.equal(summarize([row(true), row(false), row(false)], cfg)?.verdict, 'fail')
  assert.equal(summarize([row(true), row(false, 'e'), row(false, 'e')], cfg)?.verdict, 'unmeasured')
  assert.equal(summarize([], cfg), null)
})

test('a passing eval runs claude in a throwaway worktree with stream-json and records the result', () => {
  defineEval('writes', { prompt: 'write out.txt', checks: [{ kind: 'file-contains', path: 'out.txt', text: 'done by stub' }, { kind: 'skill-loaded', name: 'build' }] })
  const r = evals([], { STUB_WRITE: 'out.txt', STUB_SKILL: 'rig-build' })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /^pass writes$/m)
  assert.match(r.stdout, /evals: 1\/1 pass \(1\.00\), 0 error\(s\), minPass 0\.9 → pass/)
  const [call] = calls()
  assert.match(path.basename(call?.cwd ?? ''), /^rig-eval-/, 'claude ran in a throwaway worktree, not the repo')
  assert.deepEqual(call?.args.slice(0, 7), ['-p', 'write out.txt', '--output-format', 'stream-json', '--verbose', '--max-turns', '30'])
  assert.equal(fs.existsSync(path.join(repo, 'out.txt')), false, 'the repo itself is untouched')
  assert.equal(results()[0]?.pass, true)
})

test('a failing check fails the eval and the run exits 1 with the check that failed', () => {
  defineEval('nothing', { prompt: 'p', checks: [{ kind: 'command', cmd: 'test -f missing.txt' }] })
  const r = evals([])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^FAIL nothing: test -f missing\.txt → exit 1$/m)
  assert.match(r.stdout, /→ fail$/m)
})

test('a file check outside the worktree fails and reads nothing', () => {
  defineEval('escape', { prompt: 'p', checks: [{ kind: 'file-contains', path: '../../etc/passwd', text: 'root' }, { kind: 'file-absent', path: '/etc/hosts' }] })
  const r = evals([])
  assert.match(r.stdout, /\.\.\/\.\.\/etc\/passwd is outside the repository/)
  assert.match(r.stdout, /\/etc\/hosts is outside the repository/)
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^FAIL escape: /m)
})

test('a missing claude is an error; past maxErrors the run is unmeasured, never pass', () => {
  for (const id of ['a', 'b', 'c']) defineEval(id, { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  const r = evals([], { RIG_CLAUDE: path.join(os.tmpdir(), 'no-such-claude') })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /FAIL a: .*not found/)
  assert.match(r.stdout, /3 error\(s\), minPass 0\.9 → unmeasured/)
})

test('a malformed definition is reported and the others still run', () => {
  write(repo, '.sdlc/evals/broken.json', '{')
  defineEval('fine', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  const r = evals([])
  assert.match(r.stdout, /^FAIL broken: broken: not valid JSON$/m)
  assert.match(r.stdout, /^pass fine$/m)
})

test('uncommitted configuration is not evaluated, and the run says so', () => {
  defineEval('fine', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  write(repo, 'CLAUDE.md', '# edited, not committed\n')
  assert.match(evals([]).stdout, /^warn: uncommitted changes to CLAUDE\.md.*commit first$/m)
})

test('code comes from the eval base; configuration and the eval files come from HEAD', () => {
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  write(repo, 'tests/t.test.js', 'test\n')
  write(repo, 'CLAUDE.md', 'newrule\n')
  write(repo, 'src/later.js', 'later\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'later')
  defineEval('overlay', { prompt: 'p', base, files: ['tests/t.test.js'], checks: [{ kind: 'command', cmd: 'test -f tests/t.test.js && grep -q newrule CLAUDE.md && test ! -f src/later.js' }] })
  const r = evals([])
  assert.match(r.stdout, /^pass overlay$/m, r.stdout)
})

test('--only runs one eval; an unknown id fails with its name', () => {
  defineEval('a', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  defineEval('b', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  assert.match(evals(['--only', 'b']).stdout, /evals: 1\/1 pass/)
  assert.match(evals(['--only', 'zz']).stderr, /no eval zz in \.sdlc\/evals/)
})

test('configuration deleted at HEAD does not survive from the eval base', () => {
  write(repo, '.claude/skills/x/SKILL.md', 'skill\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'skill')
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  gitIn(repo, 'rm', '-q', '.claude/skills/x/SKILL.md')
  gitIn(repo, 'commit', '-qm', 'drop skill')
  defineEval('gone', { prompt: 'p', base, checks: [{ kind: 'file-absent', path: '.claude/skills/x/SKILL.md' }] })
  assert.match(evals([]).stdout, /^pass gone$/m)
})

test('a timeout and a non-zero exit are errors, never a pass', () => {
  write(repo, '.sdlc/sensors.json', '{"evals":{"timeoutMs":300}}\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'timeout')
  defineEval('slow', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  const a = evals([], { STUB_SLEEP: '3000' })
  assert.equal(a.code, 1)
  assert.match(a.stdout, /timed out after 300 ms/)
  const b = evals([], { STUB_EXIT: '3' })
  assert.equal(b.code, 1)
  assert.match(b.stdout, /exited 3/)
})

test('eval definitions are protected harness files; results stay sdlc-written; the template asks before editing them', () => {
  assert.equal(isProtected('.sdlc/evals/x.json'), true)
  assert.equal(isProtected('.sdlc/evals/results.jsonl'), false)
  const t = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../templates/settings.json'), 'utf8'))
  assert.ok(t.permissions.ask.includes('Edit(/.sdlc/evals/*.json)'))
})

test('claude does not get the GitHub tokens', () => {
  defineEval('tok', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  evals([], { GH_TOKEN: 'secret-x', GITHUB_TOKEN: 'secret-y' })
  assert.equal(calls()[0]?.gh, undefined)
})

test('an eval file missing at HEAD is an error naming it', () => {
  defineEval('nofile', { prompt: 'p', files: ['tests/nope.js'], checks: [{ kind: 'command', cmd: 'true' }] })
  const r = evals([])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^FAIL nofile: files not in HEAD: tests\/nope\.js; commit them first$/m)
})
