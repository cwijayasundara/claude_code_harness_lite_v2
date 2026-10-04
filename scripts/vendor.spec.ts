// Cloud mode: `vendor --cloud` copies the whole harness into a project so cloud sessions (no plugins) run it.
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
const vendored = (repo: string, args: string[], input?: string) => {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', path.join(repo, '.sdlc/bin/sdlc.ts'), ...args], {
    cwd: repo, input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo, SDLC_HUMAN: '', NODE_TEST_CONTEXT: '' },
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
