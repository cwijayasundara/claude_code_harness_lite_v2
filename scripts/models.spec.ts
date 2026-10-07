// Model routing (decision 4 of docs/ai-sdlc-harness-design.html): the tier picks the model; aliases are pinned to 5.5.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

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
