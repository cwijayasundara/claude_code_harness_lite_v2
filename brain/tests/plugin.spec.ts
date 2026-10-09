import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const fm = (f: string) => fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''

test('manifests parse and agree on the name and version', () => {
  const p = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'))
  const m = JSON.parse(fs.readFileSync('../.claude-plugin/marketplace.json', 'utf8'))
  const e = m.plugins.find((x: any) => x.name === 'rig-brain')
  assert.equal(p.name, 'rig-brain')
  assert.equal(e?.source, './brain')
  assert.equal(e?.version, p.version)
})

test('skills and agent have frontmatter with name and description; writer is pinned to haiku', () => {
  for (const f of ['skills/wiki-refresh/SKILL.md', 'skills/wiki-find/SKILL.md', 'skills/memory-dream/SKILL.md', 'skills/memory-find/SKILL.md', 'skills/memory-forget/SKILL.md', 'agents/wiki-writer.md']) {
    assert.match(fm(f), /^name: /m, f); assert.match(fm(f), /^description: /m, f)
  }
  assert.match(fm('agents/wiki-writer.md'), /^model: haiku$/m)
})

test('memory skills call memory.ts through the plugin root', () => {
  for (const s of ['memory-dream', 'memory-find', 'memory-forget']) assert.match(fs.readFileSync(`skills/${s}/SKILL.md`, 'utf8'), /\$\{CLAUDE_PLUGIN_ROOT\}\/memory\/memory\.ts/)
})

test('hooks.json wires only command hooks to wiki.ts or memory.ts', () => {
  const h = JSON.parse(fs.readFileSync('hooks/hooks.json', 'utf8'))
  const cmds = Object.values<any>(h.hooks).flat().flatMap((e: any) => e.hooks.map((x: any) => x.command))
  assert.ok(cmds.length >= 10)
  for (const c of cmds) assert.match(c, /(code_wiki\/wiki|memory\/memory)\.ts" hook /)
  assert.ok(Object.keys(h.hooks).includes('PostToolUseFailure'))
})
