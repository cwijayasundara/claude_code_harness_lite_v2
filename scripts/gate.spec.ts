// Hook behaviour: skill fallback, baselines, the Stop gate, and guides.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
})

test('a failed sdlc skill load injects the deterministic fallback command and logs the event', () => {
  sdlc(repo, ['init'])
  const r = hook(repo, 'skill-failed', { tool_input: { skill: 'rig:pr-review', args: 'add-login' } })
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /sdlc\.ts" skill pr-review add-login/)
  assert.match(ctx, /skill fallback: rig:pr-review/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8'), /skill-load-failed/)
  assert.equal(hook(repo, 'skill-failed', { tool_input: { skill: 'superpowers:brainstorming' } }).stdout, '')
})

const stop = () => hook(repo, 'stop', { session_id: 's1' })
const tamper = () => write(repo, 'test/a.test.js', "it.only('x', () => {})\n")

test('Stop is silent outside sdlc repos and on turns that changed no source', () => {
  write(repo, 'src/x.js', 'x\n')
  assert.equal(stop().stdout, '')
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'1\')"' } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/STATE.md', '---\nchange:\n---\nnotes\n')
  assert.equal(stop().stdout, '')
  assert.ok(!fs.existsSync(path.join(repo, 'ran.txt')), 'no commands run on a no-op turn')
})

test('Stop blocks twice, then lets the turn end with a system message and unresolved.json; a fix clears it', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  tamper()
  for (const n of [1, 2]) {
    const out = JSON.parse(stop().stdout)
    assert.equal(out.decision, 'block')
    assert.match(out.reason, new RegExp(`attempt ${n}/2[\\s\\S]*test-tamper[\\s\\S]*test/a\\.test\\.js:1`))
  }
  const third = JSON.parse(stop().stdout)
  assert.match(third.systemMessage, /1 problem\(s\) unresolved after 2 attempts/)
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/unresolved.json')))
  write(repo, 'test/a.test.js', "it('x', () => {})\n")
  assert.equal(stop().stdout, '')
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/unresolved.json')))
})

test('a vibe-coded turn with no active change records an ad-hoc change with a computed tier', () => {
  sdlc(repo, ['init'])
  hook(repo, 'prompt-submit', {})
  for (const f of ['a', 'b', 'c', 'd', 'e']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  stop()
  const status = sdlc(repo, ['status']).stdout
  assert.match(status, /▶ adhoc-\d{8}-\d{4}\s+chore\s+M/)
})

test('a turn that shipped (committed a ship.json) records no ad-hoc change; a plain commit still does', () => {
  sdlc(repo, ['init'])
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'init sdlc')
  hook(repo, 'prompt-submit', {})
  for (const f of ['a', 'b', 'c', 'd', 'e']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  write(repo, '.sdlc/changes/done-thing/ship.json', '{}\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'shipped')
  stop()
  assert.doesNotMatch(sdlc(repo, ['status']).stdout, /adhoc-/)
  hook(repo, 'prompt-submit', {})
  for (const f of ['f', 'g', 'h', 'i', 'j']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'committed to dodge the record')
  stop()
  assert.match(sdlc(repo, ['status']).stdout, /adhoc-/)
})

test('a harness file changed by Bash blocks at Stop; the same change through Edit only warns', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 900 } }))
  assert.match(JSON.parse(stop().stdout).reason, /outside Write\/Edit/)
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 950 } }))
  hook(repo, 'post-edit', { tool_input: { file_path: path.join(repo, '.sdlc/sensors.json') } })
  const warned = JSON.parse(stop().stdout) as { decision?: string; systemMessage?: string }
  assert.equal(warned.decision, undefined, 'a warning does not block')
  assert.match(warned.systemMessage ?? '', /1 warning.*harness-tamper/)
})

test('post-edit blocks a single edited file with exit 2 and records the edit', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  tamper()
  const r = hook(repo, 'post-edit', { tool_input: { file_path: path.join(repo, 'test/a.test.js') } })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /test skipped or focused/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/.gate'), 'utf8')).tool, ['test/a.test.js'])
})

test('a corrupt gate file never wedges the session', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  fs.writeFileSync(path.join(repo, '.sdlc/.gate'), '{not json')
  tamper()
  assert.equal(JSON.parse(stop().stdout).decision, 'block')
})

test('a protected-only diff creates no ad-hoc change; contract edits are tier M', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 900 } }))
  stop()
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/changes')) || fs.readdirSync(path.join(repo, '.sdlc/changes')).length === 0)
})

test('a gate file with wrongly typed fields never crashes the hooks', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  fs.writeFileSync(path.join(repo, '.sdlc/.gate'), '{"blocks":null,"agents":null}')
  tamper()
  assert.equal(JSON.parse(stop().stdout).decision, 'block')
})

const contextOf = (r: { stdout: string }) => (r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput?.additionalContext as string | undefined) : undefined)
const edit = (rel: string, session = 's1') => {
  write(repo, rel, 'export const x = 1\n')
  return hook(repo, 'post-edit', { session_id: session, tool_input: { file_path: path.join(repo, rel) } })
}

test('init copies the default guides into .sdlc/guides', () => {
  sdlc(repo, ['init'])
  assert.deepEqual(fs.readdirSync(path.join(repo, '.sdlc/guides')).sort(), ['contracts.md', 'engineering.md', 'testing.md'])
})

test('a guide is injected the first time a matching file is edited in a session, and again after compaction', () => {
  sdlc(repo, ['init'])
  assert.match(contextOf(edit('src/order.ts')) ?? '', /# Engineering rules/)
  assert.equal(contextOf(edit('src/other.ts')), undefined)
  assert.match(contextOf(edit('test/order.test.ts')) ?? '', /# Testing rules/)
  assert.match(contextOf(edit('schema/billing.sql')) ?? '', /# Contract rules/)
  assert.match(contextOf(edit('src/order.ts', 's2')) ?? '', /# Engineering rules/, 'a new session gets the guides again')
  hook(repo, 'session-start', { session_id: 's1', source: 'compact' })
  assert.match(contextOf(edit('src/order.ts')) ?? '', /# Engineering rules/)
  assert.equal(contextOf(edit('README.md', 's3')), undefined, 'ignored files get no engineering guide')
})

test('session start lists guide names without their bodies', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  const ctx = JSON.parse(hook(repo, 'session-start', { session_id: 's1', source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /Guides \(injected when you first touch matching files\): contracts, engineering, testing/)
  assert.doesNotMatch(ctx, /Iron rules/)
})

test('I3: Stop ratchets a known-red command that now passes; it then blocks when it fails again', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  const lint = 'node -e "process.exit(require(\'fs\').existsSync(\'bad.flag\') ? 1 : 0)"'
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { lint }, knownRed: ['fast.lint'] }, null, 2) + '\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/a.js', 'export const a = 1\n')
  assert.equal(stop().stdout, '')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8')).knownRed, [])
  write(repo, 'src/a.js', 'export const a = 2\n')
  assert.equal(stop().stdout, '', 'the ratchet write is not harness-tamper')
  write(repo, 'bad.flag', 'x\n')
  const out = JSON.parse(stop().stdout)
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /\[commands\][\s\S]*fast\.lint failed/)
})

test('a failed built-in code-review load falls back to the sdlc reviewer agent', () => {
  const repo = makeRepo(); sdlc(repo, ['init'])
  const r = JSON.parse(hook(repo, 'skill-failed', { tool_input: { skill: 'code-review' } }).stdout)
  assert.match(r.hookSpecificOutput.additionalContext, /rig:reviewer/)
})

test('a failed superpowers SDD load sends the model back to native orchestration and logs it', () => {
  const repo = makeRepo(); sdlc(repo, ['init'])
  const r = JSON.parse(hook(repo, 'skill-failed', { tool_input: { skill: 'superpowers:subagent-driven-development' } }).stdout)
  assert.match(r.hookSpecificOutput.additionalContext, /Large builds: orchestrate/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8'), /"skill":"superpowers:subagent-driven-development"/)
  assert.equal(hook(repo, 'skill-failed', { tool_input: { skill: 'other:thing' } }).stdout, '')
})

test('harness files untracked at turn start and committed unchanged in the turn are not harness-tamper', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  write(repo, '.claude/agents/rig-scout.md', '# scout\n')
  write(repo, 'CLAUDE.md', '# project\n')
  hook(repo, 'prompt-submit', {})
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'chore: onboard')
  write(repo, 'src/a.js', 'export const a = 1\n')
  assert.equal(stop().stdout, '', 'committing pre-existing harness files is not tampering')
  write(repo, 'CLAUDE.md', '# changed by Bash\n')
  const out = JSON.parse(stop().stdout)
  assert.match(out.reason, /harness-tamper[\s\S]*CLAUDE\.md/, 'changing one in the same turn still blocks')
})

test('a turn that only writes harness files (onboarding) opens no ad-hoc change', () => {
  sdlc(repo, ['init'])
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.github/workflows/rig-check.yml', 'name: rig-check\n')
  write(repo, '.claude/settings.json', '{}\n')
  stop()
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/changes')) || !fs.readdirSync(path.join(repo, '.sdlc/changes')).some(d => d.startsWith('adhoc-')))
  write(repo, 'src/a.js', 'export const a = 1\n')
  stop()
  assert.ok(fs.readdirSync(path.join(repo, '.sdlc/changes')).some(d => d.startsWith('adhoc-')), 'real source work still opens one')
})
