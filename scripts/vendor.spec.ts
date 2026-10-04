// Standalone mode: `vendor --standalone` (alias --cloud) copies the whole harness into a project, so it needs no plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeRepo, sdlc, write } from './testkit.ts'

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [toPosix(path.join(dir, e.name))]))
    : []
const toPosix = (p: string): string => p.split(path.sep).join('/')

// Runs the project's own copy, the way a cloud session's hooks and skills do.
const vendored = (repo: string, args: string[], input?: string, human = '') => {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', path.join(repo, '.sdlc/bin/sdlc.ts'), ...args], {
    cwd: repo, input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo, SDLC_HUMAN: human, NODE_TEST_CONTEXT: '' },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('vendor --cloud writes project skills, agents and hooks with no plugin references left', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, '.claude/settings.json', JSON.stringify({ model: 'claude-sonnet-5-5', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }))
  assert.equal(sdlc(repo, ['vendor', '--cloud']).code, 0)
  const skills = walk(path.join(repo, '.claude/skills')).filter(f => f.endsWith('SKILL.md'))
  const agents = walk(path.join(repo, '.claude/agents'))
  assert.ok(skills.some(f => f.endsWith('sdlc-next/SKILL.md')) && skills.length >= 10, `${skills.length} skills`)
  assert.ok(agents.some(f => f.endsWith('sdlc-scout.md')), 'scout agent')
  for (const f of [...skills, ...agents]) {
    const text = fs.readFileSync(f, 'utf8')
    assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT|<plugin>\/scripts|\/sdlc:[a-z]|\bsdlc:(?!allow-secret)[a-z]/, path.relative(repo, f))
    assert.match(text, /^name: sdlc-/m, path.relative(repo, f))
  }
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/templates/sdlc-check.yml')), 'templates copied')
  const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'))
  assert.equal(settings.model, 'claude-sonnet-5-5', 'other settings kept')
  const stop = JSON.stringify(settings.hooks.Stop)
  assert.match(stop, /echo mine/, 'the project\'s own hooks are kept')
  assert.match(stop, /\$CLAUDE_PROJECT_DIR\/\.sdlc\/bin\/sdlc\.ts\\?" hook stop/)
  assert.equal(sdlc(repo, ['vendor', '--cloud']).code, 0)
  const again = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8'))
  assert.equal(again.hooks.Stop.length, settings.hooks.Stop.length, 're-running replaces sdlc hooks instead of duplicating them')
})

test('the vendored copy names project skills and agents, and prints its own skills', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  sdlc(repo, ['vendor', '--cloud'])
  vendored(repo, ['new', 'small-thing', '--type', 'chore', '--tier', 'S'])
  assert.match(vendored(repo, ['status']).stdout, /next: \/sdlc-build small-thing/)
  const skill = vendored(repo, ['skill', 'next']).stdout
  assert.match(skill, /\.sdlc\/bin\/sdlc\.ts status --json/)
  const ctx = JSON.parse(vendored(repo, ['hook', 'session-start'], '{}').stdout).hookSpecificOutput.additionalContext as string
  assert.match(ctx, /sdlc-scout/)
  assert.doesNotMatch(ctx, /sdlc:scout|\/sdlc:start/)
  const failed = JSON.parse(vendored(repo, ['hook', 'skill-failed'], JSON.stringify({ tool_input: { skill: 'sdlc-verify', args: 'small-thing' } })).stdout)
  assert.match(failed.hookSpecificOutput.additionalContext, /\.sdlc\/bin\/sdlc\.ts" skill verify small-thing/)
})

test('read-only rules also hold for the vendored sdlc- agents', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  sdlc(repo, ['vendor', '--cloud'])
  const r = JSON.parse(vendored(repo, ['hook', 'pre-bash'], JSON.stringify({ agent_type: 'sdlc-reviewer', tool_input: { command: 'touch x.js' } })).stdout)
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny')
})

test('the PR review may write its two files through Edit rules; a Write(path) rule grants nothing', () => {
  const yml = fs.readFileSync(path.join(import.meta.dirname, '..', 'templates', 'sdlc-review.yml'), 'utf8')
  const allowed = /--allowedTools "([^"]+)"/.exec(yml)?.[1] ?? ''
  assert.deepEqual(allowed.split(','), ['Read(./**)', 'Grep', 'Glob', 'Edit(./review.md)', 'Edit(./review-verdict.txt)'])
})

const humanCommand = (cmd: string): string => `SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts ${cmd}`
const bashDecision = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined)

test('standalone ships human-only /sdlc-approve and /sdlc-waive skills the model cannot invoke or imitate', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  assert.equal(sdlc(repo, ['vendor', '--standalone']).code, 0)
  for (const cmd of ['approve', 'waive']) {
    const skill = fs.readFileSync(path.join(repo, `.claude/skills/sdlc-${cmd}/SKILL.md`), 'utf8')
    assert.match(skill, /^disable-model-invocation: true$/m)
    assert.ok(skill.includes(`allowed-tools: Bash(${humanCommand(cmd)} *)`), `${cmd}: the grant covers exactly the injected command`)
    assert.ok(skill.includes(`!\`${humanCommand(cmd)} '$ARGUMENTS' 2>&1\``), `${cmd}: arguments are single-quoted, never globbed`)
  }
  const input = JSON.stringify({ tool_input: { command: humanCommand('approve demo plan') } })
  assert.equal(bashDecision(vendored(repo, ['hook', 'pre-bash'], input)), 'deny', 'the model cannot reuse the grant for another approval')
})

test('a quoted argument string is split: /sdlc-approve and /sdlc-waive work from a standalone skill', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  sdlc(repo, ['vendor', '--standalone'])
  vendored(repo, ['new', 'demo', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/demo/spec.md', '# Spec\n\n## Open questions\nnone\n')
  assert.equal(vendored(repo, ['approve', 'demo spec'], undefined, '1').code, 0)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/approvals.jsonl'), 'utf8'), /"slug":"demo","stage":"spec"/)
  assert.equal(vendored(repo, ['waive', 'size * too big for one PR'], undefined, '1').code, 0)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/waivers.jsonl'), 'utf8'), /"file":"\*","reason":"too big for one PR"/)
  assert.equal(vendored(repo, ['approve', 'demo spec']).code, 3, 'still human-only')
})

test('the plugin hooks step aside only in a standalone repo, so no hook runs twice', () => {
  const input = JSON.stringify({ tool_input: { command: humanCommand('approve demo plan') } })
  const ci = makeRepo()
  sdlc(ci, ['init'])
  sdlc(ci, ['vendor'])
  assert.equal(bashDecision(sdlc(ci, ['hook', 'pre-bash'], { input })), 'deny', 'plain vendor (the CI checker) leaves the plugin hooks on')
  const standalone = makeRepo()
  sdlc(standalone, ['init'])
  sdlc(standalone, ['vendor', '--standalone'])
  const r = sdlc(standalone, ['hook', 'pre-bash'], { input })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '', 'the plugin copy is silent; the project copy decides')
  const settings = path.join(standalone, '.claude/settings.json')
  const full = JSON.parse(fs.readFileSync(settings, 'utf8'))
  fs.writeFileSync(settings, JSON.stringify({ $comment: 'see .sdlc/bin/sdlc.ts', hooks: { Stop: full.hooks.Stop } }))
  assert.equal(bashDecision(sdlc(standalone, ['hook', 'pre-bash'], { input })), 'deny', 'a mention or another hook does not silence pre-bash')
  fs.writeFileSync(settings, '{ not json')
  assert.equal(bashDecision(sdlc(standalone, ['hook', 'pre-bash'], { input })), 'deny', 'unreadable settings keep the plugin hooks')
})

test('the settings template is portable: no personal plugins, absolute paths or no-op Write(path) rules', () => {
  const dir = path.join(import.meta.dirname, '..', 'templates')
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    assert.doesNotMatch(text, /Write\([^)]*[./*][^)]*\)/, `${f}: path-scoped write rules must be Edit(...)`)
    assert.doesNotMatch(text, /"\/(Users|home)\/|ABSOLUTE\/PATH/, `${f}: no machine-specific paths`)
  }
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(settings.enabledPlugins?.['sdlc@sdlc'], undefined, 'standalone repos do not make teammates install the plugin')
})

test('standalone vendoring ships the v0.4 skills and REVIEW.md template', () => {
  const repo = makeRepo()
  sdlc(repo, ['vendor', '--standalone'])
  for (const s of ['sdlc-test', 'sdlc-sensors', 'sdlc-pr', 'sdlc-pr-review'])
    assert.ok(fs.existsSync(path.join(repo, `.claude/skills/${s}/SKILL.md`)), s)
  assert.ok(!fs.existsSync(path.join(repo, '.claude/skills/sdlc-verify/SKILL.md')), 'old names are gone')
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/templates/REVIEW.md')))
})
