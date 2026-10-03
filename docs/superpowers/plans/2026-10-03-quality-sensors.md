# Quality Sensors and Trial Defects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec 1. That means computational quality sensors over git diffs that fire at edit, at Stop, at plan, at ship and in a required CI check, plus path-scoped guides, a cross-repo impact gate and mod UX. Also fix every defect found in the 2026-10-03 trials.

**Architecture:**
- **Pure and impure code are kept apart.**
  - `model.ts` and `sensors.ts` are pure: no fs, git or process. They turn a parsed diff into findings.
  - `diffs.ts` produces diffs from git, and `runs.ts` captures command evidence.
  - `check.ts` orchestrates a check at a firing point.
  - `hooks.ts` adapts settings-hook stdin and stdout.
  - `sdlc.ts` stays the CLI entry point.
- **One entry point for every firing point.** `sdlc.ts check --at <point>` runs the same sensors at every point, which keeps local runs and CI consistent.
- **The mod is UX only.** It never does the enforcing.

**Tech Stack:**
- Node ≥ 22.18, using built-in TypeScript type stripping (erasable syntax only)
- Zero runtime dependencies
- `node:test`
- the Claude Code mods API (`claude-code`, `claude-code/testing`)
- GitHub Actions

**Spec:** `docs/superpowers/specs/2026-10-03-quality-sensors-design.md`. Trial defects are in `DESIGN.md` §10, under "Trial details".

## Global Constraints

- Node ≥ 22.18. Every script runs as `node --disable-warning=ExperimentalWarning scripts/<f>.ts`, with no build step.
- Only erasable TypeScript: no enums, namespaces or parameter properties. Relative imports carry the `.ts` extension, as in `import { x } from './core.ts'`.
- Zero runtime dependencies. The only devDependencies are `typescript` and `@types/node`.
- macOS, Linux and Windows are all supported:
  - Compare paths in POSIX form (`toPosix`).
  - Normalise CRLF to LF before parsing.
  - Run declared commands with `shell: true`.
- Size limits, enforced by a test written in Task 1:

  | File type | Max lines |
  |---|---|
  | Script file (`scripts/*.ts`, not `*.spec.ts`, not `testkit.ts`) | 500 |
  | Mod file (`hooks/*.tsx`) | 300 |
  | Skill (`skills/*/SKILL.md`) | 60 |
  | Guide (`guides/*.md`) | 60 |
- **No model calls in hooks.** Edit, Stop and SubagentStop must cost zero tokens.
- **Hooks fail open locally:** a crash is reported on stderr, the hook exits 0 and the action goes through. **CI fails closed:** `check --at ci` exits non-zero on any crash.
- **Silent success, verbose failure.**
  - A hook prints nothing when everything passes.
  - A failure prints at most 40 lines, grouped by sensor with blocks first, and each line has `file:line`, the problem and how to fix it.
- **Repos that never opted in stay silent.** No `.sdlc/` directory means every hook exits 0 with no output.
- Model IDs stay pinned as they are: `claude-sonnet-5-5`, `claude-opus-5-5` and `haiku`.
- **Tests:**
  - `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts` (`npm test` also runs `claude plugin test .`)
  - Typecheck: `npm run typecheck`
- **Commits:** end every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Allowed deviations from the spec:**
  - **More script files.** Spec §12 names three script files. This plan uses nine focused files instead, because three files cannot each stay at 500 lines or fewer, and that limit is the spec's own rule.
  - **No mod harness-tamper dialog.** The spec's mod harness-tamper dialog is replaced by the PreToolUse `ask` reason, which shows the same weakening detail. Adding the dialog as well would prompt twice.
  - **No reliance on `stop_hook_active`.** The hooks docs do not list `stop_hook_active`, so the loop cap relies only on our own counter in `.sdlc/.gate`.

## File Structure

| File | Responsibility | Pure? |
|---|---|---|
| `scripts/core.ts` | Paths, helpers, change state (`loadChange`, `activeSlug`, `createChange`), plan parsing, scope drift, secret scan of a file | no |
| `scripts/model.ts` | Diff types, `parseUnifiedDiff`, globs, `sensors.json`/`rules.json` parsing and defaults, `SECRET_PATTERNS`, `formatFindings` | **yes** |
| `scripts/sensors.ts` | Sensor functions and pattern tables: test-tamper, suppressions, layering, size, secrets, rules, contract identifiers, harness-tamper, traceability | **yes** |
| `scripts/diffs.ts` | Turn baselines (`.sdlc/.baseline`), turn and branch diffs from git, untracked snapshots, file line counts | no |
| `scripts/runs.ts` | `runCommand`, `runs.jsonl`, `verify-report` rendering, `verifiedPass` | no |
| `scripts/check.ts` | `loadConfig`, `runChecks` per point, declared commands with budget and ratchet, waivers, consumer grep, red proof, `cmdCheck`, `cmdCheckFile` | no |
| `scripts/hooks.ts` | Settings-hook adapters, gate state (`.sdlc/.gate`), guide injection, least-privilege guard | no |
| `scripts/metrics.ts` | `cmdMetrics`: playbook metrics, cost, rule fire counts, category suggestions | no |
| `scripts/sdlc.ts` | CLI: init, new, activate, status, approve, waive, scope-drift, ship, run, verify-report, skill, vendor, secrets, log-usage, hook, check, check-file, metrics | no |
| `scripts/testkit.ts` | Test helpers (temp repo, CLI runner). Never vendored. | — |
| `scripts/*.spec.ts` | `sdlc` (existing), `model`, `sensors`, `check`, `gate`, `seeded` | — |
| `hooks/hooks.json` | Settings hook entries | — |
| `hooks/register.tsx` | Mod wiring: commands, usage capture, routing | — |
| `hooks/band.tsx` | Band above the prompt and the `/sdlc-sensors` pane | — |
| `hooks/gates.tsx` | Impact-gate hold and per-edit notices | — |
| `guides/{engineering,testing,contracts}.md` | Default path-scoped guides, which onboard copies into `.sdlc/guides/` | — |
| `templates/sdlc-check.yml` | The project's required GitHub check | — |
| `skills/rule/SKILL.md` | New: draft a `rules.json` rule | — |

## Review Focus

Each of these failure modes is the one most likely to bite a real user. Each has a pinning test in the task named.

1. **The directory is not a git repo, or the repo has no commits yet.** Every hook must exit 0 silently, and `snapshot()` must return `null` (Tasks 7 and 11).
2. **Paths with spaces, or non-ASCII names, in a diff.** These come quoted or unquoted, and `parseUnifiedDiff` must produce the right `file` (Task 4).
3. **Binary files and very large diffs.** A binary diff is skipped without crashing. A diff over 1 MB must not silently become "no changes": `git()` gets a 256 MB `maxBuffer` (Tasks 4 and 7).
4. **A declared command that hangs past the Stop budget** must count as a block, and the hook must return before its 90 s timeout (Task 8).
5. **A finding that is legitimate but blocks every Stop forever.** It is capped at two blocks a turn. After that the turn is allowed, the finding is written to `unresolved.json`, and the person sees a `systemMessage` (Task 11).

---

### Task 1: Split `sdlc.ts` into focused modules (no behaviour change)

**Files:**
- Create: `scripts/core.ts`, `scripts/hooks.ts`, `scripts/metrics.ts`, `scripts/size.spec.ts`
- Modify: `scripts/sdlc.ts` (shrinks to CLI commands and dispatch), `.github/workflows/ci.yml:18`

**Interfaces:**
- Produces from `core.ts`:
  - the types `ChangeType`, `Tier`, `Stage`, `GatedStage`, `Fields`, `Change`, `Approval`, `UsageRow`, `Args`, `HookInput`
  - the constants `ROOT`, `SDLC`, `CHANGES`, `APPROVALS`, `STATE`, `USAGE`, `LIMITS`, `MIN_SAMPLE`, `SOFT_HOOK_FAILURE`, `PATHS`, `GATES`, `ARTIFACTS`
  - the helpers `exists`, `read`, `lines`, `sha`, `now`, `toPosix`, `out`, `fail`, `git`, `frontmatter`, `reportFields`, `readJsonl`, `parseArgs`, `optString`, `isChangeType`, `isTier`
  - the change and plan functions `listChanges`, `activeSlug`, `loadChange`, `nextCommand`, `planFiles`, `globToRegex`, `relPosix`, `isPlanned`, `changedFiles`, `defaultBase`, `scopeDrift`, `scanSecrets`, `planProblems`, `ensureGitignore`, `setActive`, `intentTemplate`
- Produces from `hooks.ts`: `cmdHook(args: Args): void`
- Produces from `metrics.ts`: `cmdMetrics(args: Args): void`

- [ ] **Step 1: Write the size-limit test**

Create `scripts/size.spec.ts`:

```ts
// The harness obeys its own limits (spec §12): scripts ≤ 500 lines, mod files ≤ 300, skills and guides ≤ 60.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const count = (f: string): number => fs.readFileSync(f, 'utf8').replace(/\n$/, '').split('\n').length
const filesIn = (dir: string, keep: (name: string) => boolean): string[] =>
  fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)).filter(keep).map(n => path.join(ROOT, dir, n)) : []

const LIMITS: [string, string[], number][] = [
  ['script', filesIn('scripts', n => n.endsWith('.ts') && !n.endsWith('.spec.ts') && n !== 'testkit.ts'), 500],
  ['mod file', filesIn('hooks', n => n.endsWith('.tsx')), 300],
  ['skill', filesIn('skills', () => true).map(d => path.join(d, 'SKILL.md')).filter(fs.existsSync), 60],
  ['guide', filesIn('guides', n => n.endsWith('.md')), 60],
]

for (const [kind, files, max] of LIMITS) {
  test(`every ${kind} is at most ${max} lines`, () => {
    const over = files.filter(f => count(f) > max).map(f => `${path.relative(ROOT, f)} (${count(f)})`)
    assert.deepEqual(over, [], `${kind}s over ${max} lines`)
  })
}
```

- [ ] **Step 2: Run it and see it fail on `sdlc.ts`**

Run: `node --disable-warning=ExperimentalWarning --test scripts/size.spec.ts`
Expected: FAIL, with `scripts/sdlc.ts (774)` listed under "scripts over 500 lines".

- [ ] **Step 3: Create `scripts/core.ts` by moving code verbatim**

1. Create `scripts/core.ts` starting with:

```ts
// sdlc core: paths, helpers and change state shared by every script. Zero dependencies.
// Only erasable TypeScript syntax is used (no enums, namespaces or parameter properties).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
```

2. Move these line ranges of the current `scripts/sdlc.ts` into it **verbatim**, in this order:
   - 14–65: types
   - 67–99: constants
   - 101–182: helpers
   - 184–262: changes
   - 264–322: plan parsing and scope drift
   - 324–356: secrets and plan quality
   - 360–363: `ensureGitignore`
   - 373–398: `intentTemplate` and `setActive`

3. Add `export` in front of every `type`, `const` and `function` declaration in the moved code. Exceptions:
   - `ApprovalState`, `Next`, `Metric`, `PullRequest`, `SKIPPED_FOR_S` and `SKIPPED_FOR_M` stay unexported, except where Step 4 needs `Metric` and `PullRequest`. Those two move to `metrics.ts` instead (Step 4).
   - Keep `type Metric` and `type PullRequest` out of `core.ts`.

- [ ] **Step 4: Create `scripts/metrics.ts`**

Start the file with:

```ts
// sdlc metrics: the AI-native SDLC playbook metrics plus cost, from git, gh, artifacts and usage.jsonl.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ROOT, SDLC, APPROVALS, USAGE, MIN_SAMPLE, exists, read, frontmatter, readJsonl, git, fail, out, optString, toPosix,
  listChanges, loadChange, type Args, type Approval, type Change, type UsageRow,
} from './core.ts'

type Metric = { value: number | null; n: number; note?: string; [extra: string]: unknown }
type PullRequest = {
  number: number
  createdAt: string
  mergedAt: string | null
  body?: string
  reviews?: { submittedAt?: string }[]
  statusCheckRollup?: { conclusion?: string | null; state?: string | null }[]
}
```

Then move lines 623–746 of the old `sdlc.ts` (`hours` through the end of `cmdMetrics`) verbatim, and prefix `function cmdMetrics` with `export`.

- [ ] **Step 5: Create `scripts/hooks.ts`**

Start the file with:

```ts
// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
import path from 'node:path'
import fs from 'node:fs'
import {
  SDLC, STATE, exists, read, out, fail, frontmatter, toPosix, activeSlug, loadChange, nextCommand,
  planFiles, isPlanned, relPosix, scanSecrets, planProblems, type Args, type HookInput,
} from './core.ts'
```

Then move lines 531–619 of the old `sdlc.ts` (`readStdin` through `cmdHook`) verbatim, and prefix `function cmdHook` with `export`.

- [ ] **Step 6: Shrink `scripts/sdlc.ts`**

1. Delete everything moved in Steps 3–5.
2. Replace the header and imports (lines 1–12) with:

```ts
#!/usr/bin/env node
// sdlc: the deterministic core of the sdlc plugin. Zero dependencies.
// Runs directly with Node >= 22.18 (built-in TypeScript type stripping) on macOS, Linux and Windows:
//   node --disable-warning=ExperimentalWarning scripts/sdlc.ts <command>
// Everything the model must not judge for itself lives in these scripts: change state, approvals,
// scope drift, sensors, hook decisions and metrics. This file is the CLI.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, CHANGES, APPROVALS, STATE, USAGE, LIMITS, SOFT_HOOK_FAILURE, PATHS, ARTIFACTS,
  exists, read, lines, sha, now, toPosix, out, fail, git, frontmatter, parseArgs, optString, isChangeType, isTier,
  listChanges, activeSlug, loadChange, nextCommand, defaultBase, scopeDrift, scanSecrets, planProblems,
  ensureGitignore, setActive, intentTemplate, type Args, type Approval, type Change, type Stage, type UsageRow,
} from './core.ts'
import { cmdHook } from './hooks.ts'
import { cmdMetrics } from './metrics.ts'
```

3. Leave the rest of the file as it is: `cmdInit`, `cmdNew`, `cmdActivate`, `cmdStatus`, `cmdApprove`, `cmdScopeDrift`, `cmdShip`, `cmdSecrets`, `cmdLogUsage`, the `COMMANDS` map and main.
4. Remove any import that `npm run typecheck` reports as unused.

- [ ] **Step 7: Make CI run every spec file**

In `.github/workflows/ci.yml`, replace the last line with:

```yaml
      - run: node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts
```

- [ ] **Step 8: Run all the tests and the typecheck**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: typecheck is clean. All 16 tests in `sdlc.spec.ts` pass, and all 4 size tests pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/ .github/workflows/ci.yml
git commit -m "refactor: split sdlc.ts into core, hooks and metrics modules under the 500-line limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fix trial defects 1, 3, 4 and 5 (skill fallback, stale STATE.md, gitignore, security-review remote)

**Files:**
- Create: `scripts/testkit.ts`
- Modify:
  - `scripts/core.ts`: `activeSlug`, `ensureGitignore`, and the new `clearState` and `PLUGIN_ROOT`
  - `scripts/sdlc.ts`: `cmdShip`, and the new `cmdSkill`
  - `scripts/hooks.ts`: the new `hookSkillFailed`, and the session-start text
  - `hooks/hooks.json`
  - `skills/review/SKILL.md`
- Test: `scripts/sdlc.spec.ts`, `scripts/gate.spec.ts` (new)

**Interfaces:**
- Consumes: Task 1's `core.ts` exports.
- Produces:
  - `core.ts`:
    - `PLUGIN_ROOT: string`, the plugin directory (the parent of `scripts/`)
    - `clearState(shipped: string): void`
    - `HookInput` extended to `{ session_id?, agent_id?, agent_type?, source?, tool_input?: { command?, file_path?, notebook_path?, content?, old_string?, new_string?, replace_all?, skill?, args? } }`
  - `sdlc.ts`: `skill <name> [args]`, which prints the skill body with `${CLAUDE_PLUGIN_ROOT}`, `$ARGUMENTS` and `$0` substituted.
  - `testkit.ts`: `makeRepo(): string`, `sdlc(repo, args, opts?)`, `hook(repo, name, payload)`, `write(repo, rel, text)`, `gitIn(repo, ...args): string`.

- [ ] **Step 1: Create the shared test kit**

Create `scripts/testkit.ts`:

```ts
// Test helpers shared by the spec files. Never vendored into projects.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'

export const SCRIPT = path.resolve(import.meta.dirname, 'sdlc.ts')

export function gitIn(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

export function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-test-'))
  gitIn(repo, 'init', '-q', '-b', 'main')
  gitIn(repo, 'config', 'user.email', 't@example.com')
  gitIn(repo, 'config', 'user.name', 'Tester')
  write(repo, 'README.md', 'hi\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'init')
  return repo
}

export function write(repo: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), text)
}

export function sdlc(repo: string, args: string[], { input, env = {} }: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
    cwd: repo, input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo, SDLC_HUMAN: '', ...env },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

export const hook = (repo: string, name: string, payload: unknown) => sdlc(repo, ['hook', name], { input: JSON.stringify(payload) })
```

- [ ] **Step 2: Write the failing tests**

Append to `scripts/sdlc.spec.ts`:

```ts
test('ship clears STATE.md, stages it and .sdlc/.gitignore, and leaves no active change', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write('src/app.js', 'x\n')
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n## Verification\n- npm test\n')
  write('.sdlc/changes/tiny/verification.md', '---\nresult: pass\n---\n')
  const shipped = run(['ship', 'tiny', '--message', 'chore: tiny'])
  assert.equal(shipped.code, 0, shipped.stderr)
  const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  assert.match(files, /\.sdlc\/STATE\.md/)
  assert.match(files, /\.sdlc\/\.gitignore/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/STATE.md'), 'utf8'), /No active change\. Last shipped: tiny\./)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '')
  assert.doesNotMatch(run(['status']).stdout, /next: /)
})

test('activeSlug never falls back to a finished change', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write('src/app.js', 'x\n')
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  write('.sdlc/changes/tiny/verification.md', '---\nresult: pass\n---\n')
  run(['ship', 'tiny', '--message', 'chore: tiny'])
  fs.rmSync(path.join(repo, '.sdlc/STATE.md'))
  assert.doesNotMatch(run(['status']).stdout, /▶ tiny/)
})

test('skill prints a stage skill with plugin root and arguments substituted', () => {
  const r = run(['skill', 'verify', 'add-login'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /# Verify add-login/)
  assert.doesNotMatch(r.stdout, /\$\{CLAUDE_PLUGIN_ROOT\}/)
  assert.doesNotMatch(r.stdout, /^---\nname:/)
  assert.notEqual(run(['skill', 'no-such-skill']).code, 0)
})
```

Also edit the existing `new writes .sdlc/.gitignore` test so its expected value reads `'usage.jsonl\n.baseline\n.gate\nunresolved.json\n'`.

Create `scripts/gate.spec.ts`:

```ts
// Hook behaviour: skill fallback, baselines, the Stop gate, guides and least privilege.
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
  const r = hook(repo, 'skill-failed', { tool_input: { skill: 'sdlc:review', args: 'add-login' } })
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /sdlc\.ts" skill review add-login/)
  assert.match(ctx, /skill fallback: sdlc:review/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8'), /skill-load-failed/)
  assert.equal(hook(repo, 'skill-failed', { tool_input: { skill: 'superpowers:brainstorming' } }).stdout, '')
})
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sdlc.spec.ts scripts/gate.spec.ts`
Expected: FAIL. The new ship test fails on `/\.sdlc\/STATE\.md/`, `skill` reports an unknown command, `hook skill-failed` reports an unknown hook, and the gitignore content differs.

- [ ] **Step 4: Implement in `core.ts`**

Replace `ensureGitignore` and `activeSlug`, and add `PLUGIN_ROOT` and `clearState`:

```ts
export const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
const GITIGNORED = ['usage.jsonl', '.baseline', '.gate', 'unresolved.json']

export function ensureGitignore(): void {
  if (!exists(SDLC)) return
  const ignore = path.join(SDLC, '.gitignore')
  const have = new Set(read(ignore).split('\n').filter(Boolean))
  const missing = GITIGNORED.filter(f => !have.has(f))
  if (missing.length) fs.appendFileSync(ignore, missing.join('\n') + '\n')
}

// STATE.md decides when it names a change, even an empty one (after ship). Only a missing STATE.md
// falls back to the most recently touched change that is still unfinished.
export function activeSlug(): string | null {
  const { data } = frontmatter(read(STATE))
  if ('change' in data) return data.change && exists(path.join(CHANGES, data.change)) ? data.change : null
  const byMtime = listChanges()
    .filter(slug => loadChange(slug).next !== null)
    .map(slug => ({ slug, t: fs.statSync(path.join(CHANGES, slug)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return byMtime[0]?.slug ?? null
}

export function clearState(shipped: string): void {
  fs.writeFileSync(STATE, `---\nchange:\n---\n# State\n\nNo active change. Last shipped: ${shipped}.\n`)
}
```

Extend `HookInput` in `core.ts`:

```ts
export type HookInput = {
  session_id?: string
  agent_id?: string
  agent_type?: string
  source?: string
  tool_input?: {
    command?: string
    file_path?: string
    notebook_path?: string
    content?: string
    old_string?: string
    new_string?: string
    replace_all?: boolean
    skill?: string
    args?: string
  }
}
```

In `UsageRow`, widen `kind` to `'main' | 'agent' | 'event'`, and add the optional fields `event?: string`, `skill?: string` and `rule?: string`.

- [ ] **Step 5: Implement in `sdlc.ts`**

In `cmdShip`, replace the line `const extras = ['.sdlc/approvals.jsonl', '.sdlc/.gitignore'].filter(...)` with these lines (`clearState` comes first, so the cleared file is staged):

```ts
  clearState(slug)
  const extras = ['.sdlc/approvals.jsonl', '.sdlc/.gitignore', '.sdlc/STATE.md'].filter(f => exists(path.join(ROOT, f)))
```

Add `clearState` and `PLUGIN_ROOT` to the import from `./core.ts`, then add:

```ts
// Deterministic fallback when the Skill tool fails to load a stage skill (seen in `claude -p`):
// prints the same instructions the skill would have loaded.
function cmdSkill(args: Args): void {
  const [name, ...rest] = args.pos
  const skills = path.join(PLUGIN_ROOT, 'skills')
  const file = path.join(skills, name ?? '', 'SKILL.md')
  if (!name || !exists(file)) fail(`no skill named ${name ?? ''}; one of ${exists(skills) ? fs.readdirSync(skills).join(', ') : '(none here)'}`)
  const body = frontmatter(read(file)).body
  out(body.replaceAll('${CLAUDE_PLUGIN_ROOT}', toPosix(PLUGIN_ROOT)).replaceAll('$ARGUMENTS', rest.join(' ')).replace(/\$0\b/g, rest[0] ?? ''))
}
```

Register `skill: cmdSkill` in `COMMANDS`.

- [ ] **Step 6: Implement in `hooks.ts`**

Add `USAGE`, `now` and `PLUGIN_ROOT` to the core import, then add:

```ts
// A stage skill that fails to load leaves the model to improvise. Hand it the exact instructions instead.
function hookSkillFailed(input: HookInput): void {
  if (!exists(SDLC)) return
  const skill = String(input.tool_input?.skill ?? '')
  const m = /^sdlc:([a-z-]+)$/.exec(skill)
  if (!m) return
  fs.appendFileSync(USAGE, JSON.stringify({ at: now(), kind: 'event', event: 'skill-load-failed', skill }) + '\n')
  const cmd = `node --disable-warning=ExperimentalWarning "${toPosix(PLUGIN_ROOT)}/scripts/sdlc.ts" skill ${m[1]} ${input.tool_input?.args ?? ''}`.trim()
  const context = `The ${skill} skill failed to load. Run \`${cmd}\` and follow the printed steps exactly, as if the skill had loaded. Say "skill fallback: ${skill}" in your reply.`
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: context } }))
}
```

Register `'skill-failed': hookSkillFailed` in `HOOKS`. In `hookSessionStart`, append this line to the `Rules:` string:

` If a /sdlc:* skill fails to load, run \`node "${toPosix(PLUGIN_ROOT)}/scripts/sdlc.ts" skill <stage> <slug>\` and follow it exactly.`

- [ ] **Step 7: Register the hook**

In `hooks/hooks.json`, add this key alongside `PostToolUse`:

```json
    "PostToolUseFailure": [
      { "matcher": "Skill", "hooks": [ { "type": "command", "command": "node --disable-warning=ExperimentalWarning \"${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts\" hook skill-failed", "timeout": 10 } ] }
    ]
```

- [ ] **Step 8: Make the security-review remote check deterministic (defect 5)**

In `skills/review/SKILL.md`:
1. Change the frontmatter `allowed-tools` to add `Bash(git remote*)`.
2. Replace the sentence "That skill needs a git remote to diff against. If the repo has none, instead tell the reviewer…" with:

```
Run `git remote get-url origin` first. If it fails, the repo has no remote and `/security-review` cannot diff: tell the reviewer to treat security as its first priority instead, and say so in `review.md`.
```

- [ ] **Step 9: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: everything passes.

- [ ] **Step 10: Commit**

```bash
git add scripts/ hooks/hooks.json skills/review/SKILL.md
git commit -m "fix: clear and stage STATE.md at ship, deterministic skill fallback, remote check for security-review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Captured runs and generated verification (defect 2), and protecting evidence

**Files:**
- Create: `scripts/runs.ts`
- Modify:
  - `scripts/core.ts`: `loadChange` verify rule, and the new `EVIDENCE_RE`
  - `scripts/sdlc.ts`: the new `cmdRun` and `cmdVerifyReport`
  - `scripts/hooks.ts`: the evidence guard
  - `scripts/testkit.ts`: the new `verified`
  - `skills/start/SKILL.md`, `skills/build/SKILL.md`, `skills/verify/SKILL.md`, `skills/diagnose/SKILL.md`, `agents/verifier.md`
- Test: `scripts/sdlc.spec.ts`, `scripts/gate.spec.ts`

**Interfaces:**
- Produces from `runs.ts`:
  - `type RunRow = { at: string; cmd: string; cwd?: string; exit: number; ms: number; tail: string; expectFail?: true; timedOut?: true; source?: 'gate' | 'ship' }`. Rows tagged `source` came from the gate or the ship checks, and never count toward verification.
  - `runCommand(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): RunRow`
  - `runsFile(slug: string): string`
  - `recordRun(slug: string, row: RunRow): void`
  - `readRuns(slug: string): RunRow[]`
  - `renderVerification(rows: RunRow[], digest: string): { text: string; result: 'pass' | 'fail' }`
  - `verifiedPass(dir: string): boolean`
  - `runsDigest(slug: string, count: number): string`
- Produces from `core.ts`: `EVIDENCE_RE: RegExp`
- Produces from `testkit.ts`: `verified(repo: string, slug: string): void`, which records one passing run and generates `verification.md`
- CLI:
  - `sdlc.ts run [--slug s] [--expect-fail] -- "<command>"`: exits with the command's exit code, or, with `--expect-fail`, exits 0 when the command failed
  - `sdlc.ts verify-report [slug]`: writes `verification.md`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/testkit.ts`:

```ts
export function verified(repo: string, slug: string): void {
  sdlc(repo, ['run', '--slug', slug, '--', 'node -e "process.exit(0)"'])
  sdlc(repo, ['verify-report', slug])
}
```

Append to `scripts/sdlc.spec.ts`:

```ts
test('run records exit codes; verify-report generates verification.md; a hand-written pass does not count', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write('.sdlc/changes/tiny/verification.md', '---\nresult: pass\n---\n')
  assert.match(run(['status']).stdout, /next: \/sdlc:verify tiny/)

  const red = run(['run', '--expect-fail', '--', 'node -e "process.exit(3)"'])
  assert.equal(red.code, 0)
  const bad = run(['run', '--', 'node -e "process.exit(2)"'])
  assert.equal(bad.code, 2)
  const rows = fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/runs.jsonl'), 'utf8').trim().split('\n').map(r => JSON.parse(r))
  assert.deepEqual(rows.map(r => [r.exit, Boolean(r.expectFail)]), [[3, true], [2, false]])

  run(['verify-report', 'tiny'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8'), /result: fail/)
  run(['run', '--', 'node -e "process.exit(0)"'])
  run(['verify-report', 'tiny'])
  assert.match(run(['status']).stdout, /next: \/sdlc:ship tiny/)

  run(['run', '--', 'node -e "process.exit(1)"'])
  assert.match(run(['status']).stdout, /next: \/sdlc:ship tiny/, 'runs appended after the report do not invalidate it')
})

test('verification judges only the plan commands, ignoring gate rows and abandoned exploratory runs', () => {
  run(['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write('.sdlc/changes/tiny/plan.md', '## Files\n- src/**\n## Verification\n- `node -e "process.exit(0)"`\n')
  write('.sdlc/changes/tiny/runs.jsonl', JSON.stringify({ at: 'x', cmd: 'eslint .', exit: 1, ms: 1, tail: '', source: 'gate' }) + '\n')
  run(['run', '--', 'node -e "process.exit(4)"'])
  run(['verify-report', 'tiny'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8'), /result: fail[\s\S]*Not run/)
  run(['run', '--', 'node -e "process.exit(0)"'])
  run(['verify-report', 'tiny'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/tiny/verification.md'), 'utf8'), /result: pass/)
})
```

**Then update every existing test in `sdlc.spec.ts` (other than the one just added)** that writes `.sdlc/changes/<slug>/verification.md` by hand with `result: pass`:
- Replace that `write(...)` call with `verified(repo, '<slug>')`.
- Import `verified` from `./testkit.ts`.
- **Exception:** the test `verification result in the body still counts…` is renamed to `ship commits code plus artifacts on a branch`, and its `write` of `**result:** pass` is replaced with `verified(repo, 'tiny')`.

Append to `scripts/gate.spec.ts`:

```ts
test('evidence files are human- or script-only: model edits and Bash writes are denied, reads allowed', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  for (const f of ['.sdlc/changes/tiny/runs.jsonl', '.sdlc/waivers.jsonl', '.sdlc/.gate', '.sdlc/.baseline', '.sdlc/unresolved.json']) {
    const edit = JSON.parse(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, f) } }).stdout)
    assert.equal(edit.hookSpecificOutput.permissionDecision, 'deny', f)
  }
  const append = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: `echo '{"exit":0}' >> .sdlc/changes/tiny/runs.jsonl` } }).stdout)
  assert.equal(append.hookSpecificOutput.permissionDecision, 'deny')
  const waive = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: 'node /x/scripts/sdlc.ts waive size * because' } }).stdout)
  assert.equal(waive.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'tail -5 .sdlc/changes/tiny/runs.jsonl' } }).stdout, '')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'node /x/scripts/sdlc.ts run -- "npm test"' } }).stdout, '')
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sdlc.spec.ts scripts/gate.spec.ts`
Expected: FAIL. `run` is an unknown command, the hand-written pass still counts, and edits to `runs.jsonl` are not denied.

- [ ] **Step 3: Create `scripts/runs.ts`**

```ts
// Captured evidence: every verdict reads exit codes recorded here, never what the model says happened.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, CHANGES, now, read, sha, frontmatter, readJsonl } from './core.ts'

export type RunRow = { at: string; cmd: string; cwd?: string; exit: number; ms: number; tail: string; expectFail?: true; timedOut?: true; source?: 'gate' | 'ship' }

const TAIL_LINES = 30
const TIMED_OUT = 124

// spawnSync's own timeout kills only the shell, then waits for any grandchild still holding stdout
// (npm test -> node, jest workers). This wrapper runs the command in its own process group and kills
// the whole group on timeout (taskkill /T on Windows), so a hang can never outlive the budget.
const WRAPPER = `
const cp = require('node:child_process')
const [cmd, ms] = process.argv.slice(1)
const win = process.platform === 'win32'
const child = cp.spawn(cmd, { shell: true, detached: !win, stdio: ['ignore', 'inherit', 'inherit'] })
const kill = () => { try { win ? cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']) : process.kill(-child.pid, 'SIGKILL') } catch {} }
const timer = setTimeout(() => { kill(); process.exit(${TIMED_OUT}) }, Number(ms))
child.on('exit', code => { clearTimeout(timer); process.exit(code ?? 1) })
child.on('error', () => process.exit(127))
`

export function runCommand(cmd: string, opts: { cwd?: string; timeoutMs?: number } = {}): RunRow {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 600_000
  const r = spawnSync(process.execPath, ['-e', WRAPPER, cmd, String(timeoutMs)], { cwd: opts.cwd ?? ROOT, encoding: 'utf8', timeout: timeoutMs + 5_000, maxBuffer: 64 * 1024 * 1024 })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\r\n/g, '\n').trimEnd()
  const ms = Date.now() - started
  const timedOut = (r.status === TIMED_OUT && ms >= timeoutMs) || (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  const row: RunRow = { at: now(), cmd, exit: r.status ?? TIMED_OUT, ms, tail: text.split('\n').slice(-TAIL_LINES).join('\n') }
  if (opts.cwd && opts.cwd !== ROOT) row.cwd = opts.cwd
  if (timedOut) row.timedOut = true
  return row
}

export const runsFile = (slug: string): string => path.join(CHANGES, slug, 'runs.jsonl')
export const readRuns = (slug: string): RunRow[] => readJsonl<RunRow>(runsFile(slug))

export function recordRun(slug: string, row: RunRow): void {
  fs.mkdirSync(path.dirname(runsFile(slug)), { recursive: true })
  fs.appendFileSync(runsFile(slug), JSON.stringify(row) + '\n')
}

const norm = (cmd: string): string => cmd.trim().replace(/\s+/g, ' ')

// The verdict is the latest explicit run of each plan ## Verification command (or of every explicit command
// when the plan lists none). Expect-fail rows are evidence of red, and gate/ship rows are the sensors' own runs:
// neither is a verdict, so a known-red lint at Stop or an abandoned exploratory run cannot poison verification.
export function renderVerification(rows: RunRow[], digest: string, planned: string[] = []): { text: string; result: 'pass' | 'fail' } {
  const latest = new Map<string, RunRow>()
  for (const r of rows) if (!r.expectFail && !r.source) latest.set(norm(r.cmd), r)
  const wanted = planned.map(norm)
  const verdicts = wanted.length ? wanted.flatMap(c => latest.get(c) ?? []) : [...latest.values()]
  const notRun = wanted.filter(c => !latest.has(c))
  const result = verdicts.length > 0 && notRun.length === 0 && verdicts.every(r => r.exit === 0) ? 'pass' : 'fail'
  const fence = (t: string): string => '```\n' + t + '\n```'
  const red = rows.filter(r => r.expectFail)
  const text = [
    '---', `result: ${result}`, `verified: ${now()}`, 'generated: sdlc', `runs: ${rows.length}`, `digest: ${digest}`, '---',
    '# Verification', '', 'Generated by `sdlc.ts verify-report` from runs.jsonl. Do not edit by hand.', '',
    '## Commands',
    ...verdicts.flatMap(r => [`- \`${r.cmd}\` → exit ${r.exit}${r.timedOut ? ' (timed out)' : ''} in ${r.ms} ms`, fence(r.tail)]),
    ...(red.length ? ['', '## Red runs (expected to fail)', ...red.map(r => `- \`${r.cmd}\` → exit ${r.exit}`)] : []),
    ...(notRun.length ? ['', '## Not run (listed in plan ## Verification)', ...notRun.map(c => `- \`${c}\``)] : []),
    verdicts.length ? '' : '\nNo commands were run: record them with `sdlc.ts run -- "<command>"`.',
  ].join('\n')
  return { text: text + '\n', result }
}

export const runsDigest = (slug: string, count: number): string => sha(read(runsFile(slug)).split('\n').slice(0, count).join('\n'))

// verification.md counts only when sdlc generated it and the runs it summarised are unchanged.
export function verifiedPass(dir: string): boolean {
  const { data } = frontmatter(read(path.join(dir, 'verification.md')))
  if (data.generated !== 'sdlc' || data.result !== 'pass') return false
  return runsDigest(path.basename(dir), Number(data.runs)) === data.digest
}
```

- [ ] **Step 4: Use `verifiedPass` in `loadChange`**

`runs.ts` imports `core.ts`, so to avoid a cycle the rule is inlined in `core.ts`. In `core.ts` `loadChange`, replace `case 'verify': return verification.result === 'pass'` with:

```ts
      case 'verify': {
        // Only a report sdlc generated from runs.jsonl counts (see runs.ts renderVerification).
        const v = frontmatter(read(path.join(dir, 'verification.md'))).data
        const runs = read(path.join(dir, 'runs.jsonl')).split('\n').slice(0, Number(v.runs)).join('\n')
        return v.generated === 'sdlc' && v.result === 'pass' && sha(runs) === v.digest
      }
```

Then add to `core.ts`:

```ts
// Evidence and gate state: written only by sdlc itself or the person's mod commands.
export const EVIDENCE_RE = /approvals\.jsonl|waivers\.jsonl|runs\.jsonl|\.sdlc[\\/](?:\.baseline|\.gate|unresolved\.json)/
```

- [ ] **Step 5: Add the commands to `sdlc.ts`**

```ts
// `run` takes its command after `--`, as one quoted argument: sdlc.ts run [--slug s] [--expect-fail] -- "npm test"
function cmdRun(): void {
  const argv = process.argv.slice(3)
  const dash = argv.indexOf('--')
  if (dash < 0 || dash === argv.length - 1) fail('usage: run [--slug s] [--expect-fail] -- "<command>"')
  const head = parseArgs(argv.slice(0, dash))
  const cmd = argv.slice(dash + 1).join(' ')
  const slug = optString(head, 'slug') ?? activeSlug()
  if (!slug) fail('no active change: run /sdlc:start first, or pass --slug')
  const expectFail = Boolean(head.opt['expect-fail'])
  const row = runCommand(cmd)
  recordRun(slug, expectFail ? { ...row, expectFail: true } : row)
  if (row.tail) out(row.tail)
  out(`sdlc run: exit ${row.exit}${row.timedOut ? ' (timed out)' : ''} in ${row.ms} ms, recorded in ${slug}/runs.jsonl`)
  process.exitCode = expectFail ? (row.exit !== 0 ? 0 : 1) : row.exit
}

function cmdVerifyReport(args: Args): void {
  const slug = args.pos[0] ?? activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail('usage: verify-report <slug>')
  const rows = readRuns(slug)
  const { text, result } = renderVerification(rows, runsDigest(slug, rows.length), planVerification(slug))
  fs.writeFileSync(path.join(CHANGES, slug, 'verification.md'), text)
  out(`verification ${result}: ${rows.length} recorded run(s). Next: ${nextCommand(loadChange(slug))}`)
}
```

Import `runCommand`, `recordRun`, `readRuns`, `renderVerification` and `runsDigest` from `./runs.ts`. Add `planVerification` to `core.ts`, next to `planFiles`, and import it:

```ts
// The plan's ## Verification commands: backticked text, or the rest of the bullet.
export function planVerification(slug: string): string[] {
  const body = read(path.join(CHANGES, slug, 'plan.md'))
  const m = /^##\s+Verification\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body)
  return (m?.[1] ?? '').split('\n').map(row => /^\s*[-*]\s+(?:`([^`]+)`|(.+))$/.exec(row)).filter((x): x is RegExpExecArray => Boolean(x)).map(x => (x[1] ?? x[2] ?? '').trim())
}
``` Register `run: () => cmdRun()` and `'verify-report': cmdVerifyReport`.

- [ ] **Step 6: Guard the evidence in `hooks.ts`**

Replace `SAFE_APPROVALS_COMMAND`, `isSafeApprovalsCommand` and the first `if` of `hookPreBash`, and the approvals check in `hookPreEdit`, as follows:

```ts
// git (staging, committing, inspecting) and read-only viewers may name evidence; nothing that can write to it may.
const SAFE_EVIDENCE_COMMAND = /^\s*(?:git\s+(?:add|commit|status|diff|log|show)|cat|head|tail|wc|grep|rg|jq)\b/
const HUMAN_ONLY = /sdlc\.(?:m?js|ts)["']?\s+(?:approve|waive)\b/

function isSafeEvidenceCommand(cmd: string): boolean {
  return cmd
    .split(/&&|\|\||;|\|/)
    .filter(part => EVIDENCE_RE.test(part))
    .every(part => SAFE_EVIDENCE_COMMAND.test(part) && !WRITES.test(part.replace(/^\s*git\s+commit\b[^]*?-m\s+(["']).*?\1/, '')))
}
```

In `hookPreBash`, the first check becomes:

```ts
  if (HUMAN_ONLY.test(cmd) || (EVIDENCE_RE.test(cmd) && !isSafeEvidenceCommand(cmd))) {
    return decide('deny', 'Evidence is human- or sdlc-only: approvals and waivers come from the person (/sdlc-approve, /sdlc-waive); runs.jsonl only from `sdlc.ts run`; gate state only from the hooks. Read these files with the Read tool.')
  }
```

In `hookPreEdit`, replace the `approvals.jsonl` check with:

```ts
  if (EVIDENCE_RE.test(toPosix(file))) {
    return decide('deny', `${relPosix(file)} is evidence written only by sdlc or the person's commands. Record runs with \`sdlc.ts run -- "<command>"\`.`)
  }
```

Import `EVIDENCE_RE` from `./core.ts`.

- [ ] **Step 7: Update the skills and the verifier to use captured runs**

1. **`agents/verifier.md`.** Replace steps 2–4 and the code block with:

```
2. Run each command through the recorder, exactly as written:
   `node --disable-warning=ExperimentalWarning <plugin>/scripts/sdlc.ts run --slug <slug> -- "<command>"`
   The script records the real exit code and output; never report an exit code you did not see.
3. Check each acceptance criterion against the output. A criterion with no command that proves it is **unverified**.
4. Generate the report: `node ... sdlc.ts verify-report <slug>`. Never write verification.md yourself.
```

   Then change the last line to: `Reply with the result line from verify-report, the failing items, and any unverified criteria.`
2. **`skills/verify/SKILL.md`, the tier S/M bullet.** Replace it with: `**Tier S and M:** run each of the plan's \`## Verification\` commands through \`node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run -- "<command>"\`, then \`... sdlc.ts verify-report $0\`. Then skip to step 3.`
3. **`skills/start/SKILL.md` step 5.3 and `skills/build/SKILL.md` "Small builds" step 3.** Replace the "Write `verification.md`…" sentence with: `Run each \`## Verification\` command through \`sdlc.ts run -- "<command>"\`, then generate \`verification.md\` with \`sdlc.ts verify-report <slug>\`. Never write it by hand.`
4. **`skills/build/SKILL.md` "Small builds" step 1, and `skills/diagnose/SKILL.md` step 1.** Add: `Run the new failing test once with \`sdlc.ts run --expect-fail -- "<test command>"\` so the red run is on record.`

- [ ] **Step 8: Run all the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: everything passes, including the size tests and skills at 60 lines or fewer.

- [ ] **Step 9: Commit**

```bash
git add scripts/ skills/ agents/verifier.md
git commit -m "fix: verdicts come from captured runs; verification.md is generated; evidence is model-proof

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pure diff model, globs, config and finding format (`model.ts`)

**Files:**
- Create: `scripts/model.ts`, `scripts/model.spec.ts`
- Modify: `scripts/core.ts`. Delete its `globToRegex` and `SECRET_PATTERNS`, then import them from `./model.ts` and re-export `globToRegex`.

**Interfaces:**
- Produces from `model.ts`, all pure:
  - types:
    - `Line = { n: number; text: string }`
    - `FileStatus = 'A'|'M'|'D'|'R'`
    - `FileDiff = { file: string; from?: string; status: FileStatus; added: Line[]; removed: Line[]; binary?: true }`
    - `Severity = 'block'|'warn'`
    - `Finding = { sensor: string; severity: Severity; file?: string; line?: number; message: string; fix: string; labels?: string[] }`
    - `Consumer = { name: string; path: string; repo?: string; test?: string }`
    - `Layer = { from: string; mustNotImport: string[]; why: string }`
    - `Rule = { id: string; pattern: string; paths?: string[]; message: string; why: string; action: Severity }`
    - `SensorConfig = { fast: Record<string,string>; full: Record<string,string>; tests: string[]; ignore: string[]; contracts: string[]; consumers: Consumer[]; layers: Layer[]; limits: { fileLines: number; diffLines: number }; knownRed: string[] }`
  - values:
    - `DEFAULT_CONFIG: SensorConfig`
    - `globToRegex(glob: string): RegExp`
    - `matchesAny(file: string, globs: string[]): boolean`
    - `isTest(file: string, cfg: SensorConfig): boolean`
    - `isSource(file: string, cfg: SensorConfig): boolean`
    - `parseUnifiedDiff(text: string): FileDiff[]`
    - `parseConfig(text: string): { config: SensorConfig; errors: string[] }`
    - `parseRules(text: string): { rules: Rule[]; errors: string[] }`
    - `SECRET_PATTERNS: [string, RegExp][]`
    - `formatFindings(findings: Finding[], max?: number): string`

- [ ] **Step 1: Write the failing tests**

Create `scripts/model.spec.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnifiedDiff, globToRegex, matchesAny, parseConfig, parseRules, formatFindings, DEFAULT_CONFIG, type Finding } from './model.ts'

test('parses a modified file with added and removed line numbers', () => {
  const d = parseUnifiedDiff('diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -3 +3,2 @@\n-old\n+new\n+more\n')
  assert.deepEqual(d, [{ file: 'src/a.js', status: 'M', added: [{ n: 3, text: 'new' }, { n: 4, text: 'more' }], removed: [{ n: 3, text: 'old' }] }])
})

test('parses new, deleted, renamed and binary files', () => {
  const text = [
    'diff --git a/n.js b/n.js', 'new file mode 100644', '--- /dev/null', '+++ b/n.js', '@@ -0,0 +1 @@', '+x',
    'diff --git a/d.js b/d.js', 'deleted file mode 100644', '--- a/d.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-y',
    'diff --git a/old.js b/new.js', 'similarity index 90%', 'rename from old.js', 'rename to new.js', '--- a/old.js', '+++ b/new.js', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ',
  ].join('\n')
  const d = parseUnifiedDiff(text)
  assert.deepEqual(d.map(f => [f.file, f.status, f.from ?? null, Boolean(f.binary)]), [
    ['n.js', 'A', null, false], ['d.js', 'D', null, false], ['new.js', 'R', 'old.js', false], ['img.png', 'M', null, true],
  ])
  assert.equal(d[1]?.removed[0]?.text, 'y')
})

test('handles quoted non-ASCII paths, paths with spaces and CRLF', () => {
  const quoted = parseUnifiedDiff('diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\r\n--- "a/caf\\303\\251.js"\r\n+++ "b/caf\\303\\251.js"\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')
  assert.equal(quoted[0]?.file, 'café.js')
  assert.equal(quoted[0]?.added[0]?.text, 'b')
  const spaced = parseUnifiedDiff('diff --git a/my dir/x y.js b/my dir/x y.js\n--- a/my dir/x y.js\t\n+++ b/my dir/x y.js\t\n@@ -1 +1 @@\n-a\n+b\n')
  assert.equal(spaced[0]?.file, 'my dir/x y.js')
})

test('a hunk line starting with --- or +++ is content, not a header', () => {
  const d = parseUnifiedDiff('diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n---- old rule\n++++ new rule\n')
  assert.deepEqual([d[0]?.removed[0]?.text, d[0]?.added[0]?.text], ['--- old rule', '+++ new rule'])
})

test('globs: ** spans directories without matching partial names', () => {
  assert.ok(globToRegex('**/test/**').test('test/a.js'))
  assert.ok(globToRegex('**/test/**').test('pkg/test/a.js'))
  assert.ok(!globToRegex('**/test/**').test('latest/a.js'))
  assert.ok(globToRegex('**/*.test.*').test('src/a.test.ts'))
  assert.ok(globToRegex('tests/**').test('tests/x/y.js'))
  assert.ok(globToRegex('src/**/*.ts').test('src/a.ts'))
  assert.ok(matchesAny('../checkout-service/src/a.ts', ['../checkout-service/**']))
})

test('config: defaults, merging and validation errors', () => {
  assert.deepEqual(parseConfig('').config, DEFAULT_CONFIG)
  const ok = parseConfig(JSON.stringify({ fast: { test: 'npm test' }, limits: { diffLines: 300 } }))
  assert.deepEqual([ok.errors, ok.config.fast.test, ok.config.limits.diffLines, ok.config.limits.fileLines], [[], 'npm test', 300, 400])
  assert.match(parseConfig('{nope').errors[0] ?? '', /not valid JSON/)
  assert.match(parseConfig(JSON.stringify({ layers: [{ from: 'src/**', mustNotImport: ['x'] }] })).errors[0] ?? '', /needs a why/)
  assert.match(parseConfig(JSON.stringify({ limit: {} })).errors[0] ?? '', /unknown key "limit"/)
  assert.match(parseConfig(JSON.stringify({ limits: { fileLines: -1 } })).errors[0] ?? '', /positive/)
})

test('rules: why is required and patterns must compile', () => {
  const good = parseRules(JSON.stringify([{ id: 'no-print', pattern: 'print\\(', message: 'use the logger', why: 'stdout is the protocol', action: 'block' }]))
  assert.deepEqual([good.errors, good.rules.length], [[], 1])
  assert.match(parseRules(JSON.stringify([{ id: 'x', pattern: 'a', message: 'm', action: 'warn' }])).errors[0] ?? '', /why/)
  assert.match(parseRules(JSON.stringify([{ id: 'x', pattern: '(', message: 'm', why: 'w', action: 'warn' }])).errors[0] ?? '', /pattern/)
})

test('findings: silent when empty, blocks first, deduplicated, capped, warns summarised', () => {
  assert.equal(formatFindings([]), '')
  const b = (i: number): Finding => ({ sensor: 'layering', severity: 'block', file: 'src/a.ts', line: i, message: `m${i}`, fix: 'f' })
  const w: Finding = { sensor: 'size', severity: 'warn', file: 'src/big.ts', message: 'big', fix: 'split' }
  const text = formatFindings([w, b(1), b(1), b(2)])
  assert.match(text.split('\n')[0] ?? '', /\[layering\]/)
  assert.equal(text.match(/✗/g)?.length, 2)
  assert.match(text, /warn: 1 \(size 1\)/)
  const many = formatFindings(Array.from({ length: 60 }, (_, i) => b(i)), 40)
  assert.equal(many.split('\n').length, 40)
  assert.match(many, /… 22 more/)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/model.spec.ts`
Expected: FAIL, with `Cannot find module './model.ts'`.

- [ ] **Step 3: Implement `scripts/model.ts`**

```ts
// The pure data model for sensors: diffs, globs, config, rules and findings. No fs, git or process access.
export type Line = { n: number; text: string }
export type FileStatus = 'A' | 'M' | 'D' | 'R'
export type FileDiff = { file: string; from?: string; status: FileStatus; added: Line[]; removed: Line[]; binary?: true }
export type Severity = 'block' | 'warn'
export type Finding = { sensor: string; severity: Severity; file?: string; line?: number; message: string; fix: string; labels?: string[] }
export type Consumer = { name: string; path: string; repo?: string; test?: string }
export type Layer = { from: string; mustNotImport: string[]; why: string }
export type Rule = { id: string; pattern: string; paths?: string[]; message: string; why: string; action: Severity }
export type SensorConfig = {
  fast: Record<string, string>
  full: Record<string, string>
  tests: string[]
  ignore: string[]
  contracts: string[]
  consumers: Consumer[]
  layers: Layer[]
  limits: { fileLines: number; diffLines: number }
  knownRed: string[]
}

export const DEFAULT_CONFIG: SensorConfig = {
  fast: {},
  full: {},
  tests: ['**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.py', '**/*Test.java', '**/*_spec.rb'],
  ignore: ['**/*.md', '**/*.lock', '**/package-lock.json'],
  contracts: ['api/**', 'schema/**', 'migrations/**', '**/*.proto', '**/openapi.*'],
  consumers: [],
  layers: [],
  limits: { fileLines: 400, diffLines: 500 },
  knownRed: [],
}

export const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['generic secret assignment', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
]

// ---------- globs ----------

// `**/` matches zero or more whole directories, `**` anything, `*` within one path segment.
export function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + (glob.endsWith('/') ? '.*' : '') + '$')
}

const compiled = new Map<string, RegExp>()
export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some(g => {
    let re = compiled.get(g)
    if (!re) compiled.set(g, (re = globToRegex(g)))
    return re.test(file)
  })
}
export const isTest = (file: string, cfg: SensorConfig): boolean => matchesAny(file, cfg.tests)
export const isSource = (file: string, cfg: SensorConfig): boolean => !file.startsWith('.sdlc/') && !matchesAny(file, cfg.ignore)

// ---------- unified diff ----------

const ESCAPES: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92 }

// git C-quotes paths with unusual bytes ("caf\303\251.js"); decode the octal escapes back to UTF-8.
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const s = p.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ''
    if (c !== '\\') {
      bytes.push(...new TextEncoder().encode(c))
      continue
    }
    const next = s[i + 1] ?? ''
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      i++
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

// `--- a/x` / `+++ b/x`, with git's trailing tab for names containing spaces.
function sidePath(rest: string): string | null {
  const p = unquote(rest.replace(/\t$/, ''))
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
}

function headerPath(raw: string): string {
  const rest = raw.slice('diff --git '.length)
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest)
  if (quoted) return unquote(`"${quoted[1] ?? ''}"`)
  const i = rest.lastIndexOf(' b/')
  return i >= 0 ? rest.slice(i + 3) : rest
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let inHunk = false
  let oldN = 0
  let newN = 0
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { file: headerPath(raw), status: 'M', added: [], removed: [] }
      files.push(cur)
      inHunk = false
      continue
    }
    if (!cur) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      inHunk = true
      oldN = Number(hunk[1])
      newN = Number(hunk[2])
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('new file mode')) cur.status = 'A'
      else if (raw.startsWith('deleted file mode')) cur.status = 'D'
      else if (raw.startsWith('rename from ')) {
        cur.status = 'R'
        cur.from = unquote(raw.slice('rename from '.length))
      } else if (raw.startsWith('rename to ')) cur.file = unquote(raw.slice('rename to '.length))
      else if (raw.startsWith('Binary files ')) cur.binary = true
      else if (raw.startsWith('--- ')) {
        const p = sidePath(raw.slice(4))
        if (p && cur.status === 'D') cur.file = p
      } else if (raw.startsWith('+++ ')) {
        const p = sidePath(raw.slice(4))
        if (p) cur.file = p
      }
      continue
    }
    if (raw.startsWith('+')) cur.added.push({ n: newN++, text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.removed.push({ n: oldN++, text: raw.slice(1) })
    else if (raw.startsWith(' ')) {
      oldN++
      newN++
    }
  }
  return files
}

// ---------- config & rules ----------

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const isStringMap = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every(x => typeof x === 'string')

function parseJson(text: string, name: string): { value: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) }
  } catch (err) {
    return { value: null, error: `${name} is not valid JSON: ${(err as Error).message}` }
  }
}

export function parseConfig(text: string): { config: SensorConfig; errors: string[] } {
  const config: SensorConfig = structuredClone(DEFAULT_CONFIG)
  if (!text.trim()) return { config, errors: [] }
  const { value, error } = parseJson(text, 'sensors.json')
  if (error) return { config, errors: [error] }
  if (!isObject(value)) return { config, errors: ['sensors.json must be a JSON object'] }
  const errors: string[] = []
  for (const key of ['fast', 'full'] as const) {
    if (!(key in value)) continue
    if (isStringMap(value[key])) config[key] = value[key]
    else errors.push(`${key} must map names to command strings`)
  }
  for (const key of ['tests', 'ignore', 'contracts', 'knownRed'] as const) {
    if (!(key in value)) continue
    if (isStringList(value[key])) config[key] = value[key]
    else errors.push(`${key} must be a list of strings`)
  }
  if ('consumers' in value) {
    const list = value.consumers
    if (Array.isArray(list) && list.every(c => isObject(c) && typeof c.name === 'string' && typeof c.path === 'string')) config.consumers = list as Consumer[]
    else errors.push('consumers must be a list of { name, path, repo?, test? }')
  }
  if ('layers' in value) {
    const list = value.layers
    const valid = (l: unknown): boolean => isObject(l) && typeof l.from === 'string' && isStringList(l.mustNotImport) && typeof l.why === 'string' && l.why.trim() !== ''
    if (Array.isArray(list) && list.every(valid)) config.layers = list as Layer[]
    else errors.push('layers must be a list of { from, mustNotImport: [...], why }, and every layer needs a why')
  }
  if ('limits' in value) {
    const limits = isObject(value.limits) ? value.limits : {}
    for (const k of ['fileLines', 'diffLines'] as const) {
      if (!(k in limits)) continue
      const v = limits[k]
      if (typeof v === 'number' && v > 0) config.limits[k] = v
      else errors.push(`limits.${k} must be a positive number`)
    }
  }
  for (const k of Object.keys(value)) if (!(k in DEFAULT_CONFIG)) errors.push(`unknown key "${k}"`)
  return { config, errors }
}

export function parseRules(text: string): { rules: Rule[]; errors: string[] } {
  if (!text.trim()) return { rules: [], errors: [] }
  const { value, error } = parseJson(text, 'rules.json')
  if (error) return { rules: [], errors: [error] }
  if (!Array.isArray(value)) return { rules: [], errors: ['rules.json must be a list of rules'] }
  const rules: Rule[] = []
  const errors: string[] = []
  value.forEach((r, i) => {
    const id = isObject(r) && typeof r.id === 'string' ? r.id : `#${i + 1}`
    if (!isObject(r) || typeof r.id !== 'string' || typeof r.message !== 'string') return errors.push(`rule ${id}: needs id and message`)
    if (typeof r.why !== 'string' || !r.why.trim()) return errors.push(`rule ${id}: needs a why (earn every rule)`)
    if (r.action !== 'warn' && r.action !== 'block') return errors.push(`rule ${id}: action must be warn or block`)
    if (r.paths !== undefined && !isStringList(r.paths)) return errors.push(`rule ${id}: paths must be a list of globs`)
    try {
      new RegExp(String(r.pattern))
    } catch {
      return errors.push(`rule ${id}: pattern is not a valid regular expression`)
    }
    rules.push(r as unknown as Rule)
  })
  return { rules, errors }
}

// ---------- findings ----------

// Silent success, verbose failure: nothing when clean; blocks first, grouped by sensor, deduplicated, capped.
export function formatFindings(findings: Finding[], max = 40): string {
  const seen = new Set<string>()
  const unique = findings.filter(f => {
    const key = `${f.sensor}|${f.file ?? ''}|${f.line ?? ''}|${f.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const blocks = unique.filter(f => f.severity === 'block')
  const warns = unique.filter(f => f.severity === 'warn')
  const rows: string[] = []
  for (const sensor of [...new Set(blocks.map(f => f.sensor))]) {
    rows.push(`[${sensor}]`)
    for (const f of blocks.filter(b => b.sensor === sensor)) {
      const where = f.file ? `${f.file}${f.line ? ':' + f.line : ''}: ` : ''
      const labels = f.labels?.length ? ` (${f.labels.join(', ')})` : ''
      rows.push(`  ✗ ${where}${f.message}${labels} → ${f.fix}`)
    }
  }
  const tail = warns.length ? [`warn: ${warns.length} (${[...new Set(warns.map(w => w.sensor))].map(s => `${s} ${warns.filter(w => w.sensor === s).length}`).join(', ')})`] : []
  const room = max - tail.length
  const shown = rows.length > room ? [...rows.slice(0, room - 1), `  … ${rows.length - room + 1} more (run sdlc.ts check to see all)`] : rows
  return [...shown, ...tail].join('\n')
}
```

In `scripts/core.ts`, delete `globToRegex` and `SECRET_PATTERNS`, then add:

```ts
import { globToRegex, SECRET_PATTERNS } from './model.ts'
export { globToRegex }
```

- [ ] **Step 4: Run all the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: everything passes. Existing scope-drift tests still pass, because `tests/**` and plain paths match as before.

- [ ] **Step 5: Commit**

```bash
git add scripts/
git commit -m "feat: pure diff model, globs, sensors.json and rules.json parsing, finding format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Test-tamper and suppression sensors

**Files:**
- Create: `scripts/sensors.ts`, `scripts/sensors.spec.ts`

**Interfaces:**
- Consumes: from Task 4's `model.ts`, `FileDiff`, `Finding`, `SensorConfig`, `isTest`, `isSource`, `matchesAny` and `DEFAULT_CONFIG`.
- Produces from `sensors.ts`, all pure:
  - `TAMPER_PATTERNS: { id: string; re: RegExp; what: string }[]`
  - `SUPPRESSIONS: RegExp[]`
  - `testTamper(diffs: FileDiff[], cfg: SensorConfig): Finding[]`
  - `suppressions(diffs: FileDiff[], cfg: SensorConfig): Finding[]`
  - Finding sensor names: `'test-tamper'` and `'suppression'`

- [ ] **Step 1: Write the failing tests**

Create `scripts/sensors.spec.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG as CFG, type FileDiff } from './model.ts'
import { testTamper, suppressions, TAMPER_PATTERNS } from './sensors.ts'

export const fd = (file: string, added: string[] = [], removed: string[] = [], status: FileDiff['status'] = 'M'): FileDiff => ({
  file, status, added: added.map((text, i) => ({ n: i + 1, text })), removed: removed.map((text, i) => ({ n: i + 1, text })),
})
const blocks = (fs: { severity: string }[]) => fs.filter(f => f.severity === 'block')

// Every tamper row has a positive and a negative fixture (spec §5.4).
const FIXTURES: Record<string, [string, string]> = {
  'skip-or-only': ["it.skip('adds', () => {})", "const rest = myit.skip(2)"],
  'x-prefixed': ["  xit('adds', () => {})", '  exit(1)'],
  'pytest-skip': ['@pytest.mark.skip(reason="slow")', '# docs mention pytest.mark.skip'],
  'unittest-skip': ['@unittest.skip("flaky")', 'unittest.skipTest_helper()'],
  'junit-disabled': ['  @Disabled', '  @DisabledForJreRange(min = JAVA_8)'],
  'go-skip': ['\tt.Skip("slow")', '\tt.SkipTo(next)'],
  'rspec-pending': ['  pending "not yet"', "  expect(t.status).toBe('pending')"],
}

test('every tamper pattern has fixtures', () => {
  assert.deepEqual(TAMPER_PATTERNS.map(p => p.id).sort(), Object.keys(FIXTURES).sort())
})

for (const [id, [positive, negative]] of Object.entries(FIXTURES)) {
  test(`tamper ${id}: positive blocks, negative passes`, () => {
    assert.equal(blocks(testTamper([fd('test/a.test.js', [positive])], CFG)).length, 1, positive)
    assert.equal(blocks(testTamper([fd('test/a.test.js', [negative])], CFG)).length, 0, negative)
  })
}

test('skip markers in non-test files are ignored', () => {
  assert.equal(testTamper([fd('src/a.js', ["it.skip('x')"])], CFG).length, 0)
})

test('assertions are counted across all test files, so moving tests is neutral', () => {
  const moved = [fd('test/a.test.js', [], ['  expect(a).toBe(1)', '  expect(b).toBe(2)']), fd('test/b.test.js', ['  expect(a).toBe(1)', '  expect(b).toBe(2)'])]
  assert.equal(blocks(testTamper(moved, CFG)).length, 0)
  const dropped = [fd('test/a.test.js', ['  expect(a).toBeTruthy()'], ['  expect(a).toBe(1)', '  expect(b).toBe(2)'])]
  assert.match(blocks(testTamper(dropped, CFG))[0]?.message ?? '', /2 removed, 1 added/)
  const comments = [fd('test/a.test.js', [], ['  // expect(a).toBe(1) was flaky'])]
  assert.equal(blocks(testTamper(comments, CFG)).length, 0)
})

test('a deleted test file blocks unless its content reappears in a new file', () => {
  const body = ["test('a', () => {", '  expect(add(1, 2)).toBe(3)', '})']
  assert.equal(blocks(testTamper([fd('test/a.test.js', [], body, 'D')], CFG)).length, 1)
  assert.equal(blocks(testTamper([fd('test/a.test.js', [], body, 'D'), fd('test/math/a.test.js', body, [], 'A')], CFG)).length, 0)
})

test('a lowered coverage threshold in config blocks; source code numbers do not', () => {
  assert.equal(blocks(testTamper([fd('package.json', ['    "lines": 80,'], ['    "lines": 85,'])], CFG)).length, 1)
  assert.equal(blocks(testTamper([fd('pyproject.toml', ['fail_under = 70'], ['fail_under = 85'])], CFG)).length, 1)
  assert.equal(blocks(testTamper([fd('package.json', ['    "lines": 90,'], ['    "lines": 85,'])], CFG)).length, 0)
  assert.equal(blocks(testTamper([fd('src/report.js', ['const lines = 80'], ['const lines = 85'])], CFG)).length, 0)
})

test('rewritten snapshots warn', () => {
  const r = testTamper([fd('test/__snapshots__/a.test.js.snap', ['x'], ['y'])], CFG)
  assert.deepEqual(r.map(f => f.severity), ['warn'])
})

test('suppression comments block unless they carry a reason', () => {
  for (const line of ['// eslint-disable-next-line no-console', 'x = y  # type: ignore', 'import os  # noqa', '// @ts-ignore', '//nolint', '@SuppressWarnings("unchecked")', '# rubocop:disable Metrics/AbcSize']) {
    assert.equal(blocks(suppressions([fd('src/a.ts', [line])], CFG)).length, 1, line)
  }
  assert.equal(suppressions([fd('src/a.ts', ['// eslint-disable-next-line no-console -- the CLI prints by design'])], CFG).length, 0)
  assert.equal(suppressions([fd('src/a.py', ['x = y  # type: ignore because the stub is wrong upstream'])], CFG).length, 0)
  assert.equal(suppressions([fd('README.md', ['use // eslint-disable sparingly'])], CFG).length, 0)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts`
Expected: FAIL, with `Cannot find module './sensors.ts'`.

- [ ] **Step 3: Implement `scripts/sensors.ts`**

```ts
// Language-agnostic sensors: pure functions from a parsed diff and config to findings.
// Language knowledge lives in the pattern tables below, never in code paths per language.
import { type FileDiff, type Finding, type SensorConfig, isTest, isSource } from './model.ts'

export const TAMPER_PATTERNS: { id: string; re: RegExp; what: string }[] = [
  { id: 'skip-or-only', re: /\b(?:it|describe|test|context|suite)\.(?:skip|only|todo)\s*\(/, what: 'test skipped or focused' },
  { id: 'x-prefixed', re: /^\s*x(?:it|describe|test|context)\s*\(/, what: 'test disabled with an x prefix' },
  { id: 'pytest-skip', re: /^\s*@pytest\.mark\.(?:skip|skipif|xfail)\b/, what: 'pytest skip/xfail marker' },
  { id: 'unittest-skip', re: /^\s*@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/, what: 'unittest skip decorator' },
  { id: 'junit-disabled', re: /^\s*@(?:Disabled|Ignore)\b(?!\w)/, what: 'JUnit @Disabled/@Ignore' },
  { id: 'go-skip', re: /\bt\.Skip(?:Now|f)?\(/, what: 'Go t.Skip' },
  { id: 'rspec-pending', re: /^\s*(?:pending|skip)\b(?:\s+["']|\s*$|\s+do\b)/, what: 'RSpec pending/skip' },
]

export const SUPPRESSIONS: RegExp[] = [
  /eslint-disable/, /@ts-(?:ignore|expect-error|nocheck)\b/, /#\s*type:\s*ignore/, /#\s*noqa\b/, /pylint:\s*disable/,
  /\/\/\s*nolint\b/, /@SuppressWarnings\b/, /rubocop:disable/, /#\s*pragma:\s*no\s*cover/, /istanbul\s+ignore/,
]

const REASONED = /(?:\s--\s*|\bbecause\b\s*)\S/i
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|--|;)/
const ASSERTION = /\bassert\w*\s*\(|^\s*assert\s|\bexpect\s*\(|\.should\b|\bAssert\.\w+\s*\(|\bt\.(?:Error|Fatal)f?\s*\(|\brequire\.\w+\s*\(/g
const THRESHOLD_KEY = /coverage|threshold|fail[_-]under|minimum|\b(?:lines|branches|functions|statements)\b/i
const CONFIG_FILE = /(?:^|\/)(?:[^/]*\.(?:json|ya?ml|toml|cfg|ini|xml|gradle|kts|properties)|\.[\w-]*rc(?:\.\w+)?|[^/]*\.config\.[cm]?[jt]s)$/
const SNAPSHOT = /(?:^|\/)__snapshots__\/|\.snap$/
const KEEP_TESTS = "keep the test and make the code pass it; removing a test needs the person's /sdlc-waive"

const countAssertions = (texts: string[]): number =>
  texts.filter(t => !COMMENT_LINE.test(t)).reduce((n, t) => n + (t.match(ASSERTION)?.length ?? 0), 0)

function similarity(gone: Set<string>, candidate: FileDiff): number {
  if (!gone.size) return 1
  const have = new Set(candidate.added.map(l => l.text.trim()))
  let hit = 0
  for (const line of gone) if (have.has(line)) hit++
  return hit / gone.size
}

function loweredThresholds(diffs: FileDiff[]): Finding[] {
  const findings: Finding[] = []
  const key = (t: string): string => t.replace(/\d+(?:\.\d+)?/g, '#').trim()
  const num = (t: string): number => Number(/\d+(?:\.\d+)?/.exec(t)?.[0])
  for (const d of diffs.filter(f => CONFIG_FILE.test(f.file) && !f.binary)) {
    const before = new Map(d.removed.filter(l => THRESHOLD_KEY.test(l.text) && /\d/.test(l.text)).map(l => [key(l.text), num(l.text)]))
    for (const l of d.added) {
      const was = before.get(key(l.text))
      if (was !== undefined && THRESHOLD_KEY.test(l.text) && num(l.text) < was) {
        findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, line: l.n, message: `threshold lowered from ${was} to ${num(l.text)}`, fix: 'restore the threshold and add the missing tests instead' })
      }
    }
  }
  return findings
}

export function testTamper(diffs: FileDiff[], cfg: SensorConfig): Finding[] {
  const findings: Finding[] = []
  const tests = diffs.filter(d => isTest(d.file, cfg) && !d.binary)
  const newFiles = tests.filter(d => d.status === 'A')
  for (const d of tests.filter(t => t.status === 'D')) {
    const gone = new Set(d.removed.map(l => l.text.trim()).filter(Boolean))
    if (!newFiles.some(n => similarity(gone, n) >= 0.6)) {
      findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, message: 'test file deleted', fix: KEEP_TESTS })
    }
  }
  for (const d of tests) {
    for (const l of d.added) {
      const hit = TAMPER_PATTERNS.find(p => p.re.test(l.text))
      if (hit) findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, line: l.n, message: `${hit.what}: ${l.text.trim()}`, fix: KEEP_TESTS })
    }
  }
  const removed = countAssertions(tests.flatMap(d => d.removed.map(l => l.text)))
  const added = countAssertions(tests.flatMap(d => d.added.map(l => l.text)))
  if (removed > added) {
    findings.push({ sensor: 'test-tamper', severity: 'block', message: `assertions dropped across the test diff: ${removed} removed, ${added} added`, fix: 'keep every assertion that still applies; a weaker test hides bugs' })
  }
  findings.push(...loweredThresholds(diffs))
  for (const d of diffs) {
    if (SNAPSHOT.test(d.file) && d.status === 'M') findings.push({ sensor: 'test-tamper', severity: 'warn', file: d.file, message: 'snapshot rewritten', fix: 'check the snapshot change is intended' })
  }
  return findings
}

export function suppressions(diffs: FileDiff[], cfg: SensorConfig): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => !f.binary && (isSource(f.file, cfg) || isTest(f.file, cfg)))) {
    for (const l of d.added) {
      if (SUPPRESSIONS.some(re => re.test(l.text)) && !REASONED.test(l.text)) {
        findings.push({ sensor: 'suppression', severity: 'block', file: d.file, line: l.n, message: `suppression added: ${l.text.trim()}`, fix: 'fix the warning instead, or give the reason on the same line after "--" or "because"' })
      }
    }
  }
  return findings
}
```

- [ ] **Step 4: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts`
Expected: PASS. If a negative fixture fails, tighten the regex in `TAMPER_PATTERNS`, not the fixture.

- [ ] **Step 5: Commit**

```bash
git add scripts/sensors.ts scripts/sensors.spec.ts
git commit -m "feat: test-tamper and suppression sensors with positive and negative fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Layering, size, secrets and rules sensors

**Files:**
- Modify: `scripts/sensors.ts`, `scripts/sensors.spec.ts`

**Interfaces:**
- Consumes: Task 4's `model.ts`.
- Produces from `sensors.ts`:
  - `layering(diffs, cfg): Finding[]`, sensor `'layering'`
  - `size(diffs, cfg, fileLines: Record<string, number>, point: 'edit'|'stop'|'ship'|'ci'): Finding[]`, sensor `'size'`
  - `secretsInDiff(diffs): Finding[]`, sensor `'secrets'`
  - `rulesSensor(diffs, rules: Rule[]): Finding[]`, sensor `'rules'`. Each finding has `labels: [rule.id]`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sensors.spec.ts`. Extend the import from `./sensors.ts` with `layering, size, secretsInDiff, rulesSensor`, and add `type SensorConfig, type Rule` to the `./model.ts` import.

```ts
const withLayers: SensorConfig = { ...CFG, layers: [{ from: 'src/domain/**', mustNotImport: ['infra', 'http'], why: 'the domain stays framework-free' }] }

test('layering blocks forbidden imports in any import syntax, and nothing else', () => {
  for (const line of ["import { db } from '../infra/db'", 'from infra.db import session', "const h = require('../http/client')", 'use crate::infra::db;', '#include "infra/db.h"', 'import com.acme.infra.Db;']) {
    const r = layering([fd('src/domain/order.ts', [line])], withLayers)
    assert.equal(r.length, 1, line)
    assert.match(r[0]?.message ?? '', /framework-free/)
  }
  assert.equal(layering([fd('src/domain/order.ts', ['// talks to infra later', "import { infraction } from './rules'"])], withLayers).length, 0)
  assert.equal(layering([fd('src/app/main.ts', ["import { db } from '../infra/db'"])], withLayers).length, 0)
})

test('size warns when a file crosses the line limit, and the diff limit blocks only from ship on', () => {
  const big = fd('src/a.ts', Array.from({ length: 30 }, () => 'x'))
  assert.equal(size([big], CFG, { 'src/a.ts': 410 }, 'stop')[0]?.severity, 'warn')
  assert.equal(size([big], CFG, { 'src/a.ts': 900 }, 'stop').length, 0, 'already over before this diff: no news')
  const huge = fd('src/b.ts', Array.from({ length: 600 }, () => 'y'), [], 'A')
  assert.equal(size([huge], CFG, { 'src/b.ts': 600 }, 'stop').find(f => !f.file)?.severity, 'warn')
  assert.equal(size([huge], CFG, { 'src/b.ts': 600 }, 'ship').find(f => !f.file)?.severity, 'block')
  assert.equal(size([fd('docs/x.md', Array.from({ length: 900 }, () => 'z'))], CFG, {}, 'ship').length, 0, 'ignored files do not count')
})

test('secrets in added lines block; the allow comment opts out', () => {
  assert.equal(secretsInDiff([fd('src/c.js', ['const key = "AKIAABCDEFGHIJKLMNOP"'])]).length, 1) // sdlc:allow-secret fixture quoted from the plan
  assert.equal(secretsInDiff([fd('src/c.js', ['const key = "AKIAABCDEFGHIJKLMNOP" // sdlc:allow-secret test fixture'])]).length, 0)
})

test('rules apply to added lines within their paths, labelled with the rule id', () => {
  const rules: Rule[] = [{ id: 'no-print', pattern: '\\bprint\\(', paths: ['src/**'], message: 'use the logger', why: 'stdout carries the protocol', action: 'block' }]
  const r = rulesSensor([fd('src/a.py', ['print("x")']), fd('scripts/b.py', ['print("y")'])], rules)
  assert.deepEqual(r.map(f => [f.file, f.labels?.[0], f.severity]), [['src/a.py', 'no-print', 'block']])
  assert.match(r[0]?.message ?? '', /stdout carries the protocol/)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts`
Expected: FAIL, because `layering` is not exported.

- [ ] **Step 3: Implement**

1. Extend the `./model.ts` import in `sensors.ts` to `{ type FileDiff, type Finding, type Rule, type SensorConfig, isTest, isSource, matchesAny, globToRegex, SECRET_PATTERNS }`.
2. Append:

```ts
const IMPORT_LINE = /^\s*(?:import|from|require|use|using|#\s*include|include|extern\s+crate)\b|\brequire\s*\(|\bimport\s*\(/
const word = (t: string): RegExp => new RegExp(`(?:^|[^A-Za-z0-9_])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9_])`)

export function layering(diffs: FileDiff[], cfg: SensorConfig): Finding[] {
  const findings: Finding[] = []
  for (const layer of cfg.layers) {
    const from = globToRegex(layer.from)
    const banned = layer.mustNotImport.map(t => ({ t, re: word(t) }))
    for (const d of diffs.filter(f => from.test(f.file) && !f.binary)) {
      for (const l of d.added.filter(a => IMPORT_LINE.test(a.text) && !/^\s*(?:\/\/|#(?!\s*include))/.test(a.text))) {
        const hit = banned.find(b => b.re.test(l.text))
        if (hit) findings.push({ sensor: 'layering', severity: 'block', file: d.file, line: l.n, message: `${layer.from} must not import ${hit.t}: ${layer.why}`, fix: `depend on an interface owned by this layer and inject the ${hit.t} implementation at the boundary` })
      }
    }
  }
  return findings
}

export function size(diffs: FileDiff[], cfg: SensorConfig, fileLines: Record<string, number>, point: 'edit' | 'stop' | 'ship' | 'ci'): Finding[] {
  const findings: Finding[] = []
  const counted = diffs.filter(d => isSource(d.file, cfg) && !d.binary)
  for (const d of counted.filter(f => f.status !== 'D')) {
    const now = fileLines[d.file]
    if (now === undefined) continue
    const before = now - d.added.length + d.removed.length
    if (now > cfg.limits.fileLines && before <= cfg.limits.fileLines) {
      findings.push({ sensor: 'size', severity: 'warn', file: d.file, message: `grew to ${now} lines (limit ${cfg.limits.fileLines})`, fix: 'split it by responsibility before it grows further' })
    }
  }
  const total = counted.reduce((n, d) => n + d.added.length + d.removed.length, 0)
  if (total > cfg.limits.diffLines && point !== 'edit') {
    findings.push({ sensor: 'size', severity: point === 'stop' ? 'warn' : 'block', message: `diff is ${total} changed lines (limit ${cfg.limits.diffLines})`, fix: 'ship it as smaller changes, or the person records an override with /sdlc-waive size * <reason>' })
  }
  return findings
}

export function secretsInDiff(diffs: FileDiff[]): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => !f.binary)) {
    for (const l of d.added) {
      if (/sdlc:allow-secret/.test(l.text)) continue
      const hit = SECRET_PATTERNS.find(([, re]) => re.test(l.text))
      if (hit) findings.push({ sensor: 'secrets', severity: 'block', file: d.file, line: l.n, message: `possible ${hit[0]}`, fix: 'load it from the environment or a secret store; for a test fixture add "sdlc:allow-secret <why>" on the line' })
    }
  }
  return findings
}

export function rulesSensor(diffs: FileDiff[], rules: { id: string; pattern: string; paths?: string[]; message: string; why: string; action: 'warn' | 'block' }[]): Finding[] {
  const findings: Finding[] = []
  for (const rule of rules) {
    const re = new RegExp(rule.pattern)
    for (const d of diffs.filter(f => !f.binary && !f.file.startsWith('.sdlc/') && (!rule.paths || matchesAny(f.file, rule.paths)))) {
      for (const l of d.added.filter(a => re.test(a.text))) {
        findings.push({ sensor: 'rules', severity: rule.action, file: d.file, line: l.n, message: `${rule.message} (${rule.why})`, fix: `follow rule ${rule.id} in .sdlc/rules.json`, labels: [rule.id] })
      }
    }
  }
  return findings
}
```

(`Rule` is imported for callers. The inline structural type on `rulesSensor` keeps the function independent of the import.)

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sensors.ts scripts/sensors.spec.ts
git commit -m "feat: layering, size, secrets-in-diff and rules sensors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Turn baselines and git diffs (`diffs.ts`)

**Files:**
- Create: `scripts/diffs.ts`
- Modify:
  - `scripts/core.ts`: give `git()` a 256 MB `maxBuffer` and add `gitIn(cwd, args)`
  - `scripts/sdlc.ts`: the new `diff` command
- Test: `scripts/check.spec.ts` (new)

**Interfaces:**
- Consumes: from `core.ts`, `ROOT`, `SDLC`, `read`, `sha`, `now` and `git`. From `model.ts`, `parseUnifiedDiff` and `FileDiff`.
- Produces from `diffs.ts`:
  - `type Snapshot = { sha: string; at: string; untracked: Record<string, string> }`
  - `snapshot(): Snapshot | null`, which returns null when there is no commit
  - `readBaseline(agentId?: string): Snapshot | null`
  - `writeBaseline(snap: Snapshot, agentId?: string): void`. A main write drops the earlier agent baselines.
  - `turnDiff(snap: Snapshot): FileDiff[]`
  - `fileDiff(snap: Snapshot, rel: string): FileDiff[]`
  - `branchDiff(base: string): FileDiff[]`
  - `showAt(ref: string, rel: string): string | null`
  - `fileLines(files: string[]): Record<string, number>`
  - `diffHash(diffs: FileDiff[]): string`
- Produces from `core.ts`: `gitIn(cwd: string, args: string[]): string | null`
- CLI: `sdlc.ts diff (--turn | --base <ref>) [--json]`

- [ ] **Step 1: Write the failing tests**

Create `scripts/check.spec.ts`:

```ts
// Integration: baselines and diffs, sdlc check at each point, ship verdicts. Each test gets a fresh temp repo.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn, verified } from './testkit.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
  sdlc(repo, ['init'])
  write(repo, 'src/app.js', 'export const a = 1\n')
  write(repo, 'notes.txt', 'untracked before the turn\n')
  gitIn(repo, 'add', 'src/app.js')
  gitIn(repo, 'commit', '-qm', 'app')
})

const turnFiles = () => JSON.parse(sdlc(repo, ['diff', '--turn', '--json']).stdout).map((d: { file: string; status: string }) => `${d.status} ${d.file}`).sort()

test('the turn diff holds tracked edits, Bash-style writes and new untracked files, not older untracked ones', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 2\n')
  fs.appendFileSync(path.join(repo, 'src/app.js'), '// via sed\n')
  write(repo, 'src/new.js', 'export const b = 1\n')
  assert.deepEqual(turnFiles(), ['A src/new.js', 'M src/app.js'])
})

test('an untracked file changed during the turn counts; a staged-only change counts', () => {
  hook(repo, 'prompt-submit', {})
  fs.appendFileSync(path.join(repo, 'notes.txt'), 'edited\n')
  write(repo, 'src/app.js', 'export const a = 3\n')
  gitIn(repo, 'add', 'src/app.js')
  assert.deepEqual(turnFiles(), ['A notes.txt', 'M src/app.js'])
})

test('a diff over 1 MB is parsed, not silently empty', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/big.js', Array.from({ length: 80_000 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  gitIn(repo, 'add', 'src/big.js')
  const diffs = JSON.parse(sdlc(repo, ['diff', '--turn', '--json']).stdout)
  assert.equal(diffs.find((d: { file: string }) => d.file === 'src/big.js')?.added.length, 80_000)
})

test('the branch diff covers commits since the merge-base plus the working tree', () => {
  gitIn(repo, 'checkout', '-qb', 'feature')
  write(repo, 'src/app.js', 'export const a = 4\n')
  gitIn(repo, 'commit', '-qam', 'wip')
  write(repo, 'src/later.js', 'x\n')
  const files = JSON.parse(sdlc(repo, ['diff', '--base', 'main', '--json']).stdout).map((d: { file: string }) => d.file).sort()
  assert.deepEqual(files, ['notes.txt', 'src/app.js', 'src/later.js'])
})

test('no commits yet: prompt-submit is silent and writes no baseline', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bare-'))
  gitIn(bare, 'init', '-q')
  sdlc(bare, ['init'])
  const r = hook(bare, 'prompt-submit', {})
  assert.deepEqual([r.code, r.stdout], [0, ''])
  assert.ok(!fs.existsSync(path.join(bare, '.sdlc/.baseline')))
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/check.spec.ts`
Expected: FAIL. `prompt-submit` is an unknown hook and `diff` is an unknown command.

- [ ] **Step 3: Give `git()` room, and add `gitIn` to `core.ts`**

Replace `git` in `core.ts`:

```ts
// A diff larger than the default 1 MB buffer must not turn into "no changes": allow 256 MB.
export function gitIn(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}
export const git = (args: string[]): string | null => gitIn(ROOT, args)
```

- [ ] **Step 4: Implement `scripts/diffs.ts`**

```ts
// What changed: turn baselines and git diffs (tracked and untracked files) in the pure diff model.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, read, sha, now, git } from './core.ts'
import { parseUnifiedDiff, type FileDiff } from './model.ts'

export type Snapshot = { sha: string; at: string; untracked: Record<string, string> }
type Baselines = { main?: Snapshot; agents: Record<string, Snapshot> }

const BASELINE = path.join(SDLC, '.baseline')
const MAX_HASHED_BYTES = 2_000_000
const DIFF = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M']

const untrackedFiles = (): string[] => (git(['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean)

function fingerprint(rel: string): string {
  try {
    const st = fs.statSync(path.join(ROOT, rel))
    return st.size > MAX_HASHED_BYTES ? `${st.size}:${st.mtimeMs}` : sha(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  } catch {
    return 'gone'
  }
}

// `git stash create` records tracked changes (staged and unstaged) without touching the tree.
// It ignores untracked files, so those are fingerprinted separately.
export function snapshot(): Snapshot | null {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!head) return null
  return { sha: git(['stash', 'create']) || head, at: now(), untracked: Object.fromEntries(untrackedFiles().map(f => [f, fingerprint(f)])) }
}

function readAll(): Baselines {
  try {
    const all = JSON.parse(read(BASELINE)) as Baselines
    return { main: all.main, agents: all.agents ?? {} }
  } catch {
    return { agents: {} }
  }
}

export const readBaseline = (agentId?: string): Snapshot | null => (agentId ? readAll().agents[agentId] : readAll().main) ?? null

// A new main turn starts fresh; a subagent's baseline is added beside the main one.
export function writeBaseline(snap: Snapshot, agentId?: string): void {
  const all: Baselines = agentId ? readAll() : { agents: {} }
  if (agentId) all.agents[agentId] = snap
  else all.main = snap
  fs.writeFileSync(BASELINE, JSON.stringify(all))
}

function addedFile(rel: string): FileDiff {
  const text = read(path.join(ROOT, rel))
  if (text.includes('\0')) return { file: rel, status: 'A', added: [], removed: [], binary: true }
  return { file: rel, status: 'A', added: text.replace(/\n$/, '').split('\n').map((t, i) => ({ n: i + 1, text: t })), removed: [] }
}

export function turnDiff(snap: Snapshot): FileDiff[] {
  const tracked = parseUnifiedDiff(git([...DIFF, snap.sha]) ?? '')
  const fresh = untrackedFiles().filter(f => snap.untracked[f] !== fingerprint(f))
  return [...tracked, ...fresh.map(addedFile)]
}

export function fileDiff(snap: Snapshot, rel: string): FileDiff[] {
  if (untrackedFiles().includes(rel)) return snap.untracked[rel] === fingerprint(rel) ? [] : [addedFile(rel)]
  return parseUnifiedDiff(git([...DIFF, snap.sha, '--', rel]) ?? '')
}

export const branchDiff = (base: string): FileDiff[] => [...parseUnifiedDiff(git([...DIFF, base]) ?? ''), ...untrackedFiles().map(addedFile)]

export const showAt = (ref: string, rel: string): string | null => git(['show', `${ref}:${rel}`])

export function fileLines(files: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of files) {
    const text = read(path.join(ROOT, f))
    if (text) counts[f] = text.replace(/\n$/, '').split('\n').length
  }
  return counts
}

export const diffHash = (diffs: FileDiff[]): string => sha(JSON.stringify(diffs))
```

- [ ] **Step 5: Add the `prompt-submit` hook (baseline) and the `diff` command**

In `hooks.ts`, import `snapshot` and `writeBaseline` from `./diffs.ts`, then add:

```ts
// Each prompt starts a turn: record what the tree looked like, so Stop can diff exactly this turn's changes.
function hookPromptSubmit(): void {
  if (!exists(SDLC)) return
  const snap = snapshot()
  if (snap) writeBaseline(snap)
}
```

Register `'prompt-submit': () => hookPromptSubmit()` in `HOOKS`.

In `sdlc.ts`:

```ts
function cmdDiff(args: Args): void {
  const base = optString(args, 'base')
  const snap = args.opt.turn ? readBaseline() ?? snapshot() : null
  if (!base && !snap) fail('usage: diff (--turn | --base <ref>) [--json]  (no baseline and no commits yet)')
  const diffs = base ? branchDiff(git(['merge-base', 'HEAD', base]) ?? base) : turnDiff(snap as Snapshot)
  if (args.opt.json) return out(JSON.stringify(diffs))
  out(diffs.map(d => `${d.status} ${d.file} (+${d.added.length} -${d.removed.length})`).join('\n') || 'no changes')
}
```

Import `readBaseline`, `snapshot`, `branchDiff`, `turnDiff` and `type Snapshot` from `./diffs.ts`. Register `diff: cmdDiff`.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/
git commit -m "feat: per-turn baselines and git diffs including untracked and Bash-made edits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The check orchestrator (`check.ts`): built-ins, declared commands, ratchet, waivers and the `check` CLI

**Files:**
- Create: `scripts/check.ts`
- Modify:
  - `scripts/core.ts`: add `WAIVERS` and `type Waiver`
  - `scripts/sdlc.ts`: register `check` and `check-file`
- Test: `scripts/check.spec.ts`

**Interfaces:**
- Consumes:
  - from `sensors.ts` (Tasks 5–6): `testTamper`, `suppressions`, `layering`, `size`, `secretsInDiff` and `rulesSensor`
  - from `model.ts`: `parseConfig`, `parseRules` and `formatFindings`
  - from `diffs.ts`: `readBaseline`, `snapshot`, `turnDiff`, `fileDiff`, `branchDiff`, `showAt` and `fileLines`
  - from `runs.ts`: `runCommand` and `recordRun`
- Produces from `check.ts`:
  - `type Point = 'stop' | 'ship' | 'ci'`
  - `type CheckInput = { point: Point; diffs: FileDiff[]; config: SensorConfig; rules: Rule[]; slugs: string[]; commands: 'fast' | 'full' | 'none'; budgetMs: number; before: (file: string) => string; toolEdited?: Set<string>; base: string | null }`
  - `type CheckResult = { findings: Finding[]; blocks: Finding[]; warns: Finding[]; waived: number }`
  - `loadConfig(ref?: string | null): { config: SensorConfig; rules: Rule[]; errors: string[] }`
  - `runChecks(input: CheckInput): CheckResult`
  - `runDeclared(prefix: 'fast' | 'full', config: SensorConfig, slug: string | null, budgetMs: number): Finding[]`
  - `editFindings(rel: string): Finding[]`, the cheap per-file sensors used by PostToolUse and the mod
  - `cmdCheck(args: Args): void`
  - `cmdCheckFile(args: Args): void`
- Produces from `core.ts`:
  - `WAIVERS: string`
  - `type Waiver = { slug: string; sensor: string; file: string; reason: string; by: string; at: string }`
- CLI:
  - `sdlc.ts check --at stop|ship|ci [--base <ref>] [--config-from <ref>] [--slug <s>] [--budget-ms <n>] [--json]` exits 1 when there are blocks
  - `sdlc.ts check-file <path> [--json]`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check.spec.ts`:

```ts
const sensors = (cfg: object) => write(repo, '.sdlc/sensors.json', JSON.stringify(cfg, null, 2) + '\n')
const check = (...args: string[]) => sdlc(repo, ['check', ...args])

test('check is silent-success: one pass line, exit 0', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 5\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^sdlc check stop: pass/)
})

test('a failing fast command blocks with its output tail; a passing one is silent', () => {
  sensors({ fast: { lint: 'node -e "console.log(\'src/app.js:1 no-var\'); process.exit(1)"', test: 'node -e "process.exit(0)"' } })
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'var a = 5\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[commands\]/)
  assert.match(r.stdout, /fast\.lint failed \(exit 1\)/)
  assert.match(r.stdout, /src\/app\.js:1 no-var/)
  assert.doesNotMatch(r.stdout, /fast\.test/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/x/runs.jsonl'), 'utf8'), /fast|no-var|process\.exit/)
})

test('a hanging command, and a grandchild holding its output, time out inside the budget and count as a failure', () => {
  sensors({ fast: { test: `node -e "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }); setTimeout(() => {}, 20000)"` } })
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 6\n')
  const started = Date.now()
  const r = check('--at', 'stop', '--budget-ms', '1500')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /timed out/)
  assert.ok(Date.now() - started < 10_000)
})

test('known-red commands warn instead of block, and the ratchet removes them once green', () => {
  sensors({ fast: { lint: 'node -e "process.exit(1)"' }, knownRed: ['fast.lint'] })
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 7\n')
  const red = check('--at', 'stop')
  assert.equal(red.code, 0)
  assert.match(red.stdout, /warn: \d+ \(.*commands 1/)
  sensors({ fast: { lint: 'node -e "process.exit(0)"' }, knownRed: ['fast.lint'] })
  check('--at', 'stop')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8')).knownRed, [])
})

test('an invalid sensors.json blocks with the parse error', () => {
  write(repo, '.sdlc/sensors.json', '{ "limits": { "fileLines": "big" } }')
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 8\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[config\][\s\S]*limits\.fileLines must be a positive number/)
})

test('a human waiver for the active change drops the matching finding', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/app.js', 'export const a = 9 // eslint-disable-line\n')
  assert.equal(check('--at', 'stop').code, 1)
  write(repo, '.sdlc/waivers.jsonl', JSON.stringify({ slug: 'x', sensor: 'suppression', file: 'src/app.js', reason: 'generated file', by: 'p', at: 'now' }) + '\n')
  assert.equal(check('--at', 'stop').code, 0)
})

test('check-file reports a single file\'s cheap sensors as JSON', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'test/a.test.js', "it.only('x', () => {})\n")
  const r = JSON.parse(sdlc(repo, ['check-file', 'test/a.test.js', '--json']).stdout)
  assert.equal(r[0].sensor, 'test-tamper')
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/check.spec.ts`
Expected: FAIL, because `check` is an unknown command.

- [ ] **Step 3: Add the waivers type to `core.ts`**

```ts
export const WAIVERS = path.join(SDLC, 'waivers.jsonl')
export type Waiver = { slug: string; sensor: string; file: string; reason: string; by: string; at: string }
```

- [ ] **Step 4: Implement `scripts/check.ts`**

```ts
// Orchestrates sensors at a firing point (stop, ship, ci): one set of checks everywhere, so local == CI.
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, SDLC, WAIVERS, exists, read, out, fail, git, optString, readJsonl, activeSlug, defaultBase,
  type Args, type Waiver,
} from './core.ts'
import { parseConfig, parseRules, formatFindings, type FileDiff, type Finding, type Rule, type SensorConfig } from './model.ts'
import { testTamper, suppressions, layering, size, secretsInDiff, rulesSensor } from './sensors.ts'
import { readBaseline, snapshot, turnDiff, fileDiff, branchDiff, showAt, fileLines } from './diffs.ts'
import { runCommand, recordRun } from './runs.ts'

export type Point = 'stop' | 'ship' | 'ci'
export type CheckInput = {
  point: Point
  diffs: FileDiff[]
  config: SensorConfig
  rules: Rule[]
  slugs: string[]
  commands: 'fast' | 'full' | 'none'
  budgetMs: number
  before: (file: string) => string
  toolEdited?: Set<string>
  base: string | null
}
export type CheckResult = { findings: Finding[]; blocks: Finding[]; warns: Finding[]; waived: number }

const SENSORS_JSON = '.sdlc/sensors.json'
const TAIL_IN_FINDING = 15

// With a ref (CI), config comes from the base branch, so a PR cannot loosen the rules it is judged by.
export function loadConfig(ref: string | null = null): { config: SensorConfig; rules: Rule[]; errors: string[] } {
  const text = (rel: string): string => (ref ? git(['show', `${ref}:${rel}`]) ?? '' : read(path.join(ROOT, rel)))
  const c = parseConfig(text(SENSORS_JSON))
  const r = parseRules(text('.sdlc/rules.json'))
  return { config: c.config, rules: r.rules, errors: [...c.errors, ...r.errors.map(e => `rules.json: ${e}`)] }
}

// Once a known-red command passes, it blocks from then on: the only automatic edit to sensors.json, and it only tightens.
function ratchet(cleared: string[]): void {
  const file = path.join(ROOT, SENSORS_JSON)
  if (!exists(file)) return
  const raw = JSON.parse(read(file)) as { knownRed?: string[] }
  raw.knownRed = (raw.knownRed ?? []).filter(k => !cleared.includes(k))
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
}

export function runDeclared(prefix: 'fast' | 'full', config: SensorConfig, slug: string | null, budgetMs: number): Finding[] {
  const findings: Finding[] = []
  const cleared: string[] = []
  let left = budgetMs
  for (const [name, cmd] of Object.entries(config[prefix])) {
    const key = `${prefix}.${name}`
    const known = config.knownRed.includes(key)
    if (left <= 0) {
      findings.push({ sensor: 'commands', severity: 'block', message: `${key} not run: the ${Math.round(budgetMs / 1000)} s budget ran out`, fix: `make the ${prefix} commands in .sdlc/sensors.json faster` })
      continue
    }
    const row = runCommand(cmd, { timeoutMs: left })
    left -= row.ms
    if (slug) recordRun(slug, { ...row, source: prefix === 'fast' ? 'gate' : 'ship' })
    if (row.exit === 0) {
      if (known) cleared.push(key)
      continue
    }
    const tail = row.tail.split('\n').slice(-TAIL_IN_FINDING).map(t => '      ' + t).join('\n')
    findings.push({
      sensor: 'commands',
      severity: known ? 'warn' : 'block',
      message: `${key} failed (exit ${row.exit}${row.timedOut ? ', timed out' : ''}): ${cmd}\n${tail}`,
      fix: known ? 'known red before this change: fix it when you can' : `run \`${cmd}\` and fix what it reports`,
    })
  }
  if (cleared.length) ratchet(cleared)
  return findings
}

function applyWaivers(findings: Finding[], slugs: string[]): CheckResult {
  const waivers = readJsonl<Waiver>(WAIVERS).filter(w => slugs.includes(w.slug))
  const waived = (f: Finding): boolean => waivers.some(w => w.sensor === f.sensor && (w.file === '*' || w.file === f.file))
  const kept = findings.filter(f => !waived(f))
  return { findings: kept, blocks: kept.filter(f => f.severity === 'block'), warns: kept.filter(f => f.severity === 'warn'), waived: findings.length - kept.length }
}

export function runChecks(i: CheckInput): CheckResult {
  const { diffs, config } = i
  const findings: Finding[] = [
    ...testTamper(diffs, config),
    ...suppressions(diffs, config),
    ...layering(diffs, config),
    ...size(diffs, config, fileLines(diffs.filter(d => d.status !== 'D').map(d => d.file)), i.point),
    ...secretsInDiff(diffs),
    ...rulesSensor(diffs, i.rules),
  ]
  if (i.commands !== 'none') findings.push(...runDeclared(i.commands, config, i.slugs[0] ?? null, i.budgetMs))
  return applyWaivers(findings, i.slugs)
}

// The cheap per-file subset, for PostToolUse and the mod's per-edit notices.
export function editFindings(rel: string): Finding[] {
  const snap = readBaseline() ?? snapshot()
  if (!snap) return []
  const { config, rules } = loadConfig()
  const diffs = fileDiff(snap, rel)
  const slug = activeSlug()
  return applyWaivers([...testTamper(diffs, config), ...suppressions(diffs, config), ...size(diffs, config, fileLines([rel]), 'edit'), ...secretsInDiff(diffs), ...rulesSensor(diffs, rules)], slug ? [slug] : []).findings
}

const slugsIn = (diffs: FileDiff[]): string[] => [...new Set(diffs.map(d => /^\.sdlc\/changes\/([^/]+)\//.exec(d.file)?.[1]).filter((s): s is string => Boolean(s)))]

function report(point: string, result: CheckResult, count: number, json: boolean): void {
  if (json) return out(JSON.stringify(result))
  const text = formatFindings(result.findings)
  out(text || `sdlc check ${point}: pass (${count} file(s) checked${result.waived ? `, ${result.waived} waived` : ''})`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) fs.appendFileSync(summary, `## sdlc check (${point})\n\n${text ? '```\n' + text + '\n```' : 'pass'}\n`)
}

export function cmdCheck(args: Args): void {
  const at = optString(args, 'at')
  if (at !== 'stop' && at !== 'ship' && at !== 'ci') fail('usage: check --at stop|ship|ci [--base <ref>] [--config-from <ref>] [--slug <s>] [--budget-ms <n>] [--json]')
  const { config, rules, errors } = loadConfig(optString(args, 'config-from') ?? null)
  const baseRef = optString(args, 'base')
  const base = baseRef ? git(['merge-base', 'HEAD', baseRef]) : defaultBase()
  if (at === 'ci' && !base) fail('check --at ci needs --base <ref> with a merge-base (fetch with fetch-depth: 0)')
  let diffs: FileDiff[]
  let before: (f: string) => string
  if (at === 'stop') {
    const snap = readBaseline() ?? snapshot()
    if (!snap) return out('sdlc check stop: nothing to compare against (no commits yet)')
    diffs = turnDiff(snap)
    before = f => showAt(snap.sha, f) ?? ''
  } else {
    diffs = branchDiff(base ?? 'HEAD')
    before = f => showAt(base ?? 'HEAD', f) ?? ''
  }
  const slugArg = optString(args, 'slug')
  const slugs = slugArg ? [slugArg] : at === 'ci' ? slugsIn(diffs) : [activeSlug()].filter((s): s is string => Boolean(s))
  const budgetMs = Number(optString(args, 'budget-ms') ?? (at === 'stop' ? 60_000 : 1_800_000))
  const result = runChecks({ point: at, diffs, config, rules, slugs, commands: at === 'stop' ? 'fast' : 'full', budgetMs, before, base })
  const configFindings: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: SENSORS_JSON, message: e, fix: 'fix the file; see the sdlc README for its format' }))
  const all = { ...result, findings: [...configFindings, ...result.findings], blocks: [...configFindings, ...result.blocks] }
  report(at, all, diffs.length, Boolean(args.opt.json))
  process.exitCode = all.blocks.length ? 1 : 0
}

export function cmdCheckFile(args: Args): void {
  const rel = args.pos[0]
  if (!rel || !exists(SDLC)) fail('usage: check-file <path> [--json]  (in an sdlc repo)')
  const findings = editFindings(rel)
  if (args.opt.json) return out(JSON.stringify(findings))
  out(formatFindings(findings) || `${rel}: ok`)
}
```

In `sdlc.ts`, import `cmdCheck` and `cmdCheckFile` from `./check.ts`, and register `check: cmdCheck` and `'check-file': cmdCheckFile`.

**Also make the CI point fail closed.** In the main `catch` of `sdlc.ts`, after the `if (command === 'hook')` branch, add:

```ts
  else if (command === 'check') fail(`sdlc check crashed (fails closed): ${message}`)
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/
git commit -m "feat: sdlc check orchestrates sensors, declared commands with budget, known-red ratchet and waivers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Contract impact: retired identifiers, the consumer grep, the plan point and the `impact` gate

**Files:**
- Modify:
  - `scripts/sensors.ts`: `RETIRE_PATTERNS`, `retiredIdentifiers`, `contractsFromPlan`
  - `scripts/core.ts`: `GatedStage` gets `'impact'`, plus `APPROVAL_ARTIFACTS`, `approvalOf`, the impact gate in `loadChange`, and `nextCommand`
  - `scripts/check.ts`: `consumerHits`, `contractFindings`, the plan point
  - `scripts/sdlc.ts`: `cmdApprove` artifact lookup
  - `hooks/register.tsx`: the approve argument hint
- Test: `scripts/sensors.spec.ts`, `scripts/check.spec.ts`

**Interfaces:**
- Produces from `sensors.ts`:
  - `RETIRE_PATTERNS: RegExp[]`
  - `retiredIdentifiers(diffs: FileDiff[], cfg: SensorConfig, producerContractText: string): string[]`
  - `contractsFromPlan(planText: string): string[]`, which reads lines in `## Contracts` of the form ``- rename `a` → `b` `` or ``- remove `a` ``
- Produces from `core.ts`:
  - `type GatedStage = 'intent' | 'spec' | 'plan' | 'impact'`
  - `APPROVAL_ARTIFACTS: Record<GatedStage, string>`
  - `approvalOf(slug: string, gate: GatedStage): 'approved' | 'stale' | 'missing'`
  - `type ImpactHit = { consumer: string; file: string; line: number; id: string }`
  - `type Impact = { at: string; ids: string[]; hits: ImpactHit[]; missing: string[] }`
  - `readImpact(slug: string): Impact | null`
- Produces from `check.ts`:
  - `consumerHits(ids: string[], cfg: SensorConfig): { hits: ImpactHit[]; missing: string[] }`
  - `contractFindings(i: CheckInput): Finding[]`, sensor `'contract-impact'`
  - CLI `check --at plan [--slug s]`, which writes `.sdlc/changes/<slug>/impact.json` and, when there are hits, sets the intent tier to `L`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sensors.spec.ts` (and add `retiredIdentifiers, contractsFromPlan` to the import):

```ts
test('retired identifiers: removed tokens from contract files, minus generic words and names still present', () => {
  const schema = fd('schema/billing.sql', ['  promotional_discount NUMERIC,'], ['  discount_rate NUMERIC,', '  id SERIAL,'])
  assert.deepEqual(retiredIdentifiers([schema], CFG, 'CREATE TABLE billing (id SERIAL, promotional_discount NUMERIC)'), ['discount_rate'])
  assert.deepEqual(retiredIdentifiers([schema], CFG, 'discount_rate is still exported in api/v1'), [])
  assert.deepEqual(retiredIdentifiers([fd('src/billing.ts', [], ['discount_rate'])], CFG, ''), [], 'only contract files count')
})

test('retired identifiers: migration-style renames and drops in added lines', () => {
  const mig = fd('migrations/0042_rename.sql', ['ALTER TABLE billing RENAME COLUMN discount_rate TO promotional_discount;', 'ALTER TABLE billing DROP COLUMN legacy_code;'], [], 'A')
  assert.deepEqual(retiredIdentifiers([mig], CFG, 'CREATE TABLE billing (discount_rate NUMERIC)').sort(), ['discount_rate', 'legacy_code'])
  const rails = fd('migrations/20261003_rename.rb', ['    rename_column :billing, :discount_rate, :promotional_discount'], [], 'A')
  assert.deepEqual(retiredIdentifiers([rails], CFG, ''), ['discount_rate'])
})

test('contractsFromPlan reads rename and remove lines only', () => {
  const plan = '## Contracts\n- rename `discount_rate` → `promotional_discount`\n- remove `legacy_code`\n- add `currency`\n## Risks\n- rename `x`\n'
  assert.deepEqual(contractsFromPlan(plan), ['discount_rate', 'legacy_code'])
  assert.deepEqual(contractsFromPlan('## Contracts\nnone\n'), [])
})
```

Append to `scripts/check.spec.ts`:

```ts
function consumerRepo(name: string, file: string, text: string): string {
  const dir = path.join(path.dirname(repo), `${path.basename(repo)}-${name}`)
  fs.mkdirSync(dir)
  gitIn(dir, 'init', '-q', '-b', 'main')
  gitIn(dir, 'config', 'user.email', 't@example.com')
  gitIn(dir, 'config', 'user.name', 'Tester')
  write(dir, file, text)
  gitIn(dir, 'add', '.')
  gitIn(dir, 'commit', '-qm', 'init')
  return path.relative(repo, dir).split(path.sep).join('/')
}

test('Stop blocks a contract rename that a consumer still uses, naming file:line', () => {
  const rel = consumerRepo('checkout', 'src/cart.ts', 'const r = order.discount_rate\n')
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(0)"' }] })
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (discount_rate NUMERIC);\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'schema')
  hook(repo, 'prompt-submit', {})
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (promotional_discount NUMERIC);\n')
  const r = check('--at', 'stop')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[contract-impact\][\s\S]*checkout-service: src\/cart\.ts:1 still uses discount_rate/)
  assert.match(r.stdout, /run \/sdlc:start/)
})

test('the plan point records impact, escalates to tier L and requires the impact approval', () => {
  const rel = consumerRepo('invoicing', 'src/invoice.py', 'rate = row["discount_rate"]\n')
  sensors({ consumers: [{ name: 'invoicing-service', path: rel }] })
  sdlc(repo, ['new', 'rename-rate', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/rename-rate/plan.md', '## Files\n- schema/**\n## Contracts\n- rename `discount_rate` → `promotional_discount`\n## Verification\n- npm test\n')
  const r = check('--at', 'plan', '--slug', 'rename-rate')
  assert.match(r.stdout, /1 consumer reference/)
  const impact = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/rename-rate/impact.json'), 'utf8'))
  assert.equal(impact.hits[0].file, 'src/invoice.py')
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/rename-rate/intent.md'), 'utf8'), /tier: L/)
  write(repo, '.sdlc/changes/rename-rate/spec.md', '## Behaviours\nB1 rename\n')
  sdlc(repo, ['approve', 'rename-rate', 'spec'], { env: { SDLC_HUMAN: '1' } })
  sdlc(repo, ['approve', 'rename-rate', 'plan'], { env: { SDLC_HUMAN: '1' } })
  assert.match(sdlc(repo, ['status']).stdout, /\/sdlc-approve rename-rate impact/)
  sdlc(repo, ['approve', 'rename-rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.match(sdlc(repo, ['status']).stdout, /next: \/sdlc:build rename-rate/)
})

test('a declared consumer that is not checked out warns at Stop and blocks at ship and CI', () => {
  sensors({ consumers: [{ name: 'ghost', path: '../does-not-exist' }] })
  write(repo, 'schema/a.sql', 'x_col INT;\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'schema')
  hook(repo, 'prompt-submit', {})
  write(repo, 'schema/a.sql', 'y_col INT;\n')
  assert.equal(check('--at', 'stop').code, 0)
  assert.equal(check('--at', 'ship').code, 1)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts scripts/check.spec.ts`
Expected: FAIL. `retiredIdentifiers` is not exported, there is no `contract-impact` section, and `--at plan` is rejected.

- [ ] **Step 3: Implement the pure part in `sensors.ts`**

```ts
// Rename and drop statements whose old name lives only in added lines of a new migration file.
export const RETIRE_PATTERNS: RegExp[] = [
  /\bRENAME\s+COLUMN\s+["'`]?(\w+)["'`]?\s+TO\b/i,
  /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)/i,
  /\bALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+TO\b/i,
  /\brename_column\s*\(?\s*:\w+\s*,\s*:(\w+)/,
  /\bremove_column\s*\(?\s*:\w+\s*,\s*:(\w+)/,
  /\bRenameField\s*\([^)]*old_name\s*=\s*["'](\w+)["']/,
  /\bRemoveField\s*\([^)]*name\s*=\s*["'](\w+)["']/,
  /\brenameColumn\s*\(\s*["'](\w+)["']/,
  /\bdropColumn\s*\(\s*["'](\w+)["']/,
]

const STOP_WORDS = new Set([
  'id', 'name', 'type', 'string', 'number', 'integer', 'int', 'value', 'data', 'text', 'true', 'false', 'null', 'table', 'column',
  'create', 'alter', 'drop', 'not', 'default', 'primary', 'key', 'references', 'varchar', 'numeric', 'serial', 'boolean', 'timestamp',
  'message', 'service', 'rpc', 'returns', 'optional', 'required', 'repeated', 'import', 'package', 'syntax', 'option', 'enum', 'oneof',
  'properties', 'items', 'object', 'array', 'description', 'format', 'schema', 'paths', 'get', 'post', 'put', 'patch', 'delete',
])
const TOKEN = /[A-Za-z_][A-Za-z0-9_]{2,}/g
const tokens = (lines: { text: string }[]): Set<string> => new Set(lines.flatMap(l => l.text.match(TOKEN) ?? []))
const MAX_IDS = 50

export function retiredIdentifiers(diffs: FileDiff[], cfg: SensorConfig, producerContractText: string): string[] {
  const stillThere = new Set(producerContractText.match(TOKEN) ?? [])
  const ids = new Set<string>()
  for (const d of diffs.filter(f => matchesAny(f.file, cfg.contracts) && !f.binary)) {
    const added = tokens(d.added)
    for (const t of tokens(d.removed)) if (!added.has(t) && !stillThere.has(t)) ids.add(t)
    for (const l of d.added) for (const re of RETIRE_PATTERNS) {
      const m = re.exec(l.text)
      if (m?.[1]) ids.add(m[1])
    }
  }
  return [...ids].filter(t => !STOP_WORDS.has(t.toLowerCase()) && !/^\d/.test(t)).slice(0, MAX_IDS)
}

export function contractsFromPlan(planText: string): string[] {
  const section = /^##\s+Contracts\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(planText)?.[1] ?? ''
  return section
    .split('\n')
    .map(row => /^\s*[-*]\s*(?:rename|remove|drop|retire)\s+`([A-Za-z_]\w*)`/i.exec(row)?.[1])
    .filter((id): id is string => Boolean(id))
}
```

- [ ] **Step 4: Add the impact gate to `core.ts`**

Change `GatedStage` to `'intent' | 'spec' | 'plan' | 'impact'`. Change `Next`'s approve variant to `{ stage: Stage; kind: 'approve'; state: ApprovalState; gate: GatedStage }`, and set `gate: stage as GatedStage` where the loop builds it. Then add:

```ts
export const APPROVAL_ARTIFACTS: Record<GatedStage, string> = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md', impact: 'plan.md' }
export type ImpactHit = { consumer: string; file: string; line: number; id: string }
export type Impact = { at: string; ids: string[]; hits: ImpactHit[]; missing: string[] }

export function approvalOf(slug: string, gate: GatedStage): ApprovalState {
  const latest = readJsonl<Approval>(APPROVALS).filter(a => a.slug === slug && a.stage === gate).at(-1)
  if (!latest) return 'missing'
  return latest.digest === sha(read(path.join(CHANGES, slug, APPROVAL_ARTIFACTS[gate]))) ? 'approved' : 'stale'
}

export function readImpact(slug: string): Impact | null {
  try {
    return JSON.parse(read(path.join(CHANGES, slug, 'impact.json'))) as Impact
  } catch {
    return null
  }
}
```

In `loadChange`:
1. Replace the local `approvalState` with `(gate: GatedStage) => approvalOf(slug, gate)`.
2. After the line `if ((gates as Stage[]).includes(stage) && approvalState(stage) !== 'approved') {...}` inside the loop, add:

```ts
    if (stage === 'plan' && readImpact(slug)?.hits.length && approvalState('impact') !== 'approved') {
      next = { stage, kind: 'approve', state: approvalState('impact'), gate: 'impact' }
      break
    }
```

In `nextCommand`, use the gate:

```ts
  if (next.kind === 'approve') {
    const why = next.state === 'stale' ? ' (approval is stale: the artifact changed after it was approved)' : ''
    const what = next.gate === 'impact' ? `the cross-repo impact in ${change.slug}/impact.json and plan.md` : `${change.slug}/${APPROVAL_ARTIFACTS[next.gate]}`
    return `human gate: review ${what}, then run /sdlc-approve ${change.slug} ${next.gate}${why}`
  }
```

In `sdlc.ts` `cmdApprove`, replace `const artifact = ARTIFACTS[stage as Stage]` with `const artifact = APPROVAL_ARTIFACTS[stage as GatedStage]`. In `hooks/register.tsx`, change the approve `argumentHint` to `'<slug> <intent|spec|plan|impact>'`.

- [ ] **Step 5: Add the consumer grep and the plan point to `check.ts`**

Add these imports: `CHANGES`, `approvalOf`, `readImpact`, `type ImpactHit` and `gitIn` from core; `retiredIdentifiers` and `contractsFromPlan` from sensors; `matchesAny` from model. Then add:

```ts
export function consumerHits(ids: string[], cfg: SensorConfig): { hits: ImpactHit[]; missing: string[] } {
  const hits: ImpactHit[] = []
  const missing: string[] = []
  for (const c of cfg.consumers) {
    const dir = path.resolve(ROOT, c.path)
    if (!exists(dir)) {
      missing.push(c.name)
      continue
    }
    for (const id of ids) {
      for (const row of (gitIn(dir, ['grep', '-n', '-w', '-F', '-e', id]) ?? '').split('\n').filter(Boolean)) {
        const m = /^(.*?):(\d+):/.exec(row)
        if (m) hits.push({ consumer: c.name, file: m[1] ?? '', line: Number(m[2]), id })
      }
    }
  }
  return { hits, missing }
}

function producerContractText(cfg: SensorConfig): string {
  const files = (git(['ls-files']) ?? '').split('\n').filter(f => matchesAny(f, cfg.contracts))
  return files.map(f => read(path.join(ROOT, f))).join('\n')
}

export function contractFindings(i: CheckInput): Finding[] {
  const ids = retiredIdentifiers(i.diffs, i.config, producerContractText(i.config))
  if (!ids.length || !i.config.consumers.length) return []
  const { hits, missing } = consumerHits(ids, i.config)
  const approved = i.slugs.some(s => approvalOf(s, 'impact') === 'approved')
  const atStop = i.point === 'stop'
  return [
    ...hits.map((h): Finding => ({
      sensor: 'contract-impact',
      severity: atStop && approved ? 'warn' : 'block',
      message: `${h.consumer}: ${h.file}:${h.line} still uses ${h.id}`,
      fix: approved ? `update ${h.consumer} as part of this change (it is in the approved impact)` : 'cross-repo contract change: this needs a gated change. Run /sdlc:start, then plan it with ## Contracts so the person approves the impact',
    })),
    ...missing.map((name): Finding => ({
      sensor: 'contract-impact',
      severity: atStop ? 'warn' : 'block',
      message: `consumer ${name} is not checked out, so ${ids.length} retired identifier(s) cannot be verified`,
      fix: `check out ${name} at its declared path (CI: set the SDLC_CONSUMERS_TOKEN secret)`,
    })),
  ]
}

function setTierL(slug: string): void {
  const file = path.join(CHANGES, slug, 'intent.md')
  fs.writeFileSync(file, read(file).replace(/^tier:\s*[SM]\s*$/m, 'tier: L'))
}

export function cmdCheckPlan(args: Args): void {
  const slug = optString(args, 'slug') ?? activeSlug()
  if (!slug) fail('check --at plan needs an active change or --slug')
  const { config } = loadConfig()
  const ids = contractsFromPlan(read(path.join(CHANGES, slug, 'plan.md')))
  const { hits, missing } = consumerHits(ids, config)
  fs.writeFileSync(path.join(CHANGES, slug, 'impact.json'), JSON.stringify({ at: new Date().toISOString(), ids, hits, missing }, null, 2) + '\n')
  if (!hits.length) return out(`impact: ${ids.length} contract identifier(s), no consumer references${missing.length ? `; not checked out: ${missing.join(', ')}` : ''}`)
  setTierL(slug)
  const rows = hits.slice(0, 20).map(h => `  ${h.consumer}: ${h.file}:${h.line} uses ${h.id}`)
  out([`impact: ${hits.length} consumer reference${hits.length === 1 ? '' : 's'} across ${new Set(hits.map(h => h.consumer)).size} repo(s). The change is now tier L and needs /sdlc-approve ${slug} impact.`, ...rows, 'Add the consumer files to plan ## Files (as ../<repo>/... globs) and each consumer test to ## Verification.'].join('\n'))
}
```

Finally:
- In `runChecks`, after `rulesSensor`, add the line `...contractFindings(i),` to the `findings` array.
- In `cmdCheck`, make the first line `if (optString(args, 'at') === 'plan') return cmdCheckPlan(args)`.
- Add `plan` to its usage string.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/ hooks/register.tsx
git commit -m "feat: contract-impact sensor, cross-repo consumer grep and the impact human gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Harness-tamper, consumer edit guard and least privilege

**Files:**
- Modify:
  - `scripts/sensors.ts`: `PROTECTED`, `isProtected`, `weakensConfig`, `weakensRules`, `onlyKnownRedRemoved`, `harnessTamper`
  - `scripts/check.ts`: wire `harnessTamper` into `runChecks`
  - `scripts/hooks.ts`: `hookPreEdit` and `hookPreBash`
- Test: `scripts/sensors.spec.ts`, `scripts/gate.spec.ts`

**Interfaces:**
- Produces from `sensors.ts`:
  - `PROTECTED: string[]`
  - `isProtected(file: string): boolean`
  - `weakensConfig(before: string, after: string): string[]`
  - `weakensRules(before: string, after: string): string[]`
  - `onlyKnownRedRemoved(before: string, after: string): boolean`
  - `harnessTamper(diffs: FileDiff[], o: { point: 'stop'|'ship'|'ci'; toolEdited?: Set<string>; before: (f: string) => string; after: (f: string) => string }): Finding[]`, sensor `'harness-tamper'`, labelled `'weakens-harness'`
- Behaviour:
  - PreToolUse Write/Edit on a protected path returns **ask**, and the reason lists what gets weaker.
  - An edit to a sibling path (`../<dir>/…`) is **denied** unless that dir is a declared consumer, the active change has `impact` approved, and the path is in plan `## Files`.
  - Bash commands that write files are **denied** for `agent_type` values ending in `scout`, `reviewer` or `verifier`, except `sdlc.ts` recorder commands.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sensors.spec.ts` (add `weakensConfig, onlyKnownRedRemoved, harnessTamper` to the import):

```ts
const J = (o: object) => JSON.stringify(o, null, 2)

test('weakensConfig names every loosening and nothing else', () => {
  const before = J({ fast: { lint: 'eslint .', test: 'npm test' }, limits: { diffLines: 500 }, layers: [{ from: 'src/domain/**', mustNotImport: ['infra'], why: 'w' }], knownRed: [] })
  const after = J({ fast: { test: 'npm test' }, limits: { diffLines: 900 }, layers: [], knownRed: ['fast.test'], ignore: ['**/*.md', '**/*.lock', '**/package-lock.json', 'src/**'] })
  const reasons = weakensConfig(before, after).join('\n')
  for (const r of [/diffLines raised 500 → 900/, /fast\.lint removed/, /layer src\/domain\/\*\* removed/, /knownRed added fast\.test/, /ignore added src\/\*\*/]) assert.match(reasons, r)
  assert.deepEqual(weakensConfig(before, J({ fast: { lint: 'eslint . --max-warnings 0', test: 'npm test' }, limits: { diffLines: 400 }, layers: [{ from: 'src/domain/**', mustNotImport: ['infra', 'http'], why: 'w' }] })), [])
  assert.deepEqual(weakensConfig(before, '{ broken'), ['sensors.json no longer parses'])
})

test('onlyKnownRedRemoved accepts the ratchet and nothing more', () => {
  const before = J({ fast: { lint: 'x' }, knownRed: ['fast.lint'] })
  assert.ok(onlyKnownRedRemoved(before, J({ fast: { lint: 'x' }, knownRed: [] })))
  assert.ok(!onlyKnownRedRemoved(before, J({ fast: { lint: 'y' }, knownRed: [] })))
})

test('harnessTamper: Bash-made edits block at Stop, weakening blocks at ship, plain edits warn', () => {
  const cfgDiff = fd('.sdlc/sensors.json', ['x'], ['y'])
  const before = () => J({ limits: { diffLines: 500 } })
  const weaker = () => J({ limits: { diffLines: 900 } })
  const viaBash = harnessTamper([cfgDiff], { point: 'stop', toolEdited: new Set(), before, after: weaker })
  assert.match(viaBash[0]?.message ?? '', /outside Write\/Edit/)
  assert.equal(viaBash[0]?.severity, 'block')
  assert.equal(harnessTamper([cfgDiff], { point: 'stop', toolEdited: new Set(['.sdlc/sensors.json']), before, after: weaker })[0]?.severity, 'warn')
  const ship = harnessTamper([cfgDiff], { point: 'ship', before, after: weaker })
  assert.deepEqual([ship[0]?.severity, ship[0]?.labels], ['block', ['weakens-harness']])
  assert.equal(harnessTamper([fd('CLAUDE.md', ['more'])], { point: 'ci', before: () => '', after: () => '' })[0]?.severity, 'warn')
  assert.deepEqual(harnessTamper([fd('src/a.ts', ['x'])], { point: 'stop', toolEdited: new Set(), before, after: before }), [])
})
```

Append to `scripts/gate.spec.ts`:

```ts
const decision = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined)
const reasonOf = (r: { stdout: string }) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason as string

test('editing a protected harness file asks the person, naming what gets weaker', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  const r = hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, '.sdlc/sensors.json'), old_string: '500', new_string: '5000' } })
  assert.equal(decision(r), 'ask')
  assert.match(reasonOf(r), /diffLines raised 500 → 5000/)
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, 'CLAUDE.md'), content: '# x' } })), 'ask')
})

test('sibling repo edits are denied unless the consumer is in an approved impact and the plan', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: '../checkout' }] }))
  const consumerFile = path.join(path.dirname(repo), 'checkout', 'src', 'cart.ts')
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(path.dirname(repo), 'other', 'x.ts') } })), 'deny')
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: consumerFile } })), 'deny')
  sdlc(repo, ['new', 'rate', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/rate/plan.md', '## Files\n- schema/**\n- ../checkout/src/**\n')
  sdlc(repo, ['approve', 'rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: consumerFile } })), undefined)
  assert.equal(hook(repo, 'pre-edit', { tool_input: { file_path: '/private/tmp/scratch/notes.md' } }).stdout, '', 'paths beyond siblings are left to normal permissions')
})

test('read-only agents cannot write files through Bash; their reads and the sdlc recorder are fine', () => {
  sdlc(repo, ['init'])
  const as = (agent_type: string, command: string) => decision(hook(repo, 'pre-bash', { agent_type, tool_input: { command } }))
  assert.equal(as('sdlc:reviewer', 'echo fixed > src/app.js'), 'deny')
  assert.equal(as('sdlc:verifier', "sed -i '' 's/a/b/' src/app.js"), 'deny')
  assert.equal(as('sdlc:scout', 'git checkout -- src/app.js'), 'deny')
  assert.equal(as('sdlc:reviewer', 'git diff main...HEAD 2>&1 | tail -50'), undefined)
  assert.equal(as('sdlc:verifier', 'node /x/scripts/sdlc.ts run -- "npm test"'), undefined)
  assert.equal(as('sdlc:implementer', 'echo x > src/app.js'), undefined)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts scripts/gate.spec.ts`
Expected: FAIL, because `weakensConfig` is not exported and the protected edit has no decision.

- [ ] **Step 3: Implement the pure part in `sensors.ts`**

Add `parseConfig` and `parseRules` to the `./model.ts` import, then append:

```ts
export const PROTECTED = ['.sdlc/sensors.json', '.sdlc/rules.json', '.sdlc/guides/**', '.sdlc/bin/**', 'CLAUDE.md', '.claude/**', '.github/workflows/sdlc-check.yml', 'CODEOWNERS', '.github/CODEOWNERS']
export const isProtected = (file: string): boolean => matchesAny(file, PROTECTED)
const SENSORS = '.sdlc/sensors.json'
const RULES = '.sdlc/rules.json'

const removedFrom = (before: string[], after: string[]): string[] => before.filter(x => !after.includes(x))

export function weakensConfig(beforeText: string, afterText: string): string[] {
  const after = parseConfig(afterText)
  if (after.errors.some(e => /not valid JSON|must be a JSON object/.test(e))) return ['sensors.json no longer parses']
  const b = parseConfig(beforeText).config
  const a = after.config
  const reasons: string[] = []
  for (const k of ['fileLines', 'diffLines'] as const) if (a.limits[k] > b.limits[k]) reasons.push(`limits.${k} raised ${b.limits[k]} → ${a.limits[k]}`)
  for (const k of ['tests', 'contracts'] as const) for (const g of removedFrom(b[k], a[k])) reasons.push(`${k} glob removed ${g}`)
  for (const g of removedFrom(a.ignore, b.ignore)) reasons.push(`ignore added ${g}`)
  for (const k of removedFrom(a.knownRed, b.knownRed)) reasons.push(`knownRed added ${k}`)
  for (const p of ['fast', 'full'] as const) for (const name of removedFrom(Object.keys(b[p]), Object.keys(a[p]))) reasons.push(`${p}.${name} removed`)
  for (const c of removedFrom(b.consumers.map(x => x.name), a.consumers.map(x => x.name))) reasons.push(`consumer ${c} removed`)
  for (const l of b.layers) {
    const now = a.layers.find(x => x.from === l.from)
    if (!now) reasons.push(`layer ${l.from} removed`)
    else for (const t of removedFrom(l.mustNotImport, now.mustNotImport)) reasons.push(`layer ${l.from} now allows ${t}`)
  }
  return reasons
}

export function weakensRules(beforeText: string, afterText: string): string[] {
  const b = parseRules(beforeText).rules
  const a = parseRules(afterText).rules
  const reasons = removedFrom(b.map(r => r.id), a.map(r => r.id)).map(id => `rule ${id} removed`)
  for (const r of b) if (r.action === 'block' && a.find(x => x.id === r.id)?.action === 'warn') reasons.push(`rule ${r.id} downgraded to warn`)
  return reasons
}

export function onlyKnownRedRemoved(beforeText: string, afterText: string): boolean {
  try {
    const b = JSON.parse(beforeText) as Record<string, unknown> & { knownRed?: string[] }
    const a = JSON.parse(afterText) as Record<string, unknown> & { knownRed?: string[] }
    const { knownRed: kb = [], ...restB } = b
    const { knownRed: ka = [], ...restA } = a
    return JSON.stringify(restA) === JSON.stringify(restB) && ka.every(k => kb.includes(k))
  } catch {
    return false
  }
}

export function harnessTamper(diffs: FileDiff[], o: { point: 'stop' | 'ship' | 'ci'; toolEdited?: Set<string>; before: (f: string) => string; after: (f: string) => string }): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => isProtected(f.file))) {
    const reasons = d.file === SENSORS ? weakensConfig(o.before(d.file), o.after(d.file)) : d.file === RULES ? weakensRules(o.before(d.file), o.after(d.file)) : d.status === 'D' ? [`${d.file} deleted`] : []
    if (o.point === 'stop') {
      if (o.toolEdited && !o.toolEdited.has(d.file)) {
        if (d.file === SENSORS && onlyKnownRedRemoved(o.before(d.file), o.after(d.file))) continue
        findings.push({ sensor: 'harness-tamper', severity: 'block', file: d.file, message: 'harness file changed outside Write/Edit (via Bash?)', fix: `revert it (git checkout -- ${d.file}), or ask the person to make this change` })
      } else if (reasons.length) {
        findings.push({ sensor: 'harness-tamper', severity: 'warn', file: d.file, message: reasons.join('; '), fix: 'the person allowed this edit; it shows in the review brief', labels: ['weakens-harness'] })
      }
      continue
    }
    findings.push(reasons.length
      ? { sensor: 'harness-tamper', severity: 'block', file: d.file, message: reasons.join('; '), fix: `a person must approve: /sdlc-waive harness-tamper ${d.file} <reason>`, labels: ['weakens-harness'] }
      : { sensor: 'harness-tamper', severity: 'warn', file: d.file, message: 'harness file changed', fix: 'needs human review' })
  }
  return findings
}
```

- [ ] **Step 4: Wire it into `runChecks` in `check.ts`**

Add `harnessTamper` to the sensors import, then add this line to the `findings` array in `runChecks`:

```ts
    ...harnessTamper(diffs, { point: i.point, toolEdited: i.toolEdited, before: i.before, after: f => read(path.join(ROOT, f)) }),
```

- [ ] **Step 5: Guard the edits and the Bash commands in `hooks.ts`**

Add these imports: `isProtected`, `weakensConfig` and `weakensRules` from `./sensors.ts`; `loadConfig` from `./check.ts`; `approvalOf` from `./core.ts`. Then add:

```ts
// The text a Write/Edit would leave behind, so a weakening is shown before it happens.
function proposed(file: string, t: HookInput['tool_input']): string | null {
  if (typeof t?.content === 'string') return t.content
  if (typeof t?.old_string !== 'string' || typeof t?.new_string !== 'string') return null
  const current = read(file)
  return t.replace_all ? current.split(t.old_string).join(t.new_string) : current.replace(t.old_string, t.new_string)
}

function protectedEditReason(file: string, rel: string, t: HookInput['tool_input']): string {
  const after = proposed(file, t)
  const reasons = after === null ? [] : rel === '.sdlc/sensors.json' ? weakensConfig(read(file), after) : rel === '.sdlc/rules.json' ? weakensRules(read(file), after) : []
  return reasons.length
    ? `This edit weakens the harness: ${reasons.join('; ')}. Allow it only if you, the person, want this.`
    : `${rel} is part of the harness (peer-reviewed config). Allow this edit?`
}

// Sibling repos (../<dir>/...) are consumers at most: writable only inside an approved cross-repo change.
function siblingEditReason(rel: string): string | null {
  const { config } = loadConfig()
  const consumer = config.consumers.find(c => rel.startsWith(toPosix(path.normalize(c.path)).replace(/\/$/, '') + '/'))
  if (!consumer) return `${rel} is outside this repo and not a declared consumer. Edit only this repo.`
  const slug = activeSlug()
  if (!slug || approvalOf(slug, 'impact') !== 'approved') return `${consumer.name} is a consumer repo: edit it only in a change whose cross-repo impact the person approved (/sdlc-approve <slug> impact).`
  if (!isPlanned(rel, planFiles(slug))) return `${rel} is not in ${slug}/plan.md ## Files. Add it to the plan first.`
  return null
}

const READ_ONLY_AGENT = /(?:^|:)(?:scout|reviewer|verifier)$/
const WRITES_FILES = /(?:^|[^0-9&>])>{1,2}(?!\s*&|\s*\/dev\/null)|\btee\b|\bsed\s+-i|\bperl\s+-i|\b(?:cp|mv|rm|rmdir|truncate|dd|touch|mkdir|chmod|ln)\s|\bgit\s+(?:add|commit|checkout|restore|reset|apply|stash|push|rebase|merge|cherry-pick|rm|mv|tag)\b|\b(?:npm|pnpm|yarn)\s+(?:install|i|add|remove|uninstall)\b|\bpip3?\s+install\b/
const SDLC_RECORDER = /sdlc\.ts["']?\s+(?:run|verify-report|check|check-file|status|skill|diff|scope-drift)\b/
```

In `hookPreBash`, right after `if (!exists(SDLC)) return`, add:

```ts
  const agent = input.agent_type ?? ''
  if (READ_ONLY_AGENT.test(agent) && WRITES_FILES.test(cmd) && !SDLC_RECORDER.test(cmd)) {
    return decide('deny', `${agent} is read-only: it reports and never edits. Record test runs with sdlc.ts run; leave fixes to the implementer.`)
  }
```

In `hookPreEdit`, after the evidence check and `if (!exists(SDLC)) return`, add:

```ts
  const rel = relPosix(file)
  if (/^\.\.\/[^/]+\//.test(rel) && !rel.startsWith('../../')) {
    const reason = siblingEditReason(rel)
    if (reason) return decide('deny', reason)
    return
  }
  if (isProtected(rel)) return decide('ask', protectedEditReason(file, rel, input.tool_input))
```

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/
git commit -m "feat: harness-tamper sensor, consumer-repo edit guard and read-only agent enforcement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The Stop gate: per-agent baselines, edit records, per-file checks, loop cap and ad-hoc changes

**Files:**
- Modify:
  - `scripts/core.ts`: add `createChange`. `cmdNew` in `sdlc.ts` then calls it.
  - `scripts/hooks.ts`: gate state, plus `hookSubagentStart`, `hookPostEdit`, `hookStop`, and the `prompt-submit` reset
  - `hooks/hooks.json`
- Test: `scripts/gate.spec.ts`

**Interfaces:**
- Consumes: from `check.ts` (Task 8), `runChecks`, `loadConfig` and `editFindings`. From `diffs.ts` (Task 7), `readBaseline`, `writeBaseline`, `snapshot`, `turnDiff`, `showAt` and `diffHash`. From `model.ts`, `formatFindings`, `isSource` and `matchesAny`. From `sensors.ts`, `isProtected`.
- Produces from `core.ts`: `createChange(slug: string, type: ChangeType, tier: Tier, title: string): void`
- Produces from `sensors.ts`: `tierFromDiff(diffs: FileDiff[], cfg: SensorConfig): 'S' | 'M' | 'L'`, computed over source files only. Task 12 recomputes an ad-hoc change's tier with it at ship.
- Produces from `hooks.ts`:
  - `type GateSummary = { at: string; blocks: number; warns: number; bySensor: Record<string, number> }`
  - `readGate(): Gate`, where `type Gate = { turn: string; blocks: Record<string, number>; passed: Record<string, string>; tool: string[]; agents: Record<string, string[]>; guides: Record<string, string[]>; last?: GateSummary }`
  - Task 18 uses `readGate`.
- Hook names: `subagent-start`, `stop` and `subagent-stop`. `post-edit` and `prompt-submit` are extended.
- Stop output:
  - On block: `{"decision":"block","reason":"sdlc quality gate (attempt n/2): …"}`
  - Past the cap: `{"systemMessage":"sdlc quality gate: N problem(s) unresolved after 2 attempts …"}`, and `.sdlc/unresolved.json` is written

- [ ] **Step 1: Write the failing tests**

Append to `scripts/gate.spec.ts`:

```ts
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
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
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

test('SubagentStop judges only files that agent edited, and runs no project commands', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'1\')"' } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  hook(repo, 'subagent-start', { agent_id: 'A', agent_type: 'sdlc:implementer' })
  write(repo, 'src/a.js', 'export const a = 1\n')
  hook(repo, 'post-edit', { agent_id: 'A', tool_input: { file_path: path.join(repo, 'src/a.js') } })
  tamper()
  assert.equal(hook(repo, 'subagent-stop', { agent_id: 'A', agent_type: 'sdlc:implementer' }).stdout, '')
  assert.ok(!fs.existsSync(path.join(repo, 'ran.txt')))
  assert.equal(JSON.parse(stop().stdout).decision, 'block', 'the main Stop still sees the other file')
})

test('a harness file changed by Bash blocks at Stop; the same change through Edit only warns', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 900 } }))
  assert.match(JSON.parse(stop().stdout).reason, /outside Write\/Edit/)
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 950 } }))
  hook(repo, 'post-edit', { tool_input: { file_path: path.join(repo, '.sdlc/sensors.json') } })
  assert.equal(stop().stdout, '')
})

test('post-edit blocks a single edited file with exit 2 and records the edit', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  tamper()
  const r = hook(repo, 'post-edit', { tool_input: { file_path: path.join(repo, 'test/a.test.js') } })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /test skipped or focused/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/.gate'), 'utf8')).tool, ['test/a.test.js'])
})

test('a corrupt gate file never wedges the session', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  fs.writeFileSync(path.join(repo, '.sdlc/.gate'), '{not json')
  tamper()
  assert.equal(JSON.parse(stop().stdout).decision, 'block')
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/gate.spec.ts`
Expected: FAIL, because `stop` is an unknown hook.

- [ ] **Step 3: Move change creation into `core.ts`**

```ts
export function createChange(slug: string, type: ChangeType, tier: Tier, title: string): void {
  const dir = path.join(CHANGES, slug)
  if (!exists(SDLC)) fs.mkdirSync(CHANGES, { recursive: true })
  ensureGitignore()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'intent.md'), intentTemplate(slug, type, tier, title))
  setActive(slug)
}
```

In `sdlc.ts` `cmdNew`, replace the five lines from `if (!exists(SDLC)) cmdInit()` through `setActive(slug)` with:

```ts
  if (!exists(SDLC)) cmdInit()
  createChange(slug, type, tier, optString(args, 'title') ?? slug)
```

- [ ] **Step 4: Add the gate state and the hooks to `hooks.ts`**

First, append the tier rule to `sensors.ts`, so Stop and ship share it:

```ts
// Tier of work done without /sdlc:start, from what it touches: contracts or > 15 files is L, > 3 is M.
export function tierFromDiff(diffs: FileDiff[], cfg: SensorConfig): 'S' | 'M' | 'L' {
  const files = diffs.filter(d => isSource(d.file, cfg))
  if (files.some(d => matchesAny(d.file, cfg.contracts)) || files.length > 15) return 'L'
  return files.length > 3 ? 'M' : 'S'
}
```

Then, in `hooks.ts`:

```ts
export type GateSummary = { at: string; blocks: number; warns: number; bySensor: Record<string, number> }
export type Gate = { turn: string; blocks: Record<string, number>; passed: Record<string, string>; tool: string[]; agents: Record<string, string[]>; guides: Record<string, string[]>; last?: GateSummary }

const GATE = path.join(SDLC, '.gate')
const UNRESOLVED = path.join(SDLC, 'unresolved.json')
const MAX_BLOCKS = 2
const STOP_BUDGET_MS = 60_000
const emptyGate = (): Gate => ({ turn: '', blocks: {}, passed: {}, tool: [], agents: {}, guides: {} })

export function readGate(): Gate {
  try {
    return { ...emptyGate(), ...(JSON.parse(read(GATE)) as Partial<Gate>) }
  } catch {
    return emptyGate()
  }
}
const writeGate = (g: Gate): void => fs.writeFileSync(GATE, JSON.stringify(g))
const pushUnique = (list: string[], item: string): string[] => (list.includes(item) ? list : [...list, item])

function summarize(findings: Finding[]): GateSummary {
  const bySensor: Record<string, number> = {}
  for (const f of findings) bySensor[f.sensor] = (bySensor[f.sensor] ?? 0) + 1
  return { at: now(), blocks: findings.filter(f => f.severity === 'block').length, warns: findings.filter(f => f.severity === 'warn').length, bySensor }
}

function createAdhoc(diffs: FileDiff[], config: SensorConfig): string {
  const tier: Tier = tierFromDiff(diffs, config)
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12)
  let slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}`
  for (let n = 2; exists(path.join(CHANGES, slug)); n++) slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}-${n}`
  createChange(slug, 'chore', tier, 'Ad-hoc change made without /sdlc:start')
  return slug
}
```

Replace `hookPromptSubmit` with a version that also resets the per-turn gate:

```ts
function hookPromptSubmit(): void {
  if (!exists(SDLC)) return
  const snap = snapshot()
  if (!snap) return
  writeBaseline(snap)
  writeGate({ ...readGate(), turn: snap.at, blocks: {}, passed: {}, tool: [], agents: {} })
}

function hookSubagentStart(input: HookInput): void {
  if (!exists(SDLC) || !input.agent_id) return
  const snap = snapshot()
  if (snap) writeBaseline(snap, input.agent_id)
}
```

Replace `hookPostEdit`:

```ts
function hookPostEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? '')
  if (!file || !exists(file)) return
  const problems = scanSecrets(file)
  if (exists(SDLC) && /\.sdlc\/changes\/[^/]+\/plan\.md$/.test(toPosix(file))) problems.push(...planProblems(file).map(p => `${file}: ${p}`))
  let edits = ''
  if (exists(SDLC)) {
    const rel = relPosix(file)
    const gate = readGate()
    gate.tool = pushUnique(gate.tool, rel)
    if (input.agent_id) gate.agents[input.agent_id] = pushUnique(gate.agents[input.agent_id] ?? [], rel)
    writeGate(gate)
    edits = formatFindings(editFindings(rel).filter(f => f.severity === 'block' && f.sensor !== 'secrets'))
  }
  if (problems.length || edits) {
    process.stderr.write(`sdlc check failed, fix before continuing:\n${[...problems, edits].filter(Boolean).join('\n')}\n`)
    process.exitCode = 2
  }
}
```

Add the Stop gate:

```ts
// The end-of-turn gate: every built-in sensor on this turn's diff, then the fast commands (main thread only).
function hookStop(input: HookInput, sub: boolean): void {
  if (!exists(SDLC)) return
  const agentId = sub ? input.agent_id : undefined
  const snap = (agentId ? readBaseline(agentId) : null) ?? readBaseline()
  if (!snap) return
  const { config, rules, errors } = loadConfig()
  const gate = readGate()
  const owned = agentId ? new Set(gate.agents[agentId] ?? []) : null
  const diffs = turnDiff(snap).filter(d => (isSource(d.file, config) || isProtected(d.file)) && (!owned || owned.has(d.file)))
  if (!diffs.length) return
  const key = agentId ?? 'main'
  const hash = diffHash(diffs) + sha(read(path.join(SDLC, 'sensors.json')))
  if (gate.passed[key] === hash) return
  let slug = activeSlug()
  if (!slug && !sub) slug = createAdhoc(diffs, config)
  const result = runChecks({
    point: 'stop', diffs, config, rules, slugs: slug ? [slug] : [], commands: sub ? 'none' : 'fast', budgetMs: STOP_BUDGET_MS,
    before: f => showAt(snap.sha, f) ?? '', toolEdited: new Set(gate.tool), base: null,
  })
  const configBlocks: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: '.sdlc/sensors.json', message: e, fix: 'fix the file' }))
  const findings = [...configBlocks, ...result.findings]
  const blocks = findings.filter(f => f.severity === 'block')
  gate.last = summarize(findings)
  if (!blocks.length) {
    gate.passed[key] = hash
    writeGate(gate)
    if (exists(UNRESOLVED)) fs.rmSync(UNRESOLVED)
    return
  }
  fs.writeFileSync(UNRESOLVED, JSON.stringify({ at: now(), slug, findings: blocks }, null, 2) + '\n')
  const attempt = (gate.blocks[key] ?? 0) + 1
  if (attempt > MAX_BLOCKS) {
    writeGate(gate)
    return out(JSON.stringify({ systemMessage: `sdlc quality gate: ${blocks.length} problem(s) unresolved after ${MAX_BLOCKS} attempts (.sdlc/unresolved.json). Ship and CI will refuse until they are fixed or the person waives them.` }))
  }
  gate.blocks[key] = attempt
  writeGate(gate)
  out(JSON.stringify({ decision: 'block', reason: `sdlc quality gate (attempt ${attempt}/${MAX_BLOCKS}): fix these before you finish.\n${formatFindings(findings)}` }))
}
```

Register these in `HOOKS`:
- `'subagent-start': hookSubagentStart`
- `stop: i => hookStop(i, false)`
- `'subagent-stop': i => hookStop(i, true)`

Add the new imports:
- `CHANGES`, `now`, `sha`, `createChange` and `type Tier` from `./core.ts`
- `readBaseline`, `turnDiff`, `showAt` and `diffHash` from `./diffs.ts`
- `runChecks` and `editFindings` from `./check.ts`
- `formatFindings`, `isSource`, `matchesAny`, `type FileDiff`, `type Finding` and `type SensorConfig` from `./model.ts`
- `tierFromDiff` from `./sensors.ts`

- [ ] **Step 5: Register the hooks**

In `hooks/hooks.json`, add these keys:

```json
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node --disable-warning=ExperimentalWarning \"${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts\" hook prompt-submit", "timeout": 15 } ] }
    ],
    "SubagentStart": [
      { "hooks": [ { "type": "command", "command": "node --disable-warning=ExperimentalWarning \"${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts\" hook subagent-start", "timeout": 15 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node --disable-warning=ExperimentalWarning \"${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts\" hook stop", "timeout": 90 } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "node --disable-warning=ExperimentalWarning \"${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts\" hook subagent-stop", "timeout": 90 } ] }
    ]
```

Then update the `description` string to: `"sdlc: session context, turn baselines, the end-of-turn quality gate, human-only approvals and waivers, evidence protection, plan ownership, harness and consumer guards, secret and plan-size checks; the mod adds usage capture, the band and zero-token commands"`.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS. The existing `post-edit blocks secrets` test still passes, because the whole-file `scanSecrets` stays in place.

- [ ] **Step 7: Commit**

```bash
git add scripts/ hooks/hooks.json
git commit -m "feat: end-of-turn quality gate with loop cap, per-agent scoping, edit records and ad-hoc changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Ship-time verdicts: traceability, recomputed proof of red, the ad-hoc rule and the ship gate

**Files:**
- Modify:
  - `scripts/sensors.ts`: `behaviourIds`, `missingBehaviours`
  - `scripts/check.ts`: `shipVerdicts`, `redProof`, `testCorpus`
  - `scripts/sdlc.ts`: run the gate inside `cmdShip`
- Test: `scripts/sensors.spec.ts`, `scripts/check.spec.ts`

**Interfaces:**
- Produces from `sensors.ts`:
  - `behaviourIds(text: string, heading: string): string[]`
  - `missingBehaviours(ids: string[], corpus: string): string[]`
- Produces from `check.ts`:
  - `shipVerdicts(slug: string, config: SensorConfig, diffs: FileDiff[], base: string | null): Finding[]`, with the sensors `'traceability'`, `'red-proof'` and `'adhoc'`
  - Proof against the base depends on the change type, as the person decided on 2026-10-03:

    | Change type | Tier | Rule |
    |---|---|---|
    | feature, greenfield | M and L | changed tests must **fail** on the base |
    | bugfix, incident | every tier | changed tests must **fail** on the base |
    | refactor | M and L | changed tests must **pass** on the base |
    | chore, migration | any | no extra proof |
  - `runChecks` calls `shipVerdicts` for every slug when `point !== 'stop'`
- `cmdShip` refuses on any block, listing the findings.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sensors.spec.ts` (add `behaviourIds, missingBehaviours` to the import):

```ts
test('behaviour ids come from the named section only; a test must name each one', () => {
  const spec = '## Context\nB9 is context\n## Behaviours\n- B1 given...\n- B2 given...\n- B10 given...\n## Out of scope\nB3\n'
  assert.deepEqual(behaviourIds(spec, 'Behaviours'), ['B1', 'B2', 'B10'])
  assert.deepEqual(missingBehaviours(['B1', 'B2', 'B10'], "test('B1 adds', ...)\n// covers B10\n"), ['B2'])
  assert.deepEqual(missingBehaviours(['B1'], "test('B11 other')"), ['B1'])
})
```

Append to `scripts/check.spec.ts`:

```ts
function featureRepo(): void {
  sensors({ full: { test: 'node --test test/*.test.js' } })
  write(repo, 'src/add.js', 'export const add = (a, b) => a + b\n')
  write(repo, 'test/add.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n")
  write(repo, 'package.json', '{ "type": "module" }\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'feature')
  sdlc(repo, ['new', 'sub', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/sub/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. B1 subtract\n## Verification\n- node --test test/*.test.js\n')
}

test('ship: new tests that fail on the base prove red; tests that already pass there do not', () => {
  featureRepo()
  write(repo, 'src/sub.js', 'export const sub = (a, b) => a - b\n')
  write(repo, 'test/sub.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { sub } from '../src/sub.js'\ntest('B1 subtracts', () => assert.equal(sub(3, 1), 2))\n")
  const ok = check('--at', 'ship', '--base', 'main', '--slug', 'sub')
  assert.equal(ok.code, 0, ok.stdout)
  fs.rmSync(path.join(repo, 'test/sub.test.js'))
  write(repo, 'test/add2.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('B1 add again', () => assert.equal(add(2, 2), 4))\n")
  const weak = check('--at', 'ship', '--base', 'main', '--slug', 'sub')
  assert.equal(weak.code, 1)
  assert.match(weak.stdout, /\[red-proof\][\s\S]*already pass on the base/)
})

test('ship: a refactor\'s characterization tests must pass on the base, not fail', () => {
  featureRepo()
  sdlc(repo, ['new', 'tidy', '--type', 'refactor', '--tier', 'M'])
  write(repo, '.sdlc/changes/tidy/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. characterize add\n## Verification\n- node --test test/*.test.js\n')
  write(repo, 'test/add-char.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('add keeps working', () => assert.equal(add(2, 3), 5))\n")
  assert.equal(check('--at', 'ship', '--base', 'main', '--slug', 'tidy').code, 0)
  write(repo, 'test/add-char.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('add is now different', () => assert.equal(add(2, 3), 6))\n")
  write(repo, 'src/add.js', 'export const add = (a, b) => a + b + 1\n')
  assert.match(check('--at', 'ship', '--base', 'main', '--slug', 'tidy').stdout, /fail on the base: they do not describe the behaviour/)
})

test('ship: every behaviour needs a test that names it', () => {
  featureRepo()
  write(repo, '.sdlc/changes/sub/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. B1 subtract, B2 negative\n## Verification\n- node --test test/*.test.js\n')
  write(repo, 'src/sub.js', 'export const sub = (a, b) => a - b\n')
  write(repo, 'test/sub.test.js', "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { sub } from '../src/sub.js'\ntest('B1 subtracts', () => assert.equal(sub(3, 1), 2))\n")
  const r = check('--at', 'ship', '--base', 'main', '--slug', 'sub')
  assert.match(r.stdout, /\[traceability\][\s\S]*B2 has no test that names it/)
})

test('an ad-hoc change that started small is re-tiered at ship as it grows', () => {
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/one.js', 'export const one = 1\n')
  hook(repo, 'stop', {})
  const slug = (sdlc(repo, ['status', '--json']).stdout.match(/adhoc-[\d-]+/) ?? [''])[0]
  assert.match(fs.readFileSync(path.join(repo, `.sdlc/changes/${slug}/intent.md`), 'utf8'), /tier: S/)
  for (const f of ['a', 'b', 'c', 'd']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  assert.match(check('--at', 'ship', '--slug', slug).stdout, /\[adhoc\][\s\S]*now tier M/)
})

test('ship refuses an ad-hoc tier M change with no plan', () => {
  hook(repo, 'prompt-submit', {})
  for (const f of ['a', 'b', 'c', 'd']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  hook(repo, 'stop', {})
  const slug = (sdlc(repo, ['status', '--json']).stdout.match(/adhoc-[\d-]+/) ?? [''])[0]
  const r = check('--at', 'ship', '--slug', slug)
  assert.match(r.stdout, /\[adhoc\][\s\S]*run \/sdlc:start adhoc-/)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts scripts/check.spec.ts`
Expected: FAIL, because `behaviourIds` is not exported and there is no `red-proof` section.

- [ ] **Step 3: Implement the pure helpers in `sensors.ts`**

```ts
export function behaviourIds(text: string, heading: string): string[] {
  const section = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? ''
  return [...new Set(section.match(/\bB\d+\b/g) ?? [])]
}

export const missingBehaviours = (ids: string[], corpus: string): string[] => ids.filter(id => !new RegExp(`\\b${id}\\b`).test(corpus))
```

- [ ] **Step 4: Implement the ship verdicts in `check.ts`**

Add the imports `os` from `node:os`, `loadChange` from core, `isTest` from model, and `behaviourIds`, `missingBehaviours` and `tierFromDiff` from sensors. Then add:

```ts
function testCorpus(config: SensorConfig): string {
  const files = [...(git(['ls-files']) ?? '').split('\n'), ...(git(['ls-files', '--others', '--exclude-standard']) ?? '').split('\n')]
  return files.filter(f => f && isTest(f, config)).map(f => read(path.join(ROOT, f))).join('\n')
}

const DEP_DIRS = ['node_modules', '.venv', 'vendor']

// Proof against the base, recomputed (no log entry can fake it): the branch's changed tests run on top of the base code.
// 'red' (feature, bugfix, incident, greenfield): they must FAIL there, so they prove the change.
// 'green' (refactor): they must PASS there, so they pin the old behaviour the refactor preserves.
function proofOnBase(slug: string, config: SensorConfig, diffs: FileDiff[], base: string, mode: 'red' | 'green'): Finding[] {
  const block = (message: string, fix: string): Finding[] => [{ sensor: 'red-proof', severity: 'block', message, fix }]
  const cmd = config.full.test ?? config.fast.test
  const tests = diffs.filter(d => d.status !== 'D' && !d.binary && isTest(d.file, config)).map(d => d.file)
  if (!tests.length) return mode === 'red' ? block('no test file changed, so nothing proves this change', 'write the failing test first') : []
  if (!cmd) return block('no test command declared (full.test or fast.test in .sdlc/sensors.json)', 'declare it so red can be proven')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-red-'))
  try {
    if (git(['worktree', 'add', '--detach', tmp, base]) === null) return block(`could not create a worktree at ${base}`, 'run `git worktree prune` and retry')
    for (const dep of DEP_DIRS) if (exists(path.join(ROOT, dep)) && !exists(path.join(tmp, dep))) fs.symlinkSync(path.join(ROOT, dep), path.join(tmp, dep), 'junction')
    const sanity = runCommand(cmd, { cwd: tmp })
    recordRun(slug, { ...sanity, source: 'ship' })
    if (sanity.exit !== 0) return block("can't establish red: the tests fail on the base even without the new tests", 'make the test command pass from a clean checkout of the base (dependencies, fixtures), or the person waives red-proof')
    for (const t of tests) {
      fs.mkdirSync(path.dirname(path.join(tmp, t)), { recursive: true })
      fs.copyFileSync(path.join(ROOT, t), path.join(tmp, t))
    }
    const run = runCommand(cmd, { cwd: tmp })
    recordRun(slug, mode === 'red' ? { ...run, expectFail: true, source: 'ship' } : { ...run, source: 'ship' })
    if (mode === 'red' && run.exit === 0) return block('the new tests already pass on the base: they prove nothing about this change', 'write a test that fails without the change, then make it pass')
    if (mode === 'green' && run.exit !== 0) return block('the refactor\'s tests fail on the base: they do not describe the behaviour being preserved', 'write characterization tests that pass on the old code first, then refactor under them')
    return []
  } finally {
    git(['worktree', 'remove', '--force', tmp])
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export function shipVerdicts(slug: string, config: SensorConfig, diffs: FileDiff[], base: string | null): Finding[] {
  if (!exists(path.join(CHANGES, slug))) return []
  const change = loadChange(slug)
  const findings: Finding[] = []
  const hasPlan = exists(path.join(change.dir, 'plan.md'))
  // An ad-hoc change is tiered on its first Stop; vibe coding keeps growing it, so re-tier it from the branch diff.
  const RANK = { S: 0, M: 1, L: 2 } as const
  const fromDiff = tierFromDiff(diffs, config)
  const tier = slug.startsWith('adhoc-') && RANK[fromDiff] > RANK[change.tier] ? fromDiff : change.tier
  if (slug.startsWith('adhoc-') && tier !== 'S' && !hasPlan) {
    findings.push({ sensor: 'adhoc', severity: 'block', message: `ad-hoc change is now tier ${tier} with no plan`, fix: `run /sdlc:start ${slug} to adopt it: it writes the plan and applies the tier's gates; the code stays` })
  }
  const spec = read(path.join(change.dir, 'spec.md'))
  const ids = spec ? behaviourIds(spec, 'Behaviours') : behaviourIds(read(path.join(change.dir, 'plan.md')), 'Slices')
  const corpus = ids.length ? testCorpus(config) : ''
  for (const id of missingBehaviours(ids, corpus)) {
    findings.push({ sensor: 'traceability', severity: 'block', message: `${id} has no test that names it`, fix: `add a test whose name or comment says ${id} and proves it` })
  }
  // Per change type: red for new behaviour, green-on-base for refactors, nothing extra for chore and migration
  // (their full suite already runs as the ship gate's commands).
  const RED_TYPES = ['feature', 'bugfix', 'incident', 'greenfield']
  const always = change.type === 'bugfix' || change.type === 'incident'
  if (base && RED_TYPES.includes(change.type) && (tier !== 'S' || always)) findings.push(...proofOnBase(slug, config, diffs, base, 'red'))
  if (base && change.type === 'refactor' && tier !== 'S') findings.push(...proofOnBase(slug, config, diffs, base, 'green'))
  return findings
}
```

In `runChecks`, before the commands line, add:

```ts
  if (i.point !== 'stop') for (const slug of i.slugs) findings.push(...shipVerdicts(slug, config, diffs, i.base))
```

- [ ] **Step 5: Gate `cmdShip`**

In `sdlc.ts` `cmdShip`, add this right after the scope-drift `fail(...)` line:

```ts
  const { config, rules, errors } = loadConfig()
  const gate = runChecks({ point: 'ship', diffs: branchDiff(base ?? 'HEAD'), config, rules, slugs: [slug], commands: 'full', budgetMs: 1_800_000, before: f => showAt(base ?? 'HEAD', f) ?? '', base })
  if (errors.length || gate.blocks.length) {
    const configFindings = errors.map(e => `[config] ${e}`)
    fail(`not shipping: the ship gate found problems\n${[...configFindings, formatFindings(gate.findings)].filter(Boolean).join('\n')}\nFix them (one implementer round), or the person waives with /sdlc-waive <sensor> <file|*> <reason>.`)
  }
```

Import `loadConfig` and `runChecks` from `./check.ts`, `showAt` from `./diffs.ts`, and `formatFindings` from `./model.ts`.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS. The existing tier S ship tests still pass, because tier S chores need no red proof and declare no behaviours.

- [ ] **Step 7: Commit**

```bash
git add scripts/
git commit -m "feat: ship gate with traceability, recomputed proof of red and the ad-hoc tier rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Ship across repos (the coordinated update)

**Files:**
- Modify: `scripts/sdlc.ts` (`cmdShip`)
- Test: `scripts/check.spec.ts`

**Interfaces:**
- Consumes:
  - `loadConfig` (Task 8)
  - `runCommand` and `recordRun` (Task 3)
  - `gitIn` (Task 7)
  - `planFiles` and `isPlanned`
- Produces: `ship.json` gains `repos: { name: string; branch: string; commit: string }[]`.
- Order:
  1. Run every changed consumer's test and require it to pass.
  2. Commit each consumer on `sdlc/<slug>`.
  3. Commit this repo.

  Nothing is committed anywhere if any consumer test fails.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check.spec.ts`:

```ts
test('ship commits a changed consumer on the same branch after its tests pass, and records it', () => {
  const rel = consumerRepo('checkout2', 'src/cart.ts', 'const r = order.discount_rate\n')
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(0)"' }] })
  sdlc(repo, ['new', 'rate', '--type', 'chore', '--tier', 'S'])
  write(repo, 'src/app.js', 'export const a = 10\n')
  write(repo, '.sdlc/changes/rate/plan.md', `## Files\n- src/**\n- ${rel}/src/**\n- .sdlc/sensors.json\n`)
  write(path.resolve(repo, rel), 'src/cart.ts', 'const r = order.promotional_discount\n')
  verified(repo, 'rate')
  const r = sdlc(repo, ['ship', 'rate', '--message', 'chore: rename rate'])
  assert.equal(r.code, 0, r.stderr)
  const shipped = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/changes/rate/ship.json'), 'utf8'))
  assert.equal(shipped.repos[0].branch, 'sdlc/rate')
  assert.match(gitIn(path.resolve(repo, rel), 'log', '-1', '--format=%B', 'sdlc/rate'), /Part of .*@sdlc\/rate/)
})

test('ship refuses and commits nothing when a changed consumer\'s tests fail', () => {
  const rel = consumerRepo('checkout3', 'src/cart.ts', 'x\n')
  sensors({ consumers: [{ name: 'checkout-service', path: rel, test: 'node -e "process.exit(1)"' }] })
  sdlc(repo, ['new', 'rate', '--type', 'chore', '--tier', 'S'])
  write(repo, 'src/app.js', 'export const a = 11\n')
  write(repo, '.sdlc/changes/rate/plan.md', `## Files\n- src/**\n- ${rel}/src/**\n- .sdlc/sensors.json\n`)
  write(path.resolve(repo, rel), 'src/cart.ts', 'y\n')
  verified(repo, 'rate')
  const head = gitIn(repo, 'rev-parse', 'HEAD')
  const r = sdlc(repo, ['ship', 'rate', '--message', 'chore: x'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /checkout-service tests failed/)
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD'), head)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/check.spec.ts`
Expected: FAIL. `shipped.repos` is undefined, and the failing-consumer ship succeeds.

- [ ] **Step 3: Implement in `sdlc.ts`**

Add these helpers above `cmdShip`:

```ts
type ShippedRepo = { name: string; branch: string; commit: string }

// Consumers with uncommitted work in this change: each must be planned and green before anything is committed.
function changedConsumers(slug: string, config: SensorConfig): { name: string; dir: string; test?: string }[] {
  const planned = planFiles(slug)
  return config.consumers
    .map(c => ({ name: c.name, dir: path.resolve(ROOT, c.path), test: c.test, rel: toPosix(path.normalize(c.path)).replace(/\/$/, '') }))
    .filter(c => exists(c.dir) && Boolean(gitIn(c.dir, ['status', '--porcelain'])))
    .map(c => {
      if (!planned.some(p => p.startsWith(c.rel + '/'))) fail(`${c.name} has uncommitted changes but is not in ${slug}/plan.md ## Files`)
      return c
    })
}

function commitConsumer(c: { name: string; dir: string }, slug: string, message: string): ShippedRepo {
  const branch = `sdlc/${slug}`
  const head = gitIn(c.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head === 'main' || head === 'master') {
    if (gitIn(c.dir, ['checkout', '-b', branch]) === null) fail(`could not create ${branch} in ${c.name}`)
  }
  gitIn(c.dir, ['add', '-A'])
  if (gitIn(c.dir, ['commit', '-q', '-m', `${message}\n\nPart of ${path.basename(ROOT)}@${branch}`]) === null) fail(`commit failed in ${c.name}`)
  return { name: c.name, branch: gitIn(c.dir, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? branch, commit: gitIn(c.dir, ['rev-parse', 'HEAD']) ?? '' }
}
```

In `cmdShip`, after the ship gate (Task 12) and before `if (head === 'main' || head === 'master')`, add:

```ts
  const consumers = changedConsumers(slug, config)
  for (const c of consumers) {
    if (!c.test) continue
    const row = runCommand(c.test, { cwd: c.dir })
    recordRun(slug, { ...row, source: 'ship' })
    if (row.exit !== 0) fail(`not shipping: ${c.name} tests failed (exit ${row.exit}):\n${row.tail}`)
  }
  const repos = consumers.map(c => commitConsumer(c, slug, message))
```

Then change the `ship.json` write to include `repos`:

```ts
  fs.writeFileSync(shipFile, JSON.stringify({ at: now(), base, changed: r.changed.length, drift: [], matchRatio: 1, repos }, null, 2) + '\n')
```

Import `gitIn` and `planFiles` from `./core.ts`, and `type SensorConfig` from `./model.ts`.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/
git commit -m "feat: ship commits consumer repos on the same branch after their tests pass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Path-scoped guides and progressive disclosure

**Files:**
- Create: `guides/engineering.md`, `guides/testing.md`, `guides/contracts.md`
- Modify:
  - `scripts/sdlc.ts`: `cmdInit` copies the guides
  - `scripts/hooks.ts`: the `respond` helper, guide injection in `hookPreEdit`, and `hookSessionStart` listing guides and resetting them after compact or clear
  - `hooks/hooks.json`: SessionStart matcher
- Test: `scripts/gate.spec.ts`

**Interfaces:**
- Guide frontmatter:
  - `name`: one word
  - `paths`: comma-separated globs, or the tokens `@source`, `@tests` or `@contracts`, which expand from `sensors.json`
  - `why`: one line
- Produces from `hooks.ts`: `listGuides(config: SensorConfig): { name: string; globs: string[]; sourceOnly: boolean; body: string }[]`
- PreToolUse output can now carry `hookSpecificOutput.additionalContext`, with or without a permission decision.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/gate.spec.ts`:

```ts
const contextOf = (r: { stdout: string }) => (r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput?.additionalContext as string | undefined) : undefined)
const edit = (rel: string, session = 's1') => hook(repo, 'pre-edit', { session_id: session, tool_input: { file_path: path.join(repo, rel) } })

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
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  const ctx = JSON.parse(hook(repo, 'session-start', { session_id: 's1', source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /Guides \(injected when you first touch matching files\): contracts, engineering, testing/)
  assert.doesNotMatch(ctx, /Iron rules/)
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/gate.spec.ts`
Expected: FAIL, because `.sdlc/guides` does not exist.

- [ ] **Step 3: Write the three guides**

Create `guides/engineering.md`:

```markdown
---
name: engineering
paths: @source
why: agent-written code drifts toward god files, hidden coupling and copy-paste; these are the review findings that keep recurring
---
# Engineering rules (read before editing source)

These are rules, not suggestions. The sensors and the reviewer check them.

## Iron rules
1. **One reason to change.** A function does one thing; a module owns one responsibility. If you need "and" to describe it, split it.
2. **Dependencies point inward.** Domain logic never imports frameworks, I/O, HTTP, databases or the clock. Pass them in.
3. **Inject at the boundary.** Build real implementations in one composition root; everything else receives interfaces or functions.
4. **Reuse before you write.** Search for an existing helper, type or module first. Duplicated logic is a defect.
5. **No speculative abstraction.** No interface with one implementation, no factory for one product, no option nobody passes.
6. **Small and named for intent.** Files under the project's line limit, functions that fit on a screen, names that say what, not how.
7. **Composition over inheritance.** Pass behaviour in rather than subclassing to override it.
8. **Errors are handled or surfaced.** No empty catch and no silent fallback that hides a failure; fail loudly with context.
9. **No hidden state.** No module-level mutable singletons; state lives in an owner you can pass and test.
10. **Match the codebase.** Follow the existing structure, naming and style before your own preferences.

## Rationalizations
| Thought | Reality |
|---|---|
| "It's quicker to add it to this file" | That is how god files are made. Put it where its responsibility lives. |
| "I'll make it generic for later" | Later rarely comes; the abstraction stays. YAGNI. |
| "Importing the DB here is simpler" | Then the domain can't be tested without the DB. Inject it. |
| "This is similar but not the same" | Extract the shared part and parameterize the difference. |
| "The catch is just in case" | A swallowed error is a bug report you will never receive. |
```

Create `guides/testing.md`:

```markdown
---
name: testing
paths: @tests
why: agent-written tests often pass without proving anything, and tests are the contract humans review instead of the code
---
# Testing rules (read before editing tests)

## Iron rules
1. **Red first.** Write the test and run it with `sdlc.ts run --expect-fail -- "<cmd>"`. See it fail for the right reason before writing code. Ship recomputes this against the base.
2. **Test behaviour, not implementation.** Assert on outputs, state and observable effects through the public interface, never on private calls.
3. **One reason to fail.** Each test pins one behaviour and its name says which, with the B-number: `B3 rejects an empty key`.
4. **Edges and errors are behaviours.** Empty, boundary, malformed, duplicate and failure paths each get a case when the intent covers them.
5. **Never weaken a test to get green.** No skip, only, xfail, deleted assertions or lowered thresholds. Fix the code. The sensors block these.
6. **Fake only at the boundary.** Use real objects inside your code; fake I/O, network, clock and randomness at the edge.
7. **Deterministic.** No sleeps, wall-clock time, network or test-order dependence; inject the clock and seeds.
8. **Readable as a spec.** Arrange, act, assert; literal inputs and expected values; no logic in tests.

## Rationalizations
| Thought | Reality |
|---|---|
| "I'll write the test after" | Then it is shaped by the code and passes by construction. |
| "This assertion is flaky, drop it" | Find the nondeterminism and inject it. |
| "Mocking the internals is easier" | Then every refactor breaks tests that should still pass. |
| "Coverage is high enough" | Coverage counts lines run, not behaviours proven. |
```

Create `guides/contracts.md`:

```markdown
---
name: contracts
paths: @contracts
why: a contract rename that passes locally can silently break consumers in other repos (the discount_rate pattern)
---
# Contract rules (read before editing API, schema or migration files)

## Iron rules
1. **Never rename or remove in place.** Expand, migrate, contract: add the new name, move every consumer, remove the old name later.
2. **Know your consumers.** List the change in plan `## Contracts` (``- rename `a` → `b` ``). `sdlc.ts check --at plan` finds the consumers, and the person approves the impact.
3. **Additive first.** New optional fields and endpoints are safe; required fields, type changes and removals are breaking.
4. **Version breaking changes.** A breaking API change gets a new version or a deprecation window, never a silent swap.
5. **Say whether a data migration is reversible**, in `## Risks & rollback`, with the backfill plan.
6. **Update every consumer in the same change.** Consumer files go in plan `## Files` as `../<repo>/...`; each consumer's tests run at verify and ship.
7. **Document the contract where it lives.** Schema comments, OpenAPI descriptions and the changelog change with it.

## Rationalizations
| Thought | Reality |
|---|---|
| "Nobody else uses this field" | The sensor greps the consumers. Let it decide. |
| "Our tests pass" | Your tests don't run in the consumer's repo. |
| "It's just a rename" | Renames are the most common silent break. |
```

- [ ] **Step 4: Copy the guides on init**

In `core.ts`, add this function. The harness writing its own protected files (copying guides here, vendoring in Task 17) is not tampering, so it records them the way a tool edit would be recorded. Merging it with `readGate`'s fields is safe, because `readGate` spreads defaults:

```ts
// Files sdlc itself wrote this turn count as sanctioned edits for the Stop gate's harness-tamper rule.
export function sanctionWrites(rels: string[]): void {
  const file = path.join(SDLC, '.gate')
  let gate: { tool?: string[] } = {}
  try {
    gate = JSON.parse(read(file)) as { tool?: string[] }
  } catch {
    gate = {}
  }
  gate.tool = [...new Set([...(gate.tool ?? []), ...rels.map(toPosix)])]
  fs.writeFileSync(file, JSON.stringify(gate))
}
```

Import `sanctionWrites` into `sdlc.ts`. Then, in `cmdInit`, add before `out(...)`:

```ts
  const guides = path.join(SDLC, 'guides')
  if (!exists(guides) && exists(path.join(PLUGIN_ROOT, 'guides'))) {
    fs.cpSync(path.join(PLUGIN_ROOT, 'guides'), guides, { recursive: true })
    sanctionWrites(fs.readdirSync(guides).map(f => `.sdlc/guides/${f}`))
  }
```

- [ ] **Step 5: Inject the guides in `hooks.ts`**

Replace `decide` with `respond`, and keep `decide` as a thin wrapper:

```ts
function respond(o: { decision?: 'allow' | 'ask' | 'deny'; reason?: string; context?: string }): void {
  if (!o.decision && !o.context) return
  const h: Record<string, unknown> = { hookEventName: 'PreToolUse' }
  if (o.decision) {
    h.permissionDecision = o.decision
    h.permissionDecisionReason = o.reason
  }
  if (o.context) h.additionalContext = o.context
  out(JSON.stringify({ hookSpecificOutput: h }))
}
const decide = (decision: 'allow' | 'ask' | 'deny', reason: string, context?: string): void => respond({ decision, reason, context })
```

Add the guide loading:

```ts
type Guide = { name: string; globs: string[]; sourceOnly: boolean; body: string }

export function listGuides(config: SensorConfig): Guide[] {
  const dir = path.join(SDLC, 'guides')
  if (!exists(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => {
    const { data, body } = frontmatter(read(path.join(dir, f)))
    const tokens = (data.paths ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const globs = tokens.flatMap(t => (t === '@source' ? ['**'] : t === '@tests' ? config.tests : t === '@contracts' ? config.contracts : [t]))
    return { name: data.name || f.replace(/\.md$/, ''), globs, sourceOnly: tokens.includes('@source'), body: body.trim() }
  })
}

// Progressive disclosure: a guide enters the context the first time this session touches a matching file.
function guidesFor(rel: string, session: string): string | undefined {
  const { config } = loadConfig()
  const gate = readGate()
  const seen = gate.guides[session] ?? []
  const fresh = listGuides(config).filter(g => !seen.includes(g.name) && matchesAny(rel, g.globs) && (!g.sourceOnly || (isSource(rel, config) && !isTest(rel, config))))
  if (!fresh.length) return undefined
  gate.guides[session] = [...seen, ...fresh.map(g => g.name)]
  writeGate(gate)
  return fresh.map(g => g.body).join('\n\n')
}
```

Add `isTest` to the `./model.ts` import in `hooks.ts`. Then restructure `hookPreEdit` so every non-deny path carries the guides:
1. The evidence `deny` and the sibling `deny` stay as they are, with no context.
2. Compute `const context = exists(SDLC) && rel inside the repo ? guidesFor(rel, input.session_id ?? 'default') : undefined` right after the sibling check.
3. Pass `context` into the protected `ask` (`decide('ask', reason, context)`) and into the scope `ask`.
4. End the function with `respond({ context })` on every path that previously returned with no output.

Change `hookSessionStart` to take `input: HookInput`. Reset the guides for the session after compact or clear, and list the guide names:

```ts
  if (input.source === 'compact' || input.source === 'clear') {
    const gate = readGate()
    delete gate.guides[input.session_id ?? 'default']
    writeGate(gate)
  }
  const guides = listGuides(loadConfig().config).map(g => g.name)
```

Add this element to the `context` array: `guides.length ? \`Guides (injected when you first touch matching files): ${guides.join(', ')}\` : ''`. Then register `'session-start': hookSessionStart`.

In `hooks/hooks.json`, give the SessionStart entry `"matcher": "startup|resume|clear|compact"`.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS. All three guides are within 60 lines, which the size test checks.

- [ ] **Step 7: Commit**

```bash
git add guides/ scripts/ hooks/hooks.json
git commit -m "feat: path-scoped engineering, testing and contract guides injected on first touch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Skills and agents: design lens, contracts, red runs, refactor, intake, decisions, ship routing

**Files:**
- Modify:
  - `scripts/core.ts`: `intentTemplate` gains `## Decisions`
  - `agents/architect.md`, `agents/implementer.md`, `agents/reviewer.md`
  - `skills/start/SKILL.md`, `skills/plan/SKILL.md`, `skills/build/SKILL.md`, `skills/review/SKILL.md`, `skills/ship/SKILL.md`, `skills/onboard/SKILL.md`
- Test: `scripts/sdlc.spec.ts`, plus the size test

**Interfaces:**
- Consumes these CLI commands from earlier tasks: `run`, `verify-report`, `check --at plan|ship`, `skill`, `waive`, and the `impact` gate.
- Produces the text contracts later tasks rely on:
  - Reviewer findings carry `category: <kebab-word>`, which metrics counts in Task 16.
  - The plan has `## Design` and `## Contracts`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/sdlc.spec.ts`:

```ts
test('a new intent has a Decisions section for explicit defaults', () => {
  run(['new', 'add-login', '--type', 'feature', '--tier', 'M'])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/add-login/intent.md'), 'utf8'), /## Decisions\n<!-- skipped optional steps and defaults taken, one line each -->/)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sdlc.spec.ts`
Expected: FAIL on the `## Decisions` match.

- [ ] **Step 3: Extend the intent template**

In `core.ts` `intentTemplate`, append after the `## Risks` block:

```
## Decisions
<!-- skipped optional steps and defaults taken, one line each -->
```

- [ ] **Step 4: Replace `agents/architect.md` (body only; keep the frontmatter)**

```markdown
You design a change. The brief names the change folder (`.sdlc/changes/<slug>/`), which document to write (`spec.md` or `plan.md`), and any scout findings. Read `intent.md`, `spec.md` when it exists, the guides in `.sdlc/guides/`, and only the code lines the findings point to.

Write only the requested file inside the change folder. Never edit source code.

**spec.md**, at most 150 lines: `## Context` (≤ 5 lines); `## Behaviours`, numbered `B1`, `B2`… as Given / When / Then a test can prove; `## Interfaces` (signatures, endpoints, schemas, events, no implementation); `## Non-functional` (measurable only); `## Out of scope`; `## Open questions`. Stay within the intent; hardening its risks do not call for goes to Out of scope.

**plan.md**, at most 120 lines, **no implementation code** (sketches ≤ 10 lines, signatures only):
- `## Approach`: ≤ 10 lines, including the rejected alternative and why.
- `## Design`: ≤ 5 lines. Modules and the direction of dependencies (domain ← application ← adapters). Every new unit has one responsibility; say where each is injected. No abstraction with a single implementation.
- `## Contracts`: one line per contract identifier added, renamed or removed: ``- add `x` ``, ``- rename `a` → `b` ``, ``- remove `a` ``. Write `none` if none. Renames follow expand–migrate–contract (guides/contracts.md).
- `## Files`: one `- path/or/glob` per line, tests included. This is the ownership contract. Consumer repo files are `../<repo>/...` globs.
- `## Slices`: thin vertical slices, each with its goal, files, interface sketch, acceptance tests naming the B-numbers they prove, and its fast test command.
- `## Verification`: exact commands, including lint and type-check from `.sdlc/sensors.json`, and each affected consumer's test command.
- `## Risks & rollback`.

Order slices by change type: greenfield, a walking skeleton first; refactor, characterization tests first; migration, inventory, then a pilot unit, then fan-out. Prefer the fewest slices that keep each one testable.

Reply in 15 lines or fewer: the file written, key decisions, contract identifiers, and open questions that need the person's answer.
```

- [ ] **Step 5: Replace `agents/implementer.md` (body only)**

```markdown
You implement one slice of an approved plan. The brief gives you the slice, its acceptance tests, the files you own, the guides that apply and the commands to run. Read those guides first.

Rules:
1. Touch only the files the brief lists. If another file must change, stop and report why.
2. **Red:** write or extend the slice's acceptance test, then run it through the recorder and see it fail for the right reason: `node --disable-warning=ExperimentalWarning <plugin>/scripts/sdlc.ts run --expect-fail -- "<test command>"`.
3. **Green:** implement the smallest code that makes it pass. Run the targeted tests through `sdlc.ts run -- "<command>"`, quietly (`-q`, `--reporter=dot`), piping long output through `tail -40`.
4. **Refactor:** with tests green, tidy only inside your files: remove duplication, split anything doing two things, name for intent. Re-run the tests.
5. Edit with Edit and Write, never `sed -i`, heredocs or scripts. The harness checks every edit, and the end-of-turn gate catches the rest.
6. Never weaken, skip or delete a test, lower a threshold or add a suppression to get green. The sensors block it; fix the code.
7. If the end-of-turn gate blocks you, fix exactly what it lists. If you disagree with a finding, report it instead of working around it.
8. Never `sleep` to wait. If something hangs, stop and report it.

Report in at most 30 lines:
- **Status**: done | blocked (and why)
- **Files changed**: one line each
- **Tests**: the red run's exit code, then the green command and the last lines of its output
- **Notes**: anything the next slice or the reviewer must know
```

- [ ] **Step 6: Replace `agents/reviewer.md` (body only)**

```markdown
You review one change and never edit. Bash is for read-only commands: `git diff`, `git log`, `git show`, and tests through `sdlc.ts run`.

1. Read `intent.md`, `spec.md` and `plan.md` if they exist (especially `## Design` and `## Contracts`), then the diff: `git diff <base>...HEAD` plus the working tree, or the range in the brief.
2. **Skip what machines already check.** The sensors and CI cover lint, types, formatting, test tampering, suppressions, secrets, size, layering and consumer references. Do not report anything a linter, type checker or those sensors would catch, anything pre-existing, or anything on lines the diff did not touch.
3. Look for these, in order:
   - **Correctness:** wrong behaviour, missed B-numbers, broken edge cases the intent covers
   - **Security:** injection, authz, secrets handling, unsafe input
   - **Contracts:** API or schema changes the plan's `## Contracts` did not announce
   - **Data loss or corruption**
   - **Design lens:** a unit with more than one reason to change; dependencies pointing outward against `## Design`; an abstraction with one implementation; layers leaking; duplicated logic that should be reused
   - **Tests:** a behaviour no test proves, or tests that run code without pinning behaviour
4. Keep a finding only if you are ≥ 80% confident it is real and in scope. **Tier L:** before dropping a candidate, cite the `file:line` that proves it is not real (recall, then refute). Style preferences and anything the non-goals exclude go to **Deferred**.
5. End with: "If I could change only one thing: …".

Reply in 30 lines or fewer:
```
verdict: pass | changes-needed
## Findings
- [severity: critical|high|medium] [category: correctness|security|contract|data|coupling|responsibility|abstraction|duplication|tests] path:line: problem → fix (confidence NN)
## Deferred
- ...
## One thing
- ...
```
```

- [ ] **Step 7: Update the skills**

For each skill below, the body is given in full, and the frontmatter stays as it is unless a change is listed. Every body must stay within 60 lines.

**`skills/start/SKILL.md`.** Under `## New change`, step 3 **Classify** gains this first bullet:

```
   - If the request is an issue reference (`#123` or a GitHub issue URL), run `gh issue view <ref> --json title,body,labels` and use it as the request; record the reference in intent.md.
```

After step 4 **Record**, add:

```
   - **Explicit defaults.** For each optional input you did not get (non-goals, risks, rollout), ask once with AskUserQuestion if it changes the tier or the gates; otherwise record the default you took in `## Decisions`. Never leave a guess unrecorded.
```

In `## Resume`, add:

```
If the slug starts with `adhoc-`, this is adoption of work done without /sdlc:start: fill intent.md from the diff (`node ... sdlc.ts diff --base main`), confirm type and tier with the person, then continue with the printed next command (the plan and gates apply).
```

Add `Bash(gh issue view*)` to `allowed-tools`.

**`skills/plan/SKILL.md`.** After step 3 **Check**, insert:

```
4. **Impact.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts check --at plan --slug $0`. If it reports consumer references, the change is now tier L: tell the person which repos are affected, make sure `## Files` lists the consumer files and `## Verification` lists each consumer's test, and say that `/sdlc-approve $0 impact` is required before build.
```

Renumber the old step 4 to step 5. In the closing "Then", change the M/L line to: `**Tier M/L:** ask the person to review plan.md (and impact.json when present) and run /sdlc-approve $0 plan (and impact).`

**`skills/build/SKILL.md`.** In "Large builds" step 2, after the bullet "relevant conventions from CLAUDE.md", add:

```
   - the guides that apply to its files (names from `.sdlc/guides/`), and the rule that the red run goes through `sdlc.ts run --expect-fail` and the refactor step happens under green tests
```

After step 3, add:

```
   - **Gate blocked:** if a subagent's end-of-turn gate listed findings it could not fix, treat it as blocked.
```

**`skills/review/SKILL.md`.** In step 4 **Record**, add: `Keep each finding's category tag in review.md, because metrics counts recurring categories to suggest new rules.`

**`skills/ship/SKILL.md`.** Replace step 3 with:

```
3. **Ship it.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ship $0 --message "<type(scope): summary>\n\n<the intent's outcome>"`. The script deterministically:
   - checks readiness and the scope gate
   - runs the ship gate: every sensor over the branch diff, the full commands, traceability (every B-number has a named test) and proof of red (the new tests fail on the base)
   - runs each changed consumer's tests, then commits each consumer on `sdlc/$0`
   - creates `sdlc/$0` here if you are on main, stages the planned code, artifacts, approvals, waivers and STATE.md, and commits

   **If the gate refuses** with traceability or red-proof findings, launch **one** `sdlc:implementer` with only those findings, then run ship again. Anything still failing, or any other finding, goes to the person: they fix it, or waive it with `/sdlc-waive <sensor> <file|*> <reason>`. Never stage or commit by hand.
```

**`skills/onboard/SKILL.md`.** Replace `## Both` with:

```
## Both
1. **Sensors.** From scout (b), write `.sdlc/sensors.json`: `fast` (lint, typecheck, targeted test; under 60 s together), `full` (full test, coverage, arch if any), `tests` and `contracts` globs if the defaults miss the repo's layout, and `limits`. Ask with AskUserQuestion whether other repos consume this one's API or schema. Each one becomes a `consumers` entry with `name`, `path` (sibling checkout), `repo` (owner/name) and `test`.
2. **Ratchet.** Run each `fast` command once through `sdlc.ts run`. Any that already fail go into `knownRed`, so the gate never blocks on debt it did not create. Tell the person which.
3. **CI.** Offer to run `sdlc.ts vendor` and copy `${CLAUDE_PLUGIN_ROOT}/templates/sdlc-check.yml` to `.github/workflows/`. Say they must make `sdlc-check` a required check, add CODEOWNERS entries for `.sdlc/**` and the workflow, and add an `SDLC_CONSUMERS_TOKEN` secret if any consumer repo is private. Write the files only on a yes.
4. **Settings.** Show the project settings this harness expects and offer to merge `${CLAUDE_PLUGIN_ROOT}/templates/settings.json` into `.claude/settings.json`. Write them only on a yes.
```

Then remove the old settings paragraph and the bullets that followed it, since point 4 replaces them.

- [ ] **Step 8: Run all the tests, including the size limits**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS. If a skill exceeds 60 lines, shorten its prose; do not drop steps.

- [ ] **Step 9: Commit**

```bash
git add scripts/core.ts scripts/sdlc.spec.ts agents/ skills/
git commit -m "feat: design lens, contracts and red runs in agents; intake, decisions, impact and ship routing in skills

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Rules: the `/sdlc:rule` skill, fire counts, prune candidates and category suggestions

**Files:**
- Create: `skills/rule/SKILL.md`
- Modify:
  - `scripts/check.ts`: log rule fires
  - `scripts/metrics.ts`: the `harness` section
- Test: `scripts/sdlc.spec.ts`

**Interfaces:**
- Produces:
  - `usage.jsonl` rows of the form `{ at, kind: 'event', event: 'rule-fired', rule: <id> }`
  - `metrics --json`, which gains `metrics.harness: { rule_fires: Record<string, number>; prune_candidates: string[]; rule_suggestions: string[]; skill_load_failures: number; unresolved: number }`

- [ ] **Step 1: Write the failing test**

Append to `scripts/sdlc.spec.ts`:

```ts
test('metrics report rule fires, prune candidates and recurring review categories', () => {
  run(['new', 'a1', '--type', 'feature', '--tier', 'S'])
  write('.sdlc/rules.json', JSON.stringify([
    { id: 'no-print', pattern: 'print\\(', message: 'use the logger', why: 'stdout is the protocol', action: 'block' },
    { id: 'old-rule', pattern: 'never-matches-xyz', message: 'm', why: 'w', action: 'warn' },
  ]))
  write('.sdlc/changes/a1/review.md', '- [severity: medium] [category: coupling] a\n- [severity: medium] [category: coupling] b\n- [severity: high] [category: coupling] c\n')
  write('src/a.py', 'print("x")\n')
  run(['check', '--at', 'ship'])
  const h = JSON.parse(run(['metrics', '--json']).stdout).metrics.harness
  assert.equal(h.rule_fires['no-print'], 1)
  assert.match(h.rule_suggestions.join('\n'), /coupling \(3 findings\)/)
  assert.ok(Array.isArray(h.prune_candidates))
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sdlc.spec.ts`
Expected: FAIL, because `harness` is undefined.

- [ ] **Step 3: Log the rule fires in `check.ts`**

```ts
function logRuleFires(findings: Finding[]): void {
  if (!exists(SDLC)) return
  const rows = findings.filter(f => f.sensor === 'rules').map(f => JSON.stringify({ at: new Date().toISOString(), kind: 'event', event: 'rule-fired', rule: f.labels?.[0] }))
  if (rows.length) fs.appendFileSync(path.join(SDLC, 'usage.jsonl'), rows.join('\n') + '\n')
}
```

In `runChecks`, call `logRuleFires(result.findings)` on the waiver-filtered result before returning it:

```ts
  const result = applyWaivers(findings, i.slugs)
  logRuleFires(result.findings)
  return result
```

- [ ] **Step 4: Add the harness metrics in `metrics.ts`**

Before the final output in `cmdMetrics`, add:

```ts
  const events = readJsonl<UsageRow>(USAGE).filter(r => r.kind === 'event')
  const fired = events.filter(e => e.event === 'rule-fired')
  const ruleIds = parseRules(read(path.join(SDLC, 'rules.json'))).rules.map(r => r.id)
  const ninetyDays = Date.now() - 90 * 86_400_000
  const rulesAge = firstCommitTime('.sdlc/rules.json')
  const recent = new Set(fired.filter(e => Date.parse(e.at) >= ninetyDays).map(e => e.rule))
  const categories = changes.flatMap(c => [...read(path.join(c.dir, 'review.md')).matchAll(/category:\s*([\w-]+)/gi)].map(m => (m[1] ?? '').toLowerCase()))
  const byCategory = categories.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {})
  const harness = {
    rule_fires: sumBy(fired.filter(e => Date.parse(e.at) >= since), r => r.rule ?? 'unknown', () => 1),
    prune_candidates: rulesAge && Date.parse(rulesAge) < ninetyDays ? ruleIds.filter(id => !recent.has(id)) : [],
    rule_suggestions: Object.entries(byCategory).filter(([, n]) => n >= 3).map(([c, n]) => `${c} (${n} findings): consider /sdlc:rule`),
    skill_load_failures: events.filter(e => e.event === 'skill-load-failed' && Date.parse(e.at) >= since).length,
    unresolved: (() => {
      try {
        return (JSON.parse(read(path.join(SDLC, 'unresolved.json'))) as { findings: unknown[] }).findings.length
      } catch {
        return 0
      }
    })(),
  }
```

Then change the JSON output to `metrics: { ...m, cost, harness }`, and append `'harness', JSON.stringify(harness, null, 2)` to the text output. Import `parseRules` from `./model.ts`.

- [ ] **Step 5: Create `skills/rule/SKILL.md`**

```markdown
---
name: rule
description: Turn a convention the agent keeps breaking into a mechanical rule in .sdlc/rules.json (promote prose to a sensor). Use when metrics suggest a recurring review category, or the person says "this keeps happening".
argument-hint: '"<what keeps recurring>"'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Grep, Glob, AskUserQuestion
---
# Promote a rule: $ARGUMENTS

A rule is a regular expression over **added lines** that blocks or warns, with a `why`. Earn every rule: it must trace to a real, recurring finding.

1. **Evidence.** Find at least two real occurrences: review.md findings with this category, or `git log -p` hits. If there are fewer than two, stop and say the rule is not earned yet.
2. **Draft** one entry:
   `{ "id": "<kebab>", "pattern": "<regex>", "paths": ["<globs>"], "message": "<what to do instead>", "why": "<the incident or finding it traces to>", "action": "block" | "warn" }`
   - The pattern must match the bad lines and not the good ones. Show three lines it matches and three similar lines it must not.
   - Use `warn` unless a mistake would be costly. Prefer narrow `paths`.
3. **Check** with `sdlc.ts check --at ship --json` on a branch that contains a known occurrence: the rule must fire exactly there.
4. **Hand over.** `.sdlc/rules.json` is a protected harness file, so show the person the entry and ask them to add it (the edit prompts them). It goes through PR review like any harness change.

Rules that never fire for 90 days show up in `/sdlc:metrics` as prune candidates. Remove them in the same way.

End with: `Next: add the rule (you), then /sdlc:start for the next change`.
```

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS. The skill is 60 lines or fewer.

- [ ] **Step 7: Commit**

```bash
git add scripts/ skills/rule/
git commit -m "feat: /sdlc:rule, rule fire counts, prune candidates and recurring-category suggestions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: CI parity: vendoring, base-ref config and the GitHub check

**Files:**
- Create: `templates/sdlc-check.yml`, `.sdlc/sensors.json` (this plugin's own dogfood config)
- Modify:
  - `scripts/sdlc.ts`: `cmdVendor`
  - `.github/workflows/ci.yml`: the dogfood job
- Test: `scripts/check.spec.ts`

**Interfaces:**
- Produces:
  - CLI `sdlc.ts vendor`. It copies `core, model, sensors, diffs, runs, check, hooks, metrics, sdlc` (`.ts`) into `<project>/.sdlc/bin/` and writes `.sdlc/bin/VERSION` from `plugin.json`.
  - `check --config-from <ref>`, already implemented in Task 8, is now exercised end to end.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check.spec.ts`:

```ts
test('vendor copies a standalone checker that runs without the plugin', () => {
  const v = sdlc(repo, ['vendor'])
  assert.equal(v.code, 0, v.stderr)
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/bin/VERSION')))
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/bin/testkit.ts')))
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', '.sdlc/bin/sdlc.ts', 'check', '--at', 'ship'], { cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('the harness vendoring its own files does not trip the Stop gate', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  sdlc(repo, ['vendor'])
  assert.equal(hook(repo, 'stop', {}).stdout, '')
})

test('CI judges a PR by the base branch config, so loosening limits does not help', () => {
  sensors({ limits: { diffLines: 500 } })
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  gitIn(repo, 'checkout', '-qb', 'pr')
  sensors({ limits: { diffLines: 5000 } })
  write(repo, 'src/huge.js', Array.from({ length: 700 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'big')
  const r = check('--at', 'ci', '--base', 'main', '--config-from', 'main')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /\[size\][\s\S]*limit 500/)
  assert.match(r.stdout, /\[harness-tamper\][\s\S]*diffLines raised 500 → 5000/)
})
```

Add `spawnSync` to the `node:child_process` import at the top of `check.spec.ts`. If there is none yet, add `import { spawnSync } from 'node:child_process'`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/check.spec.ts`
Expected: FAIL, because `vendor` is an unknown command.

- [ ] **Step 3: Implement `cmdVendor` in `sdlc.ts` (its writes are sanctioned)**

`sanctionWrites` already exists in `core.ts` (added in Task 14). Import it into `sdlc.ts`. Then:

```ts
const VENDORED = ['core', 'model', 'sensors', 'diffs', 'runs', 'check', 'hooks', 'metrics', 'sdlc']

// CI runs the checker from .sdlc/bin, so it never depends on the plugin being installed.
function cmdVendor(): void {
  const bin = path.join(SDLC, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of VENDORED) fs.copyFileSync(path.join(PLUGIN_ROOT, 'scripts', `${name}.ts`), path.join(bin, `${name}.ts`))
  const version = (JSON.parse(read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) as { version?: string }).version ?? 'unknown'
  fs.writeFileSync(path.join(bin, 'VERSION'), `${version}\n`)
  sanctionWrites([...VENDORED.map(n => `.sdlc/bin/${n}.ts`), '.sdlc/bin/VERSION'])
  out(`vendored sdlc ${version} into .sdlc/bin (${VENDORED.length} files). Commit it; CI runs the base branch's copy.`)
}
```

Register `vendor: () => cmdVendor()`.

- [ ] **Step 4: Create `templates/sdlc-check.yml`**

```yaml
# The sdlc required check. Copy to .github/workflows/ and make "sdlc-check" a required status check.
# The checker and its config come from the BASE branch, so a PR cannot loosen the rules it is judged by.
name: sdlc-check
on: pull_request
permissions:
  contents: read
jobs:
  sdlc-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '22.18'
      - name: Load the checker and config from the base branch
        run: |
          base="origin/${{ github.base_ref }}"
          mkdir -p "$RUNNER_TEMP/sdlc"
          if git cat-file -e "$base:.sdlc/bin/sdlc.ts" 2>/dev/null; then
            for f in $(git ls-tree --name-only "$base" .sdlc/bin/); do git show "$base:$f" > "$RUNNER_TEMP/sdlc/$(basename "$f")"; done
            echo "SDLC_CONFIG_FROM=$base" >> "$GITHUB_ENV"
          else
            echo "::notice::bootstrap: no sdlc checker on $base yet; using this PR's copy. This PR needs human review."
            cp .sdlc/bin/* "$RUNNER_TEMP/sdlc/"
          fi
          git show "$base:.sdlc/sensors.json" > "$RUNNER_TEMP/sensors.json" 2>/dev/null || cp .sdlc/sensors.json "$RUNNER_TEMP/sensors.json" 2>/dev/null || echo '{}' > "$RUNNER_TEMP/sensors.json"
      - name: Check out consumer repos
        env:
          TOKEN: ${{ secrets.SDLC_CONSUMERS_TOKEN }}
        run: |
          node -e 'for (const c of (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).consumers || [])) if (c.repo) console.log(c.repo + " " + c.path)' "$RUNNER_TEMP/sensors.json" |
          while read -r repo dir; do
            if [ -z "$TOKEN" ]; then echo "::error::consumer $repo needs the SDLC_CONSUMERS_TOKEN secret (contents:read)"; exit 1; fi
            git clone --depth 1 "https://x-access-token:${TOKEN}@github.com/${repo}.git" "$dir"
          done
      - name: sdlc check
        env:
          CLAUDE_PROJECT_DIR: ${{ github.workspace }}
        run: node --disable-warning=ExperimentalWarning "$RUNNER_TEMP/sdlc/sdlc.ts" check --at ci --base "origin/${{ github.base_ref }}" ${SDLC_CONFIG_FROM:+--config-from "$SDLC_CONFIG_FROM"}
```

- [ ] **Step 5: Dogfood on this plugin**

Create `.sdlc/sensors.json` in this repo:

```json
{
  "fast": { "typecheck": "npm run typecheck" },
  "full": { "typecheck": "npm run typecheck", "test": "node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts" },
  "tests": ["scripts/*.spec.ts", "tests/**"],
  "limits": { "fileLines": 500, "diffLines": 1500 }
}
```

Append this job to `.github/workflows/ci.yml`:

```yaml
  dogfood:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '22.18'
      - run: npm ci || npm install
      - run: node --disable-warning=ExperimentalWarning scripts/sdlc.ts check --at ci --base "origin/${{ github.base_ref || 'main' }}"
```

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/ templates/sdlc-check.yml .sdlc/sensors.json .github/workflows/ci.yml
git commit -m "feat: vendored checker, base-ref CI check template, and dogfooding on this plugin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Mod: `/sdlc-waive`, `/sdlc-sensors`, the quality band, the impact hold and per-edit notices

**Files:**
- Create: `hooks/shared.ts`, `hooks/band.tsx`, `hooks/gates.tsx`
- Modify:
  - `hooks/register.tsx`: wiring only, with the band code moved out
  - `types/index.d.ts`
  - `scripts/sdlc.ts`: `cmdWaive`, `cmdSensors`, the `status --json` sensors field, and ship staging of `waivers.jsonl`
  - `scripts/check.ts`: `cmdImpactStatus`
- Test: `tests/register.test.ts`, `scripts/sdlc.spec.ts`

**Interfaces:**
- CLI:
  - `waive <sensor> <file|*> <reason…> [--slug s]`, which needs `SDLC_HUMAN=1`
  - `sensors`, a text report
  - `impact-status <file> --json`, which returns `{ hold: boolean; slug: string | null; consumers: string[]; hits: number }`
  - `status --json`, which gains `sensors: { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number } | null`
- `hooks/shared.ts` exports:
  - `sdlc($: EngineInterface, ...args: string[]): string[]`
  - `isInitialised($): Promise<boolean>`
  - `statusJson($): Promise<Status | null>`
- `types/index.d.ts`: `Band` gains `sensors: SensorBand | null`.

- [ ] **Step 1: Write the failing script tests**

Append to `scripts/sdlc.spec.ts`:

```ts
test('waive is human-only, records the waiver for the active change, and status reports sensors', () => {
  run(['new', 'x', '--type', 'chore', '--tier', 'S'])
  assert.equal(run(['waive', 'size', '*', 'generated', 'file']).code, 3)
  assert.equal(run(['waive', 'size', '*', 'generated', 'file'], { env: { SDLC_HUMAN: '1' } }).code, 0)
  const w = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/waivers.jsonl'), 'utf8').trim())
  assert.deepEqual([w.slug, w.sensor, w.file, w.reason], ['x', 'size', '*', 'generated file'])
  const s = JSON.parse(run(['status', '--json']).stdout).sensors
  assert.equal(s.waivers, 1)
  assert.match(run(['sensors']).stdout, /waivers \(x\): size \* generated file/)
})

test('impact-status holds edits to consumer files while the impact is unapproved', () => {
  run(['new', 'rate', '--type', 'feature', '--tier', 'L'])
  write('.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: '../checkout' }] }))
  write('.sdlc/changes/rate/impact.json', JSON.stringify({ at: 'x', ids: ['discount_rate'], hits: [{ consumer: 'checkout', file: 'a', line: 1, id: 'discount_rate' }], missing: [] }))
  write('.sdlc/changes/rate/plan.md', '## Files\n- ../checkout/**\n')
  const consumerFile = path.join(path.dirname(repo), 'checkout', 'a.ts')
  assert.deepEqual(JSON.parse(run(['impact-status', consumerFile, '--json']).stdout), { hold: true, slug: 'rate', consumers: ['checkout'], hits: 1 })
  run(['approve', 'rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.equal(JSON.parse(run(['impact-status', consumerFile, '--json']).stdout).hold, false)
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sdlc.spec.ts`
Expected: FAIL, because `waive` is an unknown command.

- [ ] **Step 3: Implement the script side**

In `sdlc.ts`:

```ts
function cmdWaive(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail('waivers are human-only: the person runs /sdlc-waive <sensor> <file|*> <reason>', 3)
  const [sensor, file, ...reason] = args.pos
  const slug = optString(args, 'slug') ?? activeSlug()
  if (!sensor || !file || !reason.length || !slug) fail('usage: waive <sensor> <file|*> <reason...>  (needs an active change)')
  const by = git(['config', 'user.name']) || process.env.USER || process.env.USERNAME || 'unknown'
  const row: Waiver = { slug, sensor, file, reason: reason.join(' '), by, at: now() }
  fs.appendFileSync(WAIVERS, JSON.stringify(row) + '\n')
  out(`waived ${sensor} for ${file} in ${slug}: ${row.reason} (by ${by})`)
}

function sensorStatus(): { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number } | null {
  if (!exists(SDLC)) return null
  const last = readGate().last
  const slug = activeSlug()
  let unresolved = 0
  try {
    unresolved = (JSON.parse(read(path.join(SDLC, 'unresolved.json'))) as { findings: unknown[] }).findings.length
  } catch {
    unresolved = 0
  }
  return {
    blocks: last?.blocks ?? 0, warns: last?.warns ?? 0, bySensor: last?.bySensor ?? {}, unresolved,
    knownRed: loadConfig().config.knownRed.length,
    waivers: readJsonl<Waiver>(WAIVERS).filter(w => w.slug === slug).length,
  }
}

function cmdSensors(): void {
  const s = sensorStatus()
  if (!s) return out('sdlc not initialised here')
  const slug = activeSlug()
  const unresolved = exists(path.join(SDLC, 'unresolved.json')) ? (JSON.parse(read(path.join(SDLC, 'unresolved.json'))) as { findings: Finding[] }).findings : []
  const waivers = readJsonl<Waiver>(WAIVERS).filter(w => w.slug === slug)
  out([
    `last gate: ${s.blocks} block(s), ${s.warns} warning(s)${Object.keys(s.bySensor).length ? ' · ' + Object.entries(s.bySensor).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`,
    unresolved.length ? `unresolved:\n${formatFindings(unresolved)}` : 'unresolved: none',
    `known red: ${loadConfig().config.knownRed.join(', ') || 'none'}`,
    `waivers (${slug ?? 'no change'}): ${waivers.map(w => `${w.sensor} ${w.file} ${w.reason}`).join('; ') || 'none'}`,
  ].join('\n'))
}
```

In `cmdStatus`'s JSON branch, add `sensors: sensorStatus()` to the returned object. In `cmdShip`'s `extras`, add `'.sdlc/waivers.jsonl'`. Register `waive: cmdWaive`, `sensors: () => cmdSensors()` and `'impact-status': cmdImpactStatus`. Import `WAIVERS` and `type Waiver` from core, `readGate` from `./hooks.ts`, `cmdImpactStatus` from `./check.ts`, and `type Finding` from `./model.ts`.

In `check.ts`:

```ts
export function cmdImpactStatus(args: Args): void {
  const file = args.pos[0] ?? ''
  const slug = activeSlug()
  const { config } = loadConfig()
  const rel = toPosix(path.relative(ROOT, path.resolve(ROOT, file)))
  const impact = slug ? readImpact(slug) : null
  const touchesContract = config.consumers.some(c => rel.startsWith(toPosix(path.normalize(c.path)).replace(/\/$/, '') + '/')) || matchesAny(rel, config.contracts)
  const hold = Boolean(slug && impact?.hits.length && touchesContract && approvalOf(slug, 'impact') !== 'approved')
  out(JSON.stringify({ hold, slug, consumers: [...new Set((impact?.hits ?? []).map(h => h.consumer))], hits: impact?.hits.length ?? 0 }))
}
```

Add `toPosix` to the core import.

- [ ] **Step 4: Write the failing mod tests**

Replace `tests/register.test.ts` `worldOf`'s `process.run` handler so it answers by subcommand:

```ts
  on('process.run', ($, e) => {
    world.runs.push({ argv: e.argv, env: e.init?.env })
    const sub = e.argv[3]
    const stdout =
      sub === 'status' ? JSON.stringify({ initialised: true, active: 'add-login', changes: [{ slug: 'add-login', next: { stage: 'build' } }], sensors: world.sensors })
      : sub === 'impact-status' ? JSON.stringify(world.impact)
      : sub === 'check-file' ? JSON.stringify(world.fileFindings)
      : sub === 'sensors' ? 'last gate: 0 block(s)'
      : 'approved add-login plan'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
```

Add these fields to `world`:
- `sensors: null as unknown`
- `impact: { hold: false, slug: 'add-login', consumers: [] as string[], hits: 0 }`
- `fileFindings: [] as unknown[]`
- `notices: [] as string[]`

Also add `on('ui.notice', ($, e) => { world.notices.push(String((e as { text?: string }).text)); return { value: undefined } })`.

Then:
1. Update the first test to expect `['sdlc-approve', 'sdlc-sensors', 'sdlc-status', 'sdlc-waive']`.
2. Append these tests:

```ts
  test('waive runs the script as the human only when the person typed it', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    expect((await $.command.run(command('sdlc-waive', 'size * generated', 'sdk'))).text).toContain('only when the person types it')
    await $.command.run(command('sdlc-waive', 'size * generated'))
    expect(world.runs.find(r => r.argv.includes('waive'))?.env).toEqual({ SDLC_HUMAN: '1' })
  })

  test('an edit with no impact hold runs, and gets a per-edit sensor notice', async ($, on) => {
    const world = worldOf(on)
    on('tool.call', () => ({ result: 'edited' }))
    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Edit', tool_use_id: 'tu1', file_path: '/work/src/a.ts', old_string: 'a', new_string: 'b' })
    expect(result.result).toBe('edited')
    expect(world.notices).toEqual(['✓ sdlc'])
  })

  test('an impact hold with no one to ask falls through to the settings hook and approves nothing', async ($, on) => {
    const world = worldOf(on)
    world.impact = { hold: true, slug: 'add-login', consumers: ['checkout'], hits: 2 }
    on('tool.call', ($2, e) => (e.tool === 'AskUserQuestion' ? { deny: 'no one to ask' } : { result: 'edited' }))
    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Edit', tool_use_id: 'tu2', file_path: '/work/../checkout/a.ts', old_string: 'a', new_string: 'b' })
    expect(result.result).toBe('edited')
    expect(world.runs.some(r => r.argv.includes('approve'))).toBe(false)
  })
```

- [ ] **Step 5: Implement the mod split**

Create `hooks/shared.ts`:

```ts
// Helpers shared by the sdlc mod's files.
import type { EngineInterface } from 'claude-code'
import type { Status } from '../types'

// The core script is TypeScript run by Node's built-in type stripping (Node >= 22.18).
export function sdlc($: EngineInterface, ...args: string[]): string[] {
  return ['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/scripts/sdlc.ts`, ...args]
}

export const isInitialised = ($: EngineInterface): Promise<boolean> => $.fs.exists('.sdlc')

export async function statusJson($: EngineInterface): Promise<Status | null> {
  try {
    return JSON.parse((await $.process.run(sdlc($, 'status', '--json'))).stdout) as Status
  } catch {
    return null
  }
}
```

In `types/index.d.ts`, add:

```ts
export type SensorBand = { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number }
export type Status = { initialised: boolean; active?: string | null; changes?: { slug: string; next?: { stage: string } | null }[]; sensors?: SensorBand | null }
```

Then add `sensors: SensorBand | null` to `Band`.

Create `hooks/band.tsx`. Move the `band` and `isHidden` atoms, the context constants and the `AbovePrompt` renderer here from `register.tsx`, then add the sensor text and the pane:

```tsx
// The band above the prompt and the /sdlc-sensors pane: what the sensors saw, at zero tokens.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import type { Band, SensorBand } from '../types'

export const SOFT_CONTEXT = 120_000
export const HARD_CONTEXT = 150_000
export const PANE_ID = 'sdlc-sensors'
export const band = atom({ plugin: 'sdlc', key: 'band' } as const, null as Band | null)
export const paneText = atom({ plugin: 'sdlc', key: 'paneText' } as const, '')
const isHidden = atom({ plugin: 'sdlc', key: 'isHidden' } as const, false)

export function sensorText(s: SensorBand | null): string {
  if (!s) return ''
  const extras = [s.unresolved ? `unresolved ${s.unresolved}` : '', s.knownRed ? `known-red ${s.knownRed}` : '', s.waivers ? `waivers ${s.waivers}` : ''].filter(Boolean)
  const failing = Object.entries(s.bySensor).map(([k, v]) => `${k}(${v})`).join(' ')
  return ` · ${s.blocks ? `✗ ${failing}` : 'sensors ✓'}${extras.length ? ' · ' + extras.join(' · ') : ''}`
}

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, band)
    if (e.props.hasSurvey || current === null || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const k = Math.round(current.contextTokens / 1000)
    const color = current.contextTokens >= HARD_CONTEXT ? 'red' : current.contextTokens >= SOFT_CONTEXT ? 'yellow' : undefined
    const sensorColor = current.sensors?.blocks || current.sensors?.unresolved ? 'red' : undefined
    return (
      <Box>
        <Text dimColor>sdlc · {current.change ?? 'no active change'}{current.stage ? ` · ${current.stage}` : ''} · </Text>
        <Text color={color} dimColor={!color}>ctx {k}k</Text>
        <Text dimColor> · ${current.sessionUsd.toFixed(2)} session{current.contextTokens >= HARD_CONTEXT ? ' · run /sdlc:handoff' : ''}</Text>
        <Text color={sensorColor} dimColor={!sensorColor}>{sensorText(current.sensors)} </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>{(await read($, paneText)) || 'no sensor results yet'}</Text>
      </Box>
    )
  })
}
```

Create `hooks/gates.tsx`:

```tsx
// Human-facing gates at zero tokens: the cross-repo impact dialog and per-edit sensor notices.
// Enforcement stays in the settings hooks and CI; with no one to ask (-p) the call falls through to them.
import type { EngineInterface, On } from 'claude-code'
import { sdlc, isInitialised } from './shared'

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
type Impact = { hold: boolean; slug: string | null; consumers: string[]; hits: number }
type FileFinding = { severity: string; sensor: string; file?: string; line?: number }

async function json<T>($: EngineInterface, ...args: string[]): Promise<T | null> {
  try {
    return JSON.parse((await $.process.run(sdlc($, ...args))).stdout) as T
  } catch {
    return null
  }
}

async function notice($: EngineInterface, toolUseId: string, file: string): Promise<void> {
  const findings = (await json<FileFinding[]>($, 'check-file', file, '--json')) ?? []
  const blocks = findings.filter(f => f.severity === 'block')
  const first = blocks[0]
  $.ui.notice(toolUseId, first ? `✗ ${first.sensor}: ${first.file ?? ''}${first.line ? ':' + first.line : ''}${blocks.length > 1 ? ` (+${blocks.length - 1})` : ''}` : '✓ sdlc')
}

export function registerGates(on: On): void {
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool) || !(await isInitialised($))) return next(e)
    const file = String((e as { file_path?: unknown }).file_path ?? '')
    const impact = file ? await json<Impact>($, 'impact-status', file, '--json') : null
    if (impact?.hold && impact.slug) {
      let answer: string
      try {
        answer = await $.ui.ask(`${file} is part of a cross-repo contract change: ${impact.hits} reference(s) in ${impact.consumers.join(', ')}. Approve the impact for ${impact.slug}?`, { options: ['Approve impact', 'Cancel'], header: 'Impact' })
      } catch {
        return next(e)
      }
      if (answer !== 'Approve impact') return { deny: `The person declined the cross-repo impact for ${impact.slug}.` }
      await $.process.run(sdlc($, 'approve', impact.slug, 'impact'), { env: { SDLC_HUMAN: '1' } })
    }
    const result = await next(e)
    if (file && !result.deny) await notice($, e.tool_use_id, file)
    return result
  })
}
```

Rewrite `hooks/register.tsx`:
1. Keep the header comment, and add the lines `//  - /sdlc-waive and /sdlc-sensors (human-only, zero tokens)` and `//  - the impact dialog and per-edit notices (gates.tsx); the band and pane (band.tsx)`.
2. Import `sdlc`, `isInitialised` and `statusJson` from `./shared`; `band`, `paneText`, `PANE_ID`, `SOFT_CONTEXT`, `HARD_CONTEXT` and `registerBand` from `./band`; and `registerGates` from `./gates`.
3. Delete the moved code (atoms, constants, `sdlc`, `isInitialised` and the `AbovePrompt` handler).
4. `activeStage` now uses `statusJson`.
5. `refreshBand` sets `sensors: (await statusJson($))?.sensors ?? null` on the band value.
6. In `session.start`, also register:

```ts
      await $.command.register({ name: 'sdlc-waive', description: 'sdlc: waive a sensor finding for the active change (human only)', argumentHint: '<sensor> <file|*> <reason>' })
      await $.command.register({ name: 'sdlc-sensors', description: 'sdlc: what the sensors found, known-red and waivers (no model call)', immediate: true })
```

7. Add the handlers:

```ts
  on('command.run', { command: 'sdlc-waive' }, async ($, e) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return { text: 'sdlc-waive runs only when the person types it.' }
    const parts = e.args.trim().split(/\s+/)
    if (parts.length < 3) return { text: 'usage: /sdlc-waive <sensor> <file|*> <reason>' }
    const r = await $.process.run(sdlc($, 'waive', ...parts), { env: { SDLC_HUMAN: '1' } })
    await refreshBand($)
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('command.run', { command: 'sdlc-sensors' }, async $ => {
    const r = await $.process.run(sdlc($, 'sensors'))
    await update($, paneText, () => (r.stdout || r.stderr).trim())
    await $.ui.open({ id: PANE_ID, title: 'sdlc sensors' })
    return { text: (r.stdout || r.stderr).trim() }
  })
```

8. At the end of `register`, call `registerBand(on)` and `registerGates(on)`.

- [ ] **Step 6: Run all the tests**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts && claude plugin test . && claude plugin validate .claude-plugin/plugin.json`
Expected:
- everything passes
- every mod file is 300 lines or fewer
- `validate` lists the hooks `tool.call`, `ui.render`, `command.run`, `turn.*` and `agent.spawn`

If `$.tool.call` in the test harness needs a different input shape for `Edit`, follow the `BuiltinToolInputs` declared in `.claude-plugin/types/claude-code-tools/index.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add hooks/ types/index.d.ts tests/register.test.ts scripts/
git commit -m "feat: mod adds /sdlc-waive, /sdlc-sensors pane, sensor band, impact dialog and per-edit notices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Proof: the seeded-defect suite, the live trial and the docs

**Files:**
- Create:
  - `scripts/seeded.spec.ts`
  - `tests/trials/run-trials.sh`
  - `tests/trials/todo-core/`, copied from the trial seed
  - `tests/trials/acceptance.test.js`
- Modify: `DESIGN.md`, `README.md`, `.claude-plugin/plugin.json` (version `0.2.0`)

**Interfaces:**
- Consumes: everything above.
- Produces: proof for spec §13.
  - **Automated:** the seeded defects and forgery attempts.
  - **Measured:** cost, wall time and noise from live runs.

- [ ] **Step 1: Write the seeded-defect suite (it should pass on the first run, because every sensor exists)**

Create `scripts/seeded.spec.ts`:

```ts
// Spec §13.3 and §13.5: every seeded defect is caught at Stop (no active change, the vibe path) and in CI,
// and every forgery attempt is denied locally or judged against the base.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'

let repo: string
let consumer: string
const BASE_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport { add } from '../src/add.js'\ntest('B1 adds', () => {\n  assert.equal(add(1, 2), 3)\n  assert.equal(add(0, 0), 0)\n})\n"

beforeEach(() => {
  repo = makeRepo()
  consumer = path.join(path.dirname(repo), `${path.basename(repo)}-checkout`)
  fs.mkdirSync(consumer)
  gitIn(consumer, 'init', '-q', '-b', 'main')
  write(consumer, 'src/cart.ts', 'const r = order.discount_rate\n')
  gitIn(consumer, 'add', '.')
  gitIn(consumer, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-qm', 'init')
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({
    layers: [{ from: 'src/domain/**', mustNotImport: ['infra'], why: 'the domain stays framework-free' }],
    consumers: [{ name: 'checkout-service', path: path.relative(repo, consumer).split(path.sep).join('/') }],
    limits: { diffLines: 500, fileLines: 400 },
  }, null, 2))
  write(repo, 'package.json', '{ "type": "module" }\n')
  write(repo, 'src/add.js', 'export const add = (a, b) => a + b\n')
  write(repo, 'test/add.test.js', BASE_TEST)
  write(repo, 'schema/billing.sql', 'CREATE TABLE billing (discount_rate NUMERIC);\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'base')
  gitIn(repo, 'checkout', '-qb', 'pr')
  hook(repo, 'prompt-submit', {})
})

const DEFECTS: [string, RegExp, () => void][] = [
  ['weakened assertion', /test-tamper/, () => write(repo, 'test/add.test.js', BASE_TEST.replace('  assert.equal(add(0, 0), 0)\n', ''))],
  ['added .skip', /test-tamper/, () => write(repo, 'test/add.test.js', BASE_TEST.replace("test('B1", "test.skip('B1"))],
  ['domain → infra import', /layering/, () => write(repo, 'src/domain/order.js', "import { db } from '../infra/db.js'\n")],
  ['Bash-made suppression (sed -i)', /suppression/, () => fs.appendFileSync(path.join(repo, 'src/add.js'), '// eslint-disable-next-line\n')],
  ['schema rename with a live consumer', /contract-impact/, () => write(repo, 'schema/billing.sql', 'CREATE TABLE billing (promotional_discount NUMERIC);\n')],
  ['migration RENAME COLUMN with a live consumer', /contract-impact/, () => write(repo, 'migrations/0002.sql', 'ALTER TABLE billing RENAME COLUMN discount_rate TO promotional_discount;\n')],
  ['agent raises limits.diffLines via Bash', /harness-tamper/, () => write(repo, '.sdlc/sensors.json', fs.readFileSync(path.join(repo, '.sdlc/sensors.json'), 'utf8').replace('500', '5000'))],
]

for (const [name, sensor, apply] of DEFECTS) {
  test(`seeded: ${name} is caught at Stop and in CI`, () => {
    apply()
    const stop = JSON.parse(hook(repo, 'stop', {}).stdout || '{}')
    assert.equal(stop.decision, 'block', name)
    assert.match(stop.reason, sensor)
    gitIn(repo, 'add', '-A')
    gitIn(repo, 'commit', '-qm', 'pr')
    const ci = sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main'])
    assert.equal(ci.code, 1, `${name} in CI:\n${ci.stdout}`)
    assert.match(ci.stdout, sensor)
  })
}

test('seeded: a 700-line diff warns at Stop and blocks in CI', () => {
  write(repo, 'src/huge.js', Array.from({ length: 700 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n')
  assert.notEqual(JSON.parse(hook(repo, 'stop', {}).stdout || '{}').decision, 'block')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'pr')
  assert.match(sdlc(repo, ['check', '--at', 'ci', '--base', 'main', '--config-from', 'main']).stdout, /\[size\][\s\S]*limit 500/)
})

test('seeded: a hand-written passing verification.md does not make a change shippable', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/x/verification.md', '---\nresult: pass\n---\n')
  assert.match(sdlc(repo, ['status']).stdout, /next: \/sdlc:verify x/)
})

test('seeded: a B-number with no test blocks at ship', () => {
  sdlc(repo, ['new', 'sub', '--type', 'feature', '--tier', 'M'])
  write(repo, '.sdlc/changes/sub/plan.md', '## Files\n- src/**\n- test/**\n## Slices\n1. B1 add, B2 subtract\n')
  assert.match(sdlc(repo, ['check', '--at', 'ship', '--base', 'main', '--slug', 'sub']).stdout, /B2 has no test that names it/)
})

test('forgery: appending to runs.jsonl, bumping the gate and model approvals or waivers are denied', () => {
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  const deny = (command: string) => JSON.parse(hook(repo, 'pre-bash', { tool_input: { command } }).stdout).hookSpecificOutput.permissionDecision
  assert.equal(deny(`echo '{"cmd":"npm test","exit":0}' >> .sdlc/changes/x/runs.jsonl`), 'deny')
  assert.equal(deny(`echo '{"blocks":{"main":2}}' > .sdlc/.gate`), 'deny')
  assert.equal(deny('node /p/scripts/sdlc.ts approve x plan'), 'deny')
  assert.equal(deny('node /p/scripts/sdlc.ts waive size * x'), 'deny')
  const binEdit = JSON.parse(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, '.sdlc/bin/sensors.ts'), content: '' } }).stdout)
  assert.equal(binEdit.hookSpecificOutput.permissionDecision, 'ask')
})
```

- [ ] **Step 2: Run the suite**

Run: `node --disable-warning=ExperimentalWarning --test scripts/seeded.spec.ts`
Expected: PASS for all 12 tests. Any failure is a real gap, so fix the owning sensor (Tasks 5–12), not the test.

- [ ] **Step 3: Bring the live-trial fixture into the repo**

```bash
mkdir -p tests/trials
cp -R /private/tmp/claude-501/-Users-chamindawijayasundara-Documents-learning-101-claude-code-harness-lite-v2/0a9ceab4-1be1-4128-9112-05bd1e710644/scratchpad/trial-seed tests/trials/todo-core
rm -rf tests/trials/todo-core/.git tests/trials/todo-core/.sdlc
cp /private/tmp/claude-501/-Users-chamindawijayasundara-Documents-learning-101-claude-code-harness-lite-v2/0a9ceab4-1be1-4128-9112-05bd1e710644/scratchpad/acceptance.test.js tests/trials/acceptance.test.js
```

If the scratchpad is gone, rebuild `todo-core` with the following files and the tests that cover them:
- `src/store.js` (in-memory `TodoStore`)
- `src/service.js` (`TodoService` create/list/complete)
- `src/validation.js`
- `src/http.js` (`createHandler(service)` routing `POST /todos`, `GET /todos`, `PATCH /todos/:id/complete`)

Add `tests/trials/` to `ignore` in this plugin's `.sdlc/sensors.json`, so the fixture never counts toward this repo's size limits.

- [ ] **Step 4: Write `tests/trials/run-trials.sh`**

```bash
#!/usr/bin/env bash
# Live trial (spec §13.4 and §13.6): tier M with the harness vs plain Claude Code. Costs real money (about $2).
# Usage: tests/trials/run-trials.sh [outdir]. Prints cost, turns, wall time, Stop blocks and acceptance.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$(mktemp -d)}"
SDLC="node --disable-warning=ExperimentalWarning $P/scripts/sdlc.ts"
TASK='Add optional due dates to todos: POST /todos accepts dueDate (ISO YYYY-MM-DD, validated, 400 on invalid), GET /todos?overdue=true returns only not-done todos whose dueDate is before today, and GET /todos sorts by dueDate ascending with undated todos last. Include tests.'
FLAGS=(--permission-mode acceptEdits --allowedTools "Bash(node *)" "Bash(git *)" "Bash(npm *)" --max-budget-usd 8 --output-format json)

fresh() { rm -rf "$OUT/$1"; cp -R "$P/tests/trials/todo-core" "$OUT/$1"; (cd "$OUT/$1" && git init -q -b main && git add -A && git -c user.email=t@e -c user.name=T commit -qm base); }
stat() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(round(d.get('total_cost_usd',0),3), d.get('num_turns'), round(d.get('duration_ms',0)/1000), 's')" "$1"; }
accept() { (cd "$OUT/$1" && TRIAL_ROOT="$OUT/$1" node --test "$P/tests/trials/acceptance.test.js" 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' '); }

fresh harness
(cd "$OUT/harness" && $SDLC init >/dev/null && echo '{ "fast": { "test": "node --test" }, "full": { "test": "node --test" } }' > .sdlc/sensors.json && git add -A && git -c user.email=t@e -c user.name=T commit -qm onboard)
(cd "$OUT/harness" && claude -p "/sdlc:start \"$TASK\" — then continue into the plan stage and stop at the human gate." --plugin-dir "$P" "${FLAGS[@]}" > "$OUT/harness.A.json")
(cd "$OUT/harness" && SDLC_HUMAN=1 $SDLC approve "$(ls .sdlc/changes)" plan --by trial-operator >/dev/null)
(cd "$OUT/harness" && claude -p "/sdlc:build $(ls "$OUT/harness/.sdlc/changes") — then continue through review and ship; commit on the branch, do not push." --plugin-dir "$P" "${FLAGS[@]}" > "$OUT/harness.B.json")
echo "harness A: $(stat "$OUT/harness.A.json") | B: $(stat "$OUT/harness.B.json") | acceptance: $(accept harness)"
echo "harness Stop blocks: $(grep -c '"blocks"' "$OUT/harness/.sdlc/.gate" 2>/dev/null || echo 0); skill fallbacks: $(grep -c skill-load-failed "$OUT/harness/.sdlc/usage.jsonl" 2>/dev/null || echo 0)"

fresh plain
(cd "$OUT/plain" && claude -p "$TASK" "${FLAGS[@]}" > "$OUT/plain.json")
echo "plain: $(stat "$OUT/plain.json") | acceptance: $(accept plain)"
echo "artifacts in $OUT"
```

Run `chmod +x tests/trials/run-trials.sh`.

- [ ] **Step 5: Run the live trial and record the measurements**

Run: `tests/trials/run-trials.sh "$TMPDIR/sdlc-trial"`. It takes about 10 minutes and costs about $2.

Then add a subsection `### Spec 1 trial (<date>)` to `DESIGN.md` §10 containing:
1. The measured table, with the columns Run, Sessions, Cost, Turns, Wall time and Acceptance.
2. The number of Stop blocks. For each block, record whether it was real or a false positive by reading `.sdlc/unresolved.json` and the transcripts. The target is 0 false positives.
3. The cost delta of the Stop gate against the 2026-10-03 tier M trial ($1.08). The target is ≤ 5%.
4. The median Stop-gate time. The target is ≤ 15 s; read the `ms` fields in `runs.jsonl`.

**If a target is missed, record that honestly** and add the follow-up to §11. Do not tune the trial to pass.

Then check by hand, in an interactive session (spec §15):
- With the plugin loaded and an unapproved impact, ask Claude to edit a consumer file. Confirm the mod's impact dialog appears. Check this for a subagent's edit too.
- Confirm the band shows `sensors ✓` or `✗ <sensor>`.
- Confirm `/sdlc-sensors` opens its pane.

Record each result in the same subsection.

- [ ] **Step 6: Update the docs and the version**

1. In `.claude-plugin/plugin.json`, set `"version": "0.2.0"`.
2. In `README.md`:
   1. Add `/sdlc-waive <sensor> <file|*> <reason>` and `/sdlc-sensors` to the "Use" table, and `/sdlc:rule "<what keeps recurring>"` too.
   2. Add a `## Guides and sensors` section of 15 lines or fewer covering:
      - the `.sdlc/sensors.json` keys
      - the built-in sensors: test-tamper, suppression, layering, size, secrets, rules, contract-impact, harness-tamper, traceability and red-proof
      - when they fire: edit, Stop, plan, ship and CI
      - the 2-block cap, the known-red ratchet and waivers
      - `sdlc.ts vendor` plus `templates/sdlc-check.yml` as the required check
   3. In "What is in the box", list the nine scripts with one line each, plus `guides/` and `templates/sdlc-check.yml`.
   4. Change the "Develop" commands to `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`, keep `claude plugin test .`, and add `tests/trials/run-trials.sh` (live and paid).
3. In `DESIGN.md`:
   - Add rows to §2 Principles, under the guardrails item: "computational sensors on the hot path, inferential review once per change; local == CI via one `check` entry point".
   - In §11 "Open items", strike the three items from the 2026-10-03 trials, which are now fixed: captured exit codes, STATE.md cleared at ship, and the skill fallback.

- [ ] **Step 7: Run everything one last time**

Run: `npm run typecheck && npm test && claude plugin validate .claude-plugin/plugin.json`
Expected: everything passes.

- [ ] **Step 8: Commit**

```bash
git add scripts/seeded.spec.ts tests/trials/ DESIGN.md README.md .claude-plugin/plugin.json .sdlc/sensors.json
git commit -m "test: seeded-defect and forgery suite, live trial runner and results; docs for v0.2.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
