// Managed settings: the reader, rig's hooks under allowManagedHooksOnly, the template, the production gate, preflight and metrics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { makeRepo, sdlc, write } from './testkit.ts'
import { managedSettings, managedFiles } from './core.ts'
import { managedCheck, controlsInForce, CONTROLS } from './preflight.ts'

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
  const [maj = 0, min = 0, patch = 0] = String(m.requiredMinimumVersion).split('.').map(Number)
  assert.ok(maj > 2 || (maj === 2 && (min > 1 || (min === 1 && patch >= 251))), 'rig needs 2.1.251 or later')
  assert.match(m.$comment, /tailor/i)
})

test('the project template denies the gate log and asks before edits to protected paths', () => {
  const p = tpl('settings.json').permissions
  assert.ok(p.deny.includes('Edit(/.sdlc/gates.jsonl)'))
  for (const r of ['Edit(/migrations/**)', 'Edit(/infra/**)']) assert.ok(p.ask.includes(r), r)
})

const GATE = path.join(ROOT, 'templates', 'production-gate.sh')
const gate = (command: string, env: Record<string, string>, extra: Record<string, unknown> = {}) =>
  spawnSync('/bin/sh', [GATE], { input: JSON.stringify({ session_id: 'sess-1', tool_name: 'Bash', tool_input: { command }, ...extra }), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
const posix = { skip: process.platform === 'win32' ? 'POSIX sh only' : false }

test('the gate blocks a production deploy without approval, explains the route, and allows it with approval', posix, () => {
  const repo = makeRepo()
  fs.mkdirSync(path.join(repo, '.sdlc'), { recursive: true })
  const blocked = gate('./scripts/deploy.sh --env production', { CLAUDE_PROJECT_DIR: repo })
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /production[\s\S]*release manager[\s\S]*RELEASE_APPROVAL/i)
  assert.equal(gate('./scripts/deploy.sh --env production', { CLAUDE_PROJECT_DIR: repo, RELEASE_APPROVAL: 'CHG-1234' }).status, 0)
  assert.equal(gate('./scripts/deploy.sh --env staging', { CLAUDE_PROJECT_DIR: repo }).status, 0)
  assert.equal(gate('cat production.md', { CLAUDE_PROJECT_DIR: repo }).status, 0, 'deploy and the environment must both appear')
  const rows = fs.readFileSync(path.join(repo, '.sdlc', 'gates.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(rows.map(r => [r.decision, r.session]), [['block', 'sess-1'], ['allow', 'sess-1']], 'only matching commands are logged')
  assert.match(rows[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  assert.doesNotMatch(fs.readFileSync(path.join(repo, '.sdlc', 'gates.jsonl'), 'utf8'), /deploy|scripts/, 'command text is never logged')
})

test('the gate never fails open: no jq, no env name, no .sdlc, a symlinked log, a hostile session id', posix, () => {
  const repo = makeRepo()
  assert.equal(gate('deploy production', { CLAUDE_PROJECT_DIR: repo, PATH: '/usr/bin:/bin' }).status, 2, 'needs no jq or node')
  assert.equal(gate('deploy production', { CLAUDE_PROJECT_DIR: repo, RIG_PRODUCTION_ENV: '' }).status, 2, 'empty env name means production')
  assert.equal(gate('DEPLOY to PROD-EU', { CLAUDE_PROJECT_DIR: repo, RIG_PRODUCTION_ENV: 'prod-eu' }).status, 2, 'case-insensitive, env name from the variable')
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc')), 'no .sdlc: still gated, nothing created')
  fs.mkdirSync(path.join(repo, '.sdlc'))
  const target = path.join(repo, 'elsewhere.txt')
  fs.symlinkSync(target, path.join(repo, '.sdlc', 'gates.jsonl'))
  assert.equal(gate('deploy production', { CLAUDE_PROJECT_DIR: repo }).status, 2, 'a symlinked log never changes the decision')
  assert.ok(!fs.existsSync(target), 'and is never followed')
  fs.unlinkSync(path.join(repo, '.sdlc', 'gates.jsonl'))
  gate('deploy production', { CLAUDE_PROJECT_DIR: repo }, { session_id: 'x","decision":"allow' })
  const row = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc', 'gates.jsonl'), 'utf8').trim())
  assert.deepEqual([row.decision, row.session], ['block', ''], 'a session id outside the UUID charset is dropped')
  assert.equal(gate('deploy \\"production\\"', { CLAUDE_PROJECT_DIR: repo }).status, 2, 'escaped quotes in the command still match')
})

test('preflight managed: 16 controls from p.42; the template has all 16; never fails', () => {
  assert.equal(CONTROLS.length, 16)
  const full = tpl('managed-settings.json')
  assert.equal(controlsInForce(full).length, 16)
  assert.deepEqual(managedCheck(full, 1), { id: 'managed', status: 'pass', line: '16/16 managed controls in force (1 file)' })
  assert.equal(managedCheck({}, 0).status, 'skip')
  assert.match(managedCheck({}, 0).line, /server-managed settings are not visible here/)
  const partial = managedCheck({ permissions: { disableBypassPermissionsMode: 'disable' }, sandbox: { enabled: true } }, 1)
  assert.equal(partial.status, 'warn')
  assert.match(partial.line, /^2\/16 managed controls in force/)
  assert.match(partial.line, /missing: .*allowManagedHooksOnly/)
  assert.ok(partial.fix?.includes('templates/managed-settings.json'))
})

test('preflight managed warns when the managed file would switch rig off or protect the wrong folder', () => {
  const full = tpl('managed-settings.json')
  const noRig = managedCheck({ ...full, enabledPlugins: {} }, 1)
  assert.equal(noRig.status, 'warn')
  assert.match(noRig.line, /rig's hooks are off: allowManagedHooksOnly without rig force-enabled/)
  const noRules = managedCheck({ ...full, permissions: { ...full.permissions, deny: ['Read(.env*)'] } }, 1)
  assert.match(noRules.line, /rig's evidence rules are dropped/)
  const anchored = managedCheck({ ...full, permissions: { ...full.permissions, deny: [...full.permissions.deny, 'Edit(/.sdlc/approvals.jsonl)'] } }, 1)
  assert.match(anchored.line, /Edit\(\/\.sdlc\/approvals\.jsonl\) anchors at the managed settings folder: use \.\//)
})

test('preflight reports the managed row from RIG_MANAGED_DIR and still passes without it', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  assert.match(sdlc(repo, ['preflight'], { env: { RIG_MANAGED_DIR: tmpDir() } }).stdout, /\| managed \| skip \|/)
  const dir = tmpDir()
  fs.copyFileSync(path.join(ROOT, 'templates', 'managed-settings.json'), path.join(dir, 'managed-settings.json'))
  assert.match(sdlc(repo, ['preflight'], { env: { RIG_MANAGED_DIR: dir } }).stdout, /\| managed \| pass \| 16\/16/)
})
