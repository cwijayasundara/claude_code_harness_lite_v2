// Managed settings: the reader, rig's hooks under allowManagedHooksOnly, the template, the production gate, preflight and metrics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write } from './testkit.ts'
import { managedSettings, managedFiles } from './core.ts'

const ROOT = path.join(import.meta.dirname, '..')
const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rig-managed-'))

test('managed settings: the main file and its drop-ins merge in name order; arrays concatenate; bad files are skipped', () => {
  const dir = tmpDir()
  assert.deepEqual(managedSettings(dir), {})
  fs.writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify({ permissions: { deny: ['Read(.env*)'] }, sandbox: { enabled: false } }))
  fs.mkdirSync(path.join(dir, 'managed-settings.d'))
  fs.writeFileSync(path.join(dir, 'managed-settings.d', '20-b.json'), JSON.stringify({ sandbox: { enabled: true } }))
  fs.writeFileSync(path.join(dir, 'managed-settings.d', '10-a.json'), JSON.stringify({ permissions: { deny: ['WebFetch'] }, allowManagedHooksOnly: true }))
  fs.writeFileSync(path.join(dir, 'managed-settings.d', '30-bad.json'), '{ not json')
  assert.deepEqual(managedSettings(dir), { permissions: { deny: ['Read(.env*)', 'WebFetch'] }, sandbox: { enabled: true }, allowManagedHooksOnly: true })
  assert.equal(managedFiles(dir).length, 3, 'the unparsable drop-in is not counted')
})

test('under allowManagedHooksOnly the plugin hooks run in a standalone repo, whose own project hooks Claude Code blocks', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  sdlc(repo, ['vendor', '--standalone'])
  write(repo, 'src/key.js', 'const key = "AKIAABCDEFGHIJKLMNOP"\n')
  const edit = (env: Record<string, string>) => sdlc(repo, ['hook', 'post-edit'], { input: JSON.stringify({ tool_input: { file_path: path.join(repo, 'src/key.js') } }), env })
  const none = tmpDir()
  assert.equal(edit({ RIG_MANAGED_DIR: none }).code, 0, 'no managed settings: the project copy decides, the plugin steps aside')
  const managed = tmpDir()
  fs.writeFileSync(path.join(managed, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true }))
  assert.equal(edit({ RIG_MANAGED_DIR: managed }).code, 2, 'project hooks are blocked, so the plugin copy runs')
})

const tpl = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', name), 'utf8'))
// A project rule as it must appear in a managed file: a leading "/" anchors at the settings file's own folder, so "./" is used.
const asManaged = (rule: string): string => rule.replace(/^(\w+)\(\/(?!\/)/, '$1(./')

test('the managed template carries every rig rule in ./ form, since allowManagedPermissionRulesOnly drops the project ones', () => {
  const project = tpl('settings.json').permissions
  const managed = tpl('managed-settings.json').permissions
  for (const kind of ['allow', 'ask', 'deny'] as const) {
    const missing = project[kind].map(asManaged).filter((r: string) => !managed[kind].includes(r))
    assert.deepEqual(missing, [], `managed ${kind} is missing project rules`)
  }
  const anchored = [...managed.allow, ...managed.ask, ...managed.deny].filter((r: string) => /^\w+\(\/(?!\/)/.test(r))
  assert.deepEqual(anchored, [], 'no managed rule may start with a single "/"')
})

test('the managed template is the p.42 worked example with rig force-enabled and the production gate wired', () => {
  const m = tpl('managed-settings.json')
  assert.equal(m.permissions.disableBypassPermissionsMode, 'disable')
  for (const r of ['Read(.env*)', 'Read(./secrets/**)', 'WebFetch', 'Bash(curl *)', 'Bash(wget *)', 'Edit(./.sdlc/gates.jsonl)']) assert.ok(m.permissions.deny.includes(r), r)
  for (const k of ['allowManagedPermissionRulesOnly', 'allowManagedHooksOnly', 'disableSideloadFlags', 'allowManagedMcpServersOnly']) assert.equal(m[k], true, k)
  assert.deepEqual([m.sandbox.enabled, m.sandbox.failIfUnavailable, m.sandbox.allowUnsandboxedCommands], [true, true, false])
  assert.ok(m.sandbox.network.allowedDomains.includes('api.github.com'), 'gh, used by /rig:pr, needs GitHub')
  assert.ok(Array.isArray(m.strictKnownMarketplaces) && m.strictKnownMarketplaces.every((s: { source?: string }) => typeof s.source === 'string'))
  assert.equal(m.enabledPlugins['rig@rig'], true, 'force-enabled, so its hooks survive allowManagedHooksOnly')
  assert.ok(m.extraKnownMarketplaces.rig, 'the rig marketplace is registered so the forced plugin can install')
  const gate = m.hooks.PreToolUse.find((g: { matcher?: string }) => g.matcher === 'Bash')
  assert.match(gate.hooks[0].command, /^\/etc\/claude-code\/gates\/production-gate\.sh$/, 'an admin-owned path, never the repo')
  assert.equal(m.env.RIG_PRODUCTION_ENV, 'production')
  const [maj, min, patch] = String(m.requiredMinimumVersion).split('.').map(Number)
  assert.ok(maj > 2 || (maj === 2 && (min > 1 || (min === 1 && patch >= 251))), 'rig needs 2.1.251 or later')
  assert.match(m.$comment, /tailor/i)
})

test('the project template denies the gate log and asks before edits to protected paths', () => {
  const p = tpl('settings.json').permissions
  assert.ok(p.deny.includes('Edit(/.sdlc/gates.jsonl)'))
  for (const r of ['Edit(/migrations/**)', 'Edit(/infra/**)']) assert.ok(p.ask.includes(r), r)
})
