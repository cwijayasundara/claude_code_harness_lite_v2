// Model routing (decision 4 of docs/ai-sdlc-harness-design.html): the tier picks the model; aliases are pinned to 5.5.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { makeRepo, gitIn, write } from './testkit.ts'

const ROOT = path.join(import.meta.dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('the settings template pins every alias to its 5.5 model and gives general subagents Haiku 5.5', () => {
  const env = (JSON.parse(read('templates/settings.json')) as { env: Record<string, string> }).env
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-5-5')
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-5-5')
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5')
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'claude-haiku-5-5')
})

test('the scout runs on Haiku 5.5 by full ID, like the other agents', () => {
  assert.match(read('agents/scout.md'), /^model: claude-haiku-5-5$/m)
})

const MODELS = '**Models:** pass `model` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` on every `rig:architect`, `rig:implementer` and `rig:reviewer` launch.'

test('every skill that launches architect, implementer or reviewer passes the tier model, and none hardcodes one', () => {
  for (const name of fs.readdirSync(path.join(ROOT, 'skills'))) {
    const text = read(`skills/${name}/SKILL.md`)
    if (/rig:(architect|implementer|reviewer)/.test(text)) assert.ok(text.includes(MODELS), `${name} lacks the Models line`)
    assert.doesNotMatch(text, /model: (sonnet|opus|haiku)\b/, `${name} hardcodes a model`)
  }
})

test('tier S builds through a Haiku implementer; tier S and M review through rig:reviewer, not code-review', () => {
  const build = read('skills/build/SKILL.md')
  assert.doesNotMatch(build, /Tier S, and tier M with/, 'tier S no longer builds inline')
  assert.match(build, /Tier M with ≤ 3 slices and ≤ 8 files: do it yourself/)
  assert.doesNotMatch(read('skills/start/SKILL.md'), /Tier S builds inline with no subagents/)
  assert.doesNotMatch(read('skills/start/SKILL.md'), /\*\*Models:\*\*/, 'start passes no slug, so it carries no Models line')
  const review = read('skills/pr-review/SKILL.md')
  assert.match(review, /Tier S and M: one `rig:reviewer`/)
  assert.doesNotMatch(review, /Tier S and M: one `code-review`/)
})

// The model-by-tier step, cut from the workflow between its markers and run in a real git repo.
function pickModel(setup: (repo: string) => void): string {
  const yml = read('templates/rig-review.yml')
  const block = yml.slice(yml.indexOf('# model-by-tier:start'), yml.indexOf('# model-by-tier:end'))
  assert.ok(block, 'the workflow carries the model-by-tier markers')
  const script = block.split('\n').map(l => l.replace(/^ {10}/, '')).join('\n')
  const repo = makeRepo()
  gitIn(repo, 'update-ref', 'refs/remotes/origin/main', 'main')
  gitIn(repo, 'checkout', '-q', '-b', 'pr')
  setup(repo)
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'pr', '--allow-empty')
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rig-gh-')), 'out')
  execFileSync('bash', ['-c', script], { cwd: repo, env: { ...process.env, BASE: 'main', GITHUB_OUTPUT: outFile } })
  return fs.readFileSync(outFile, 'utf8').trim()
}
const change = (slug: string, ratchet: string) => (repo: string) => write(repo, `.sdlc/changes/${slug}/ratchet.json`, ratchet)

test('CI review model: S haiku, M sonnet, L opus', () => {
  assert.equal(pickModel(change('a', '{"tier":"S","type":"feature"}')), 'model=claude-haiku-5-5')
  assert.equal(pickModel(change('a', '{"tier":"M","type":"refactor"}')), 'model=claude-sonnet-5-5')
  assert.equal(pickModel(change('a', '{"tier":"L","type":"feature"}')), 'model=claude-opus-5-5')
})

test('CI review model fails closed to Opus: greenfield, no change folder, two folders, unreadable ratchet', () => {
  assert.equal(pickModel(change('a', '{"tier":"S","type":"greenfield"}')), 'model=claude-opus-5-5')
  assert.equal(pickModel(repo => write(repo, 'src/x.js', 'x\n')), 'model=claude-opus-5-5')
  assert.equal(pickModel(repo => { change('a', '{"tier":"S"}')(repo); change('b', '{"tier":"S"}')(repo) }), 'model=claude-opus-5-5')
  assert.equal(pickModel(change('a', 'not json')), 'model=claude-opus-5-5')
})

test('the CI review passes the picked model to Claude', () => {
  assert.match(read('templates/rig-review.yml'), /--model \$\{\{ steps\.model\.outputs\.model \}\}/)
})
