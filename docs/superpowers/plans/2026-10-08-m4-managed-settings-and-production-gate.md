# M4: Managed Settings and the Production Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the playbook's p.42 managed settings as a rig template that keeps rig working under it. Add the p.41 production gate as a managed-only hook, a preflight `managed` check, and the gate metrics.

**Architecture:**
- `core.ts` gains one reader, `managedSettings()`. It reads the OS managed-settings file and its `managed-settings.d/` drop-ins, merged.
- **Hooks.** Under `allowManagedHooksOnly`, the plugin's hooks stop stepping aside for a standalone repo's project hooks, since Claude Code blocks those.
- **Preflight.** It reports which of the 16 p.42 controls are in force, and warns when the managed file would switch rig's rules or hooks off.
- **The gate.** A dependency-free `sh` script the platform team installs at an admin-owned path. It matches the command text and logs only matching commands to `.sdlc/gates.jsonl`.
- **Metrics.** They read that log and the incident files.

**Tech Stack:** Node 22.18+ TypeScript run directly (no build), `node:test`, POSIX `sh`, Claude Code managed settings.

**Spec:** `docs/ai-sdlc-harness-design.html` (§5.5 "templates/managed-settings.json" and "templates/production-gate.sh"; §7 Security; §9 Testing; §10 M4).

## Global Constraints

- Harness line cap: `scripts/size.spec.ts` total ≤ **7900**, and templates count. Today: **7,479**. The M4 budget is **≤ 170 lines** (table below); M5 and M6 need the rest.
- Every script ≤ 500 lines, every skill ≤ 60 lines.
- Zero runtime dependencies. The gate script needs only POSIX `sh`, `sed`, `grep`, `date` and `printf`; no `jq`, no `node`.
- **No hook on Bash in core.** `hooks/hooks.json` gains nothing. The gate is wired only in `templates/managed-settings.json`.
- **Managed-settings facts (docs-verified 2026-10-08):**
  - **Paths.**
    - macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
    - Linux and WSL: `/etc/claude-code/managed-settings.json`
    - Windows: `C:\Program Files\ClaudeCode\managed-settings.json`
    - Drop-ins go in `managed-settings.d/*.json` next to the main file.
  - **Rule anchors.** A `/path` rule anchors at the *settings source's directory*. In a managed file, `Edit(/.sdlc/x)` therefore protects `/etc/claude-code/.sdlc/x`, not the repo. Managed rules use `./path`, which is relative to the current directory.
  - **Bypass mode.** `permissions.disableBypassPermissionsMode` is the string `"disable"`.
  - **Marketplaces.** `strictKnownMarketplaces` is an array of source objects (`{ "source": "github", "repo": "org/repo" }`).
  - **Managed hooks only.** `allowManagedHooksOnly: true` blocks project, user and plugin hooks. Hooks of plugins that managed `enabledPlugins` force-enables still run, matched by the full `plugin@marketplace` ID. Whether such a plugin's `modules` (the mod) also run is unverified (no doc quote).
  - **Managed rules only.** `allowManagedPermissionRulesOnly: true` drops every non-managed permission rule.
  - **Managed hook runtime.** Managed hooks run through `sh -c` and get `$CLAUDE_PROJECT_DIR`.
  - **Managed env.** Managed `env` reaches every subprocess, hooks included.
  - **Hook stdin.** PreToolUse stdin has `tool_name`, `tool_input.command`, `cwd` and `session_id`. Exit 2 blocks, and stderr is shown to Claude.
- Minimum Claude Code version for rig: **2.1.251**. That is the managed template's `requiredMinimumVersion`.
- The production environment name comes from env `RIG_PRODUCTION_ENV`, default `production`. Approval is env `RELEASE_APPROVAL`, non-empty (the p.41 contract).
- Test override for the managed directory: env `RIG_MANAGED_DIR`, the same pattern as `RIG_CLAUDE` in M1.
- Preflight `managed` never returns `fail`; it is advisory. Statuses: `pass` (16/16, no warnings), `warn`, or `skip` (no managed file on this machine).
- Never dogfood: run no rig commands that create change records in this repo. Tests use `makeRepo()`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit the playbook PDF.

### Line budget (enforced by `size.spec.ts`)

| Item | Budget |
|---|---|
| `core.ts` `managedSettings()` + `MANAGED_DIR` | +16 |
| `hooks.ts` step-aside fix | +2 |
| `preflight.ts` `managedCheck` + 16 controls | +40 |
| `metrics.ts` 3 metrics | +14 |
| `templates/settings.json` (gates.jsonl deny, 2 protected-path asks) | +3 |
| `templates/managed-settings.json` (new) | ≤ 70 |
| `templates/production-gate.sh` (new) | ≤ 28 |
| `core.ts` GITIGNORED entry | +0 (same line) |
| **M4 total** | **≤ 173** → harness ≤ 7,652 |
| Left for M5 + M6 | ≥ 248, against about 300 estimated (`watch.ts` ≤ 150, 3 workflows ≤ 45 each, metrics +20). Raise the cap when M5 is planned. |

## Review Focus

1. **The gate fails open.** A gate that crashes, or exits with anything but 2, allows the command. Expect a deploy-to-production command blocked in each of these cases: no `jq` on the machine, `RIG_PRODUCTION_ENV` unset or empty, no `.sdlc/` in the project, and an unwritable or symlinked log. Pinned in Task 3.
2. **Rule-path anchoring.** A rule copied from the project template into the managed file with a leading `/` protects nothing. Expect every rig rule in the managed template to be in `./` form, and preflight to warn about a managed `/`-anchored `.sdlc` rule. Pinned in Tasks 2 and 4.
3. **rig is silently switched off.** A standalone repo under `allowManagedHooksOnly` would lose every rig hook, because the plugin copy steps aside for project hooks that never run. Expect the plugin hooks to run. Pinned in Task 1.
4. **Drift between the two templates.** A deny or ask rule added later to `templates/settings.json` but not to the managed template is dropped under `allowManagedPermissionRulesOnly`. Expect a test that fails on any missing rule. Pinned in Task 2.
5. **The gate log leaks secrets or is forged.** A logged command could carry a token. Expect the log to hold only `at`, `decision` and a UUID-charset `session`, never command text. Expect writes to refuse a symlink. Expect the file to be denied to the Edit tool in both templates and gitignored. Pinned in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/core.ts` | `MANAGED_DIR` (per OS, `RIG_MANAGED_DIR` override), `managedSettings()`: main file plus sorted drop-ins, deep-merged (objects merge, arrays concatenate, later scalars win); `{}` when none. `gates.jsonl` added to `GITIGNORED`. |
| `scripts/hooks.ts` | `runsOwnHook` returns false when managed `allowManagedHooksOnly` is true. |
| `templates/managed-settings.json` | p.42 plus rig: force-enable `rig@rig`, rig's rules in `./` form, the gate hook, `RIG_PRODUCTION_ENV`, version floor 2.1.251, a `$comment` tailor block. |
| `templates/production-gate.sh` | p.41 gate: text match on the command, exit 2 with the route to approval, log matching decisions. |
| `templates/settings.json` | Deny `Edit(/.sdlc/gates.jsonl)`; ask `Edit(/migrations/**)`, `Edit(/infra/**)`. |
| `scripts/preflight.ts` | `CONTROLS` (16 predicates), `managedCheck(settings, found)`, the `managed` step. |
| `scripts/metrics.ts` | `managed_controls_in_force`, `gate_wait_hours`, `gate_violations_escaped`. |
| `scripts/managed.spec.ts` (new) | Template, drift, gate-script, managed-check and metric tests. |
| `SECURITY.md`, `README.md`, `docs/ai-sdlc-harness-design.html` | The rollout, the limits and the deviations. |

---

### Task 1: The managed-settings reader, and rig's hooks under `allowManagedHooksOnly`

**Files:**
- Modify: `scripts/core.ts` (near `PLUGIN_ROOT`, line ~355; `GITIGNORED` line 360)
- Modify: `scripts/hooks.ts:248-260` (`runsOwnHook`)
- Test: `scripts/managed.spec.ts` (create)

**Interfaces:**
- Produces:
  - `export const MANAGED_DIR: string`, the per-OS directory, or `process.env.RIG_MANAGED_DIR` when set.
  - `export function managedSettings(dir?: string): Record<string, unknown>`. It reads `<dir>/managed-settings.json` and then `<dir>/managed-settings.d/*.json` in name order, and deep-merges them. A file that does not parse is skipped. It returns `{}` when nothing is found.
  - `export function managedFiles(dir?: string): string[]` lists the files that were read, for preflight's "found" note.

- [ ] **Step 1: Write the failing tests**

Create `scripts/managed.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts`
Expected: FAIL. The suite cannot import `managedSettings` from `./core.ts` ("does not provide an export named").

- [ ] **Step 3: Implement the reader in `scripts/core.ts`**

After `export const IS_VENDORED = ...` (line ~357), add:

```ts
// Managed settings (the platform team's, which no engineer can edit): the OS file plus managed-settings.d/ drop-ins in name order.
// Objects merge, arrays concatenate, later scalars win. RIG_MANAGED_DIR overrides the directory (tests). Server-managed settings are not visible here.
export const MANAGED_DIR = process.env.RIG_MANAGED_DIR || (process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
  : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code')
export function managedFiles(dir = MANAGED_DIR): string[] {
  const d = path.join(dir, 'managed-settings.d')
  const drops = exists(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => path.join(d, f)) : []
  return [path.join(dir, 'managed-settings.json'), ...drops].filter(f => { try { JSON.parse(fs.readFileSync(f, 'utf8')); return true } catch { return false } })
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k,
  isObj(a[k]) && isObj(b[k]) ? deepMerge(a[k], b[k]) : Array.isArray(a[k]) && Array.isArray(b[k]) ? [...a[k], ...b[k]] : k in b ? b[k] : a[k]]))
export const managedSettings = (dir = MANAGED_DIR): Record<string, unknown> =>
  managedFiles(dir).reduce<Record<string, unknown>>((acc, f) => { const v: unknown = JSON.parse(fs.readFileSync(f, 'utf8')); return isObj(v) ? deepMerge(acc, v) : acc }, {})
```

In the same file, change line 360 to add the gate log to the gitignored list. It is a per-machine log, like `usage.jsonl`:

```ts
const GITIGNORED = ['usage.jsonl', '.baseline', '.gate', 'unresolved.json', 'gates.jsonl']
```

`MANAGED_DIR` uses `process.platform`; no new import is needed (`exists`, `fs` and `path` are already in core.ts).

- [ ] **Step 4: Implement the step-aside fix in `scripts/hooks.ts`**

Import `managedSettings` from `./core.ts` (add it to the existing core import). In `runsOwnHook`, after `if (IS_VENDORED) return false`, add:

```ts
  // Managed allowManagedHooksOnly blocks project hooks, so the project copy never runs: the plugin's (force-enabled) copy must.
  if (managedSettings().allowManagedHooksOnly === true) return false
```

Update the comment above `runsOwnHook` so it ends: `...unreadable settings keep the plugin's, and so does managed allowManagedHooksOnly.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts scripts/vendor.spec.ts scripts/gate.spec.ts`
Expected: PASS, all tests, including the existing `the plugin hooks step aside only in a standalone repo` test.

The existing tests must not see the developer machine's real managed file. If one exists, `vendor.spec`'s step-aside test reads it. That is acceptable only when it lacks `allowManagedHooksOnly`. Ruling for executors: if this machine has such a file and the test fails, set `RIG_MANAGED_DIR` to an empty temp dir in `testkit.ts`'s `CLEAN_ENV` default, `{ ...CLEAN_ENV, RIG_MANAGED_DIR: <empty dir> ... }`, and ledger it.

- [ ] **Step 6: Commit**

```bash
git add scripts/core.ts scripts/hooks.ts scripts/managed.spec.ts
git commit -m "feat: read managed settings; rig's plugin hooks run under allowManagedHooksOnly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `templates/managed-settings.json` and the project template rules

**Files:**
- Create: `templates/managed-settings.json`
- Modify: `templates/settings.json` (the `ask` and `deny` arrays)
- Test: `scripts/managed.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime. Task 4 imports this template in its tests.
- Produces:
  - The managed template's shape, used by Task 4's controls: `permissions.{allow,ask,deny,disableBypassPermissionsMode}`, `allowManagedPermissionRulesOnly`, `sandbox.{enabled,failIfUnavailable,allowUnsandboxedCommands,network.allowedDomains,credentials.{files,envVars}}`, `allowManagedHooksOnly`, `disableSideloadFlags`, `allowManagedMcpServersOnly`, `strictKnownMarketplaces`, `extraKnownMarketplaces`, `enabledPlugins`, `hooks.PreToolUse`, `env.RIG_PRODUCTION_ENV`, `requiredMinimumVersion`.
  - The gate hook command string: `/etc/claude-code/gates/production-gate.sh`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/managed.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts`
Expected: FAIL with ENOENT on `templates/managed-settings.json`, and the project-template test failing on `Edit(/.sdlc/gates.jsonl)`.

- [ ] **Step 3: Edit `templates/settings.json`**

In `permissions.ask`, after `"Edit(/.github/CODEOWNERS)",`, add:

```json
      "Edit(/migrations/**)",
      "Edit(/infra/**)",
```

In `permissions.deny`, after `"Edit(/.sdlc/evals/results.jsonl)",`, add:

```json
      "Edit(/.sdlc/gates.jsonl)",
```

- [ ] **Step 4: Create `templates/managed-settings.json`**

The template copies the p.42 example and adds rig's pieces. Several rules share a line, so the template stays within ≤ 70 lines. Each project rule is copied in `./` form (`Read(.env)` stays bare, which is already cwd-relative).

```json
{
  "$comment": "Managed settings for rig repos: the playbook's p.42 worked example plus what rig needs. A starting point to tailor, not a file to copy: every deny trades capability for control, so set it by each repo's data classification. Deploy with MDM or the admin console to /Library/Application Support/ClaudeCode/managed-settings.json (macOS), /etc/claude-code/managed-settings.json (Linux, WSL) or C:\\Program Files\\ClaudeCode\\managed-settings.json (Windows). Tailor: the domains, the marketplace repos (point rig@rig at your fork), the credential paths and env vars, the version floor and the allow list (your real build, test and lint commands). Rules use ./path: a /path rule here would anchor at this file's folder, not the repo. allowManagedPermissionRulesOnly drops every project rule, so rig's own rules are repeated here (a test keeps them in step with templates/settings.json). allowManagedHooksOnly blocks project and plugin hooks except those of force-enabled plugins, so rig is force-enabled. The sandbox denies GITHUB_TOKEN: gh, which /rig:pr uses, then needs its own login (gh auth login) or a narrower token. Install templates/production-gate.sh at the hook path below (root-owned, not writable by engineers) and set RIG_PRODUCTION_ENV to your production environment's name.",
  "permissions": {
    "allow": [
      "Bash(git *)", "Bash(make build)", "Bash(make test)", "Bash(make lint)",
      "Edit(.sdlc/**)", "Bash(node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts *)"
    ],
    "ask": [
      "Edit(./.sdlc/sensors.json)", "Edit(./.sdlc/rules.json)", "Edit(./.sdlc/evals/*.json)", "Edit(./.claude/settings.json)",
      "Edit(./.sdlc/bin/**)", "Edit(./.sdlc/githooks/**)", "Edit(./.sdlc/mod/**)", "Edit(./.sdlc/guides/**)",
      "Edit(./.github/workflows/rig-check.yml)", "Edit(./CODEOWNERS)", "Edit(./.github/CODEOWNERS)",
      "Edit(./migrations/**)", "Edit(./infra/**)",
      "Bash(node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts evals*)"
    ],
    "deny": [
      "Read(.env*)", "Read(./secrets/**)", "WebFetch", "Bash(curl *)", "Bash(wget *)",
      "Read(.env)", "Read(.env.*)", "Edit(.env)", "Edit(.env.*)",
      "Edit(./.sdlc/approvals.jsonl)", "Edit(./.sdlc/waivers.jsonl)", "Edit(./.sdlc/usage.jsonl)", "Edit(./.sdlc/gates.jsonl)",
      "Edit(./.sdlc/.gate)", "Edit(./.sdlc/.baseline)", "Edit(./.sdlc/unresolved.json)", "Edit(./.sdlc/PREFLIGHT.md)",
      "Edit(./.sdlc/evals/results.jsonl)", "Edit(./.sdlc/changes/*/runs.jsonl)", "Edit(./.sdlc/changes/*/verification.md)",
      "Edit(./.sdlc/changes/*/impact.json)", "Edit(./.sdlc/changes/*/ratchet.json)", "Edit(./.sdlc/changes/*/events.jsonl)",
      "Edit(./.sdlc/changes/*/pr.md)", "Edit(./.sdlc/changes/*/ship.json)"
    ],
    "disableBypassPermissionsMode": "disable"
  },
  "allowManagedPermissionRulesOnly": true,
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": ["git.internal.example.com", "registry.npmjs.org", "github.com", "api.github.com"] },
    "credentials": {
      "files": [ { "path": "~/.ssh", "mode": "deny" }, { "path": "~/.aws/credentials", "mode": "deny" } ],
      "envVars": [ { "name": "GITHUB_TOKEN", "mode": "deny" } ]
    }
  },
  "allowManagedHooksOnly": true,
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/etc/claude-code/gates/production-gate.sh", "timeout": 10 } ] }
    ]
  },
  "disableSideloadFlags": true,
  "allowManagedMcpServersOnly": true,
  "extraKnownMarketplaces": { "rig": { "source": { "source": "github", "repo": "example-corp/rig" } } },
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "example-corp/approved-plugins" },
    { "source": "github", "repo": "example-corp/rig" }
  ],
  "enabledPlugins": { "rig@rig": true },
  "env": { "RIG_PRODUCTION_ENV": "production" },
  "requiredMinimumVersion": "2.1.251"
}
```

Check the ask list against the project template: each `ask` entry in `templates/settings.json` must map through `asManaged`. If the project template has an entry not listed above, add its `./` form. The drift test is the authority.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts scripts/vendor.spec.ts scripts/size.spec.ts`
Expected: PASS. Two other tests guard this template. `vendor.spec`'s portability test needs no `/Users/` or `/home/` paths and no `Write(...)` rules. `size.spec` keeps the total ≤ 7900.

- [ ] **Step 6: Commit**

```bash
git add templates/managed-settings.json templates/settings.json scripts/managed.spec.ts
git commit -m "feat: managed-settings template (p.42 plus rig's rules, force-enabled rig, the gate hook); protected-path asks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `templates/production-gate.sh`

**Files:**
- Create: `templates/production-gate.sh` (mode 0755)
- Test: `scripts/managed.spec.ts`

**Interfaces:**
- Consumes: hook stdin JSON, plus env `RIG_PRODUCTION_ENV`, `RELEASE_APPROVAL` and `CLAUDE_PROJECT_DIR`.
- Produces: exit 0 (allow) or 2 (block, reason on stderr). When `$CLAUDE_PROJECT_DIR/.sdlc/` exists and the command matched, it appends one line to `.sdlc/gates.jsonl`: `{"at":"<ISO UTC>","decision":"allow"|"block","session":"<id>"}`. Task 5 reads these rows.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/managed.spec.ts`:

```ts
import { spawnSync } from 'node:child_process'
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts`
Expected: FAIL. The script does not exist, so the status is 127 rather than 2.

- [ ] **Step 3: Create `templates/production-gate.sh`**

```sh
#!/bin/sh
# Production gate (playbook p.41), a managed-only PreToolUse hook on Bash: install it root-owned outside any repo and wire it in managed settings.
# A command naming deploy and the production environment needs RELEASE_APPROVAL, else exit 2 with the route. A text match: leaky by design,
# acceptable because managed settings make it impossible to switch off. No jq or node needed. Logs only matching commands, never their text.
input=$(cat)
# tool_input.command, still JSON-escaped; if it cannot be found, match the whole input (blocks more, never less).
cmd=$(printf '%s' "$input" | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p')
[ -n "$cmd" ] || cmd=$input
env_name=${RIG_PRODUCTION_ENV:-production}
printf '%s' "$cmd" | grep -qiF deploy || exit 0
printf '%s' "$cmd" | grep -qiF -- "$env_name" || exit 0
if [ -n "$RELEASE_APPROVAL" ]; then decision=allow; else decision=block; fi
session=$(printf '%s' "$input" | sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9-]*)".*/\1/p')
dir=${CLAUDE_PROJECT_DIR:-$PWD}/.sdlc
if [ -d "$dir" ] && [ ! -L "$dir/gates.jsonl" ]; then
  printf '{"at":"%s","decision":"%s","session":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$decision" "$session" >> "$dir/gates.jsonl" 2>/dev/null || :
fi
[ "$decision" = allow ] && exit 0
echo "Blocked: deploying to $env_name needs a release manager's approval. Prepare the release, ask the release manager to authorize it, and retry in a session started with RELEASE_APPROVAL set to the approved change ticket." >&2
exit 2
```

Then run `chmod +x templates/production-gate.sh`.

Note for the executor: the hostile session id `x","decision":"allow` does not match `[A-Za-z0-9-]*"`, so `sed` prints nothing and the session is empty. The test pins this.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts scripts/size.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/production-gate.sh scripts/managed.spec.ts
git commit -m "feat: production gate (p.41) as a managed-only hook script: no dependencies, fails closed, logs decisions without command text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The preflight `managed` check

**Files:**
- Modify: `scripts/preflight.ts` (new `CONTROLS`, `managedCheck`, a `managed` step in `runPreflight`)
- Modify: `scripts/preflight.spec.ts:142` (the check-id list gains `'managed'`)
- Test: `scripts/managed.spec.ts`

**Interfaces:**
- Consumes: `managedSettings(dir)` and `managedFiles(dir)` from Task 1 (`core.ts`).
- Produces:
  - `export const CONTROLS: [string, (m: unknown) => boolean][]`, 16 entries.
  - `export function managedCheck(m: unknown, found: number): Check`.
  - `export function controlsInForce(m: unknown): string[]`, the names in force. Task 5 uses it.
  - `Opts` gains an optional `managedDir?: string`; when it is absent, `MANAGED_DIR` is used.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/managed.spec.ts`:

```ts
import { managedCheck, controlsInForce, CONTROLS } from './preflight.ts'

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
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-managed-'))
  assert.match(sdlc(repo, ['preflight'], { env: { RIG_MANAGED_DIR: none } }).stdout, /\| managed \| skip \|/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-managed-'))
  fs.copyFileSync(path.join(ROOT, 'templates', 'managed-settings.json'), path.join(dir, 'managed-settings.json'))
  assert.match(sdlc(repo, ['preflight'], { env: { RIG_MANAGED_DIR: dir } }).stdout, /\| managed \| pass \| 16\/16/)
})
```

In `scripts/preflight.spec.ts`, change line 142 so the id list ends with `'protection', 'managed'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts scripts/preflight.spec.ts`
Expected: FAIL. `managedCheck` is not exported, and preflight.spec finds no `managed` row.

- [ ] **Step 3: Implement in `scripts/preflight.ts`**

Add `MANAGED_DIR, managedSettings, managedFiles` to the `./core.ts` import. Add `managedDir?: string` to `Opts`. Above `const STACKS`, add:

```ts
// The 16 controls of the playbook's managed-settings worked example (p.42-43), each read from the merged managed settings.
const get = (m: unknown, dotted: string): unknown => dotted.split('.').reduce<unknown>((v, k) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined), m)
const has = (list: unknown, ...rules: string[]): boolean => Array.isArray(list) && rules.every(r => list.includes(r))
const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0
const is = (dotted: string, want: unknown) => (m: unknown): boolean => get(m, dotted) === want
export const CONTROLS: [string, (m: unknown) => boolean][] = [
  ['deny secret reads', m => has(get(m, 'permissions.deny'), 'Read(.env*)')], ['deny network tools', m => has(get(m, 'permissions.deny'), 'WebFetch', 'Bash(curl *)', 'Bash(wget *)')],
  ['allow the inner loop', m => nonEmpty(get(m, 'permissions.allow'))], ['disableBypassPermissionsMode', is('permissions.disableBypassPermissionsMode', 'disable')],
  ['allowManagedPermissionRulesOnly', is('allowManagedPermissionRulesOnly', true)], ['sandbox.enabled', is('sandbox.enabled', true)],
  ['sandbox.network.allowedDomains', m => Array.isArray(get(m, 'sandbox.network.allowedDomains'))], ['sandbox.failIfUnavailable', is('sandbox.failIfUnavailable', true)],
  ['sandbox.allowUnsandboxedCommands off', is('sandbox.allowUnsandboxedCommands', false)], ['sandbox.credentials.files', m => nonEmpty(get(m, 'sandbox.credentials.files'))],
  ['sandbox.credentials.envVars', m => nonEmpty(get(m, 'sandbox.credentials.envVars'))], ['allowManagedHooksOnly', is('allowManagedHooksOnly', true)],
  ['disableSideloadFlags', is('disableSideloadFlags', true)], ['strictKnownMarketplaces', m => Array.isArray(get(m, 'strictKnownMarketplaces'))],
  ['allowManagedMcpServersOnly', is('allowManagedMcpServersOnly', true)], ['requiredMinimumVersion', m => typeof get(m, 'requiredMinimumVersion') === 'string'],
]
export const controlsInForce = (m: unknown): string[] => CONTROLS.filter(([, ok]) => ok(m)).map(([name]) => name)

// Advisory: which controls are in force, and whether the managed file would switch rig's own hooks or rules off.
export function managedCheck(m: unknown, found: number): Check {
  if (!found) return { id: 'managed', status: 'skip', line: 'no managed settings file on this machine (server-managed settings are not visible here)' }
  const inForce = controlsInForce(m)
  const rules = ['allow', 'ask', 'deny'].flatMap(k => { const v = get(m, `permissions.${k}`); return Array.isArray(v) ? v : [] }).filter((r): r is string => typeof r === 'string')
  const plugins = get(m, 'enabledPlugins')
  const rigOn = typeof plugins === 'object' && plugins !== null && Object.entries(plugins).some(([id, on]) => id.startsWith('rig@') && on === true)
  const notes = [
    get(m, 'allowManagedHooksOnly') === true && !rigOn ? "rig's hooks are off: allowManagedHooksOnly without rig force-enabled in enabledPlugins" : '',
    get(m, 'allowManagedPermissionRulesOnly') === true && !has(get(m, 'permissions.deny'), 'Edit(./.sdlc/approvals.jsonl)') ? "rig's evidence rules are dropped: allowManagedPermissionRulesOnly without them in the managed file" : '',
    ...rules.filter(r => /^\w+\(\/\.sdlc\//.test(r)).map(r => `${r} anchors at the managed settings folder: use ./`),
  ].filter(Boolean)
  const missing = CONTROLS.map(([n]) => n).filter(n => !inForce.includes(n))
  const line = [`${inForce.length}/16 managed controls in force (${found} file${found === 1 ? '' : 's'})`, missing.length ? `missing: ${missing.join(', ')}` : '', ...notes].filter(Boolean).join('; ')
  return missing.length || notes.length ? { id: 'managed', status: 'warn', line, fix: 'compare with templates/managed-settings.json and ask the platform team' } : { id: 'managed', status: 'pass', line }
}
```

In `runPreflight`'s `steps`, append after `['protection', () => protection(o)]`:

```ts
    ['managed', () => { const dir = o.managedDir ?? MANAGED_DIR; return managedCheck(managedSettings(dir), managedFiles(dir).length) }],
```

The repo uses no `any`: settings are read through `get()` with `unknown`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts scripts/preflight.spec.ts && npx tsc -p scripts/tsconfig.json --noEmit`
Expected: PASS, and the typecheck is clean. The cell length limit is 300 characters (`cell()` truncates). The pass line is short; a warn line may truncate, which is acceptable.

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight.ts scripts/preflight.spec.ts scripts/managed.spec.ts
git commit -m "feat: preflight managed check: the 16 p.42 controls, and warnings when managed settings would switch rig off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Gate and managed metrics

**Files:**
- Modify: `scripts/metrics.ts` (after `incident_to_eval_hours`, line ~150)
- Test: `scripts/managed.spec.ts`

**Interfaces:**
- Consumes: the `.sdlc/gates.jsonl` rows from Task 3, plus `controlsInForce` (Task 4), `managedSettings` and `managedFiles` (Task 1).
- Produces:
  - `metrics.managed_controls_in_force`: `{ value: n | null, n: 16 }`. `value` is null when no managed file is found.
  - `metrics.gate_wait_hours`: the median, over every wait, of the hours from a block to the first allow that follows it in the same session.
  - `metrics.gate_violations_escaped`: `{ value: count of incidents with class: gate, n: incidents }`.

**Pairing rule** (the spec names the metric but not the rule): rows are grouped by `session`; rows with an empty session are dropped. Within a session, in file order, the first `block` opens a wait and the first `allow` after it closes the wait. Later blocks before that allow do not restart the clock. A block that is never followed by an allow is no sample. `median()` applies `MIN_SAMPLE`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/managed.spec.ts`:

```ts
test('metrics: gate waits pair a block with the next allow in the same session; escaped gate violations; managed controls', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  const row = (h: number, decision: string, session: string) => JSON.stringify({ at: new Date(Date.UTC(2026, 9, 1, h)).toISOString(), decision, session })
  write(repo, '.sdlc/gates.jsonl', [
    row(0, 'block', 'a'), row(1, 'block', 'b'), row(2, 'block', 'a'), row(3, 'allow', 'a'), row(5, 'allow', 'b'),
    row(6, 'block', 'c'), row(7, 'allow', ''), row(8, 'block', 'd'), row(9, 'allow', 'd'), row(10, 'block', 'e'),
    row(11, 'block', 'f'), row(12, 'block', 'g'), row(13, 'allow', 'f'), row(17, 'allow', 'g'), '{ torn',
  ].join('\n') + '\n')
  for (const [f, cls] of [['1-x', 'gate'], ['2-y', 'perf'], ['3-z', 'gate']]) write(repo, `.sdlc/incidents/2026100${f}.md`, `---\ndetected: 2026-10-01T00:00:00Z\nclass: ${cls}\n---\n`)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-managed-'))
  const m = JSON.parse(sdlc(repo, ['metrics', '--json'], { env: { RIG_MANAGED_DIR: empty } }).stdout).metrics
  assert.deepEqual({ value: m.gate_wait_hours.value, n: m.gate_wait_hours.n }, { value: 3, n: 5 }, 'a 3h, b 4h, d 1h, f 2h, g 5h (MIN_SAMPLE is 5); c and e never allowed; the empty session is dropped')
  assert.deepEqual({ value: m.gate_violations_escaped.value, n: m.gate_violations_escaped.n }, { value: 2, n: 3 })
  assert.equal(m.managed_controls_in_force.value, null)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-managed-'))
  fs.copyFileSync(path.join(ROOT, 'templates', 'managed-settings.json'), path.join(dir, 'managed-settings.json'))
  assert.equal(JSON.parse(sdlc(repo, ['metrics', '--json'], { env: { RIG_MANAGED_DIR: dir } }).stdout).metrics.managed_controls_in_force.value, 16)
})
```

`MIN_SAMPLE` is 5 (core.ts:86), so the test seeds five waits.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="gate waits" scripts/managed.spec.ts`
Expected: FAIL, with `m.gate_wait_hours` undefined (a TypeError on `.value`).

- [ ] **Step 3: Implement in `scripts/metrics.ts`**

Add `MANAGED_DIR, managedSettings, managedFiles` to the core import. Add `import { controlsInForce } from './preflight.ts'`. After the `m.incident_to_eval_hours = ...` statement, add:

```ts
  // Govern: the production gate's log (.sdlc/gates.jsonl, written only by the managed hook) and the managed settings on this machine.
  const waits: (number | null)[] = []
  const open = new Map<string, string>()
  for (const g of readJsonl<{ at?: string; decision?: string; session?: string }>(path.join(SDLC, 'gates.jsonl'))) {
    if (!g.session || !g.at) continue
    if (g.decision === 'block' && !open.has(g.session)) open.set(g.session, g.at)
    if (g.decision === 'allow' && open.has(g.session)) { waits.push(hours(open.get(g.session), g.at)); open.delete(g.session) }
  }
  m.gate_wait_hours = median(waits)
  m.gate_violations_escaped = { value: incidents.filter(i => i.class === 'gate').length, n: incidents.length }
  m.managed_controls_in_force = managedFiles(MANAGED_DIR).length ? { value: controlsInForce(managedSettings(MANAGED_DIR)).length, n: 16 } : { value: null, n: 16, note: 'no managed settings file on this machine' }
```

`readJsonl` must skip torn lines; the existing `readJsonl` in core.ts already does this, and the `'{ torn'` row in the test proves it. If it does not, the test fails; fix `readJsonl` there and ledger it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/managed.spec.ts scripts/sdlc.spec.ts && npx tsc -p scripts/tsconfig.json --noEmit`
Expected: PASS. If a metrics snapshot test in `sdlc.spec.ts` lists metric keys exactly, add the three keys there.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics.ts scripts/managed.spec.ts
git commit -m "feat: metrics gate_wait_hours, gate_violations_escaped and managed_controls_in_force

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: SECURITY.md, README and the design doc

**Files:**
- Modify: `SECURITY.md` (the table, plus "Do these before a team rollout" step 2, plus "Known limits")
- Modify: `README.md` (metrics list and the templates mention; find them with `grep -n "templates/\|incident_to_eval_hours\|eval_pass_rate" README.md`)
- Modify: `docs/ai-sdlc-harness-design.html` (the §5.5 managed-settings card and §10 M4 step: deviations)
- Test: `scripts/managed.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('SECURITY.md documents the managed rollout, the gate install path and its limits', () => {
  const sec = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8')
  assert.match(sec, /templates\/managed-settings\.json/)
  assert.match(sec, /production-gate\.sh[^\n]*root-owned/)
  assert.match(sec, /`\.\/path`[^\n]*settings file's (own )?folder/)
  assert.match(sec, /force-enable[^\n]*rig@/)
  assert.match(sec, /text match/i)
  assert.match(sec, /RELEASE_APPROVAL[^\n]*placeholder/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="SECURITY.md documents" scripts/managed.spec.ts`
Expected: FAIL on the first `assert.match`.

- [ ] **Step 3: Write the docs**

**SECURITY.md table.** Add a row after the "Hooks (`hooks/hooks.json`) and settings `permissions`" row:

```markdown
| Managed settings (`templates/managed-settings.json`) and the production gate (`templates/production-gate.sh`) | The platform team's layer: engineers cannot edit or override it. The template is the playbook's p.42 example plus rig's own rules, rig force-enabled (`enabledPlugins` `rig@<marketplace>`, so its hooks survive `allowManagedHooksOnly`), and the p.41 gate as the only managed hook. The gate blocks a Bash command that names `deploy` and the production environment (`RIG_PRODUCTION_ENV`) unless `RELEASE_APPROVAL` is set, and logs each matching decision to `.sdlc/gates.jsonl` (no command text). `sdlc.ts preflight` reports which of the 16 controls are in force. | The rules and hooks, no. The gate is a text match: a command that spells deploy another way, or a script that deploys, passes it. Pair it with the deploy tool's own approval (MCP scoped per environment). |
```

**Rollout step 2.** Replace it with:

```markdown
2. Run agents in Claude Code's sandbox and deploy managed settings so engineers cannot widen them: start from `templates/managed-settings.json` and tailor it (its `$comment` lists what to change). Three things in it are easy to get wrong. A rule there must use `./path`: a `/path` rule anchors at the settings file's own folder, not the repo. Force-enable rig by its full `rig@<marketplace>` ID, or `allowManagedHooksOnly` switches rig's hooks off (the mod's status under it is not documented). `allowManagedPermissionRulesOnly` drops the project's rules, so the managed file carries rig's. Install `templates/production-gate.sh` root-owned at the path the template names (outside every repo, never `.claude/hooks/`, which the model can edit). Run `sdlc.ts preflight` on a managed machine: its `managed` row lists missing controls and anything that would switch rig off.
```

**Known limits.** Add:

```markdown
- The production gate is a text match on the command, as in the playbook. `RELEASE_APPROVAL` is a placeholder for your real approval check (a change-ticket lookup): set in the shell that starts Claude Code, it is the person's assertion, not proof. The p.42 sandbox denies `GITHUB_TOKEN` and limits network domains: `gh` (used by `/rig:pr`) needs github.com, api.github.com and its own login, and `sdlc.ts evals` runs `claude -p` inside it.
```

**README.** Add `gate_wait_hours`, `gate_violations_escaped` and `managed_controls_in_force` wherever the metrics are listed. Add one line where templates are listed: "`templates/managed-settings.json` and `templates/production-gate.sh` are for the platform team's managed settings (see SECURITY.md)."

**Design doc.** In the §5.5 `templates/managed-settings.json` card, append a `<p><strong>Built (M4), deviations:</strong> …</p>` with these points:
- (a) Rules use `./path`, because `/path` anchors at the managed folder.
- (b) rig is force-enabled through `enabledPlugins` rather than its hooks being copied: force-enabled plugins' hooks survive `allowManagedHooksOnly`. The plugin no longer steps aside for project hooks under it.
- (c) The gate is `templates/production-gate.sh`, flat. `size.spec.ts` counts only top-level template files, so a `templates/gates/` folder would escape the line cap.
- (d) The gate script has no `jq` and never logs command text.
- (e) `gate_violations_escaped` is a count of `class: gate` incidents, not a before/after split.
- (f) `gates.jsonl` is gitignored (per machine, like `usage.jsonl`).

Keep each edit as an exact string replacement. Do not regex-rewrite the HTML; a regex edit truncated it once before.

- [ ] **Step 4: Run the full suite**

Run: `npm test > .superpowers/m4-final.log 2>&1; tail -20 .superpowers/m4-final.log`
Expected: all tests pass, including `size.spec.ts` (total ≤ 7900), typecheck and `claude plugin test`.

- [ ] **Step 5: Commit**

```bash
git add SECURITY.md README.md docs/ai-sdlc-harness-design.html scripts/managed.spec.ts
git commit -m "docs: managed settings rollout, the production gate's install path and limits, M4 deviations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
