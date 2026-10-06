# Enforcement Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run rig's checks at `git commit` and `git push`, surface non-blocking warnings to the agent, and stop the model from bypassing the hooks, so vibe-coded and hand-written changes are judged like `/rig:start` work.

**Architecture:** One new module, `scripts/githooks.ts`, owns install/uninstall/status, the two `sh` hook scripts and the push check. `check.ts` gains a `commit` point that normalises to `stop` semantics but reads the staged diff and index text. `hooks.ts` gains warning carry-over, session-start install and pre-bash denials. Everything calls the existing `sdlc.ts check`, so local equals CI.

**Tech Stack:** Node >= 22.18 with type stripping (no build step), `node:test`, POSIX `sh`, git.

**Spec:** `docs/superpowers/specs/2026-10-06-everywhere-enforcement-design.md`. Two refinements discovered while planning (applied to the spec in Task 4, Step 1): the push check diffs against the remote sha that git passes on `pre-push` stdin (a plain `defaultBase()` is `null` when pushing trunk), and an in-flight rig-managed change is not re-judged at push (`/rig:pr` owns it); only `adhoc-*` changes get ship verdicts.

## Global Constraints

- Node `>=22.18`; scripts are plain `.ts` run directly, **no build step, no runtime dependencies**.
- Run tests with `node --disable-warning=ExperimentalWarning --test scripts/<file>.spec.ts`; typecheck with `npm run typecheck`.
- `scripts/size.spec.ts` caps the harness at 6100 lines (tests and docs excluded); this plan raises it in Task 7.
- Hooks must never wedge a session: a hook that cannot run warns and lets git or Claude continue. A finding with `severity: 'block'` still blocks.
- The model cannot bypass: `git commit --no-verify`, `git push --no-verify`, and anything naming `core.hooksPath` are denied for the model only.
- `check --at commit` writes nothing (no change record, no `sensors.json` ratchet). Only `check --at push` may create one `adhoc-…` change.
- POSIX `sh` hook scripts; Windows stays unsupported.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A repo with **no commits yet**: `pre-commit` must judge the staged diff (no `HEAD` to compare), not crash.
2. **Merge, rebase and amend**: a merge in progress or a rebase replaying commits must skip the hook; an empty staged diff (`--amend` with nothing new) must pass at once.
3. **Staged file names with spaces and binary files** must be judged or skipped, never crash the diff parser.
4. **Push edge refs**: a branch delete, a tag push, a brand-new branch with no base, and a **direct push to trunk** must each behave (allow, allow, skip with notice, and judge against the remote sha).
5. **Commit from a subdirectory** with a relative `core.hooksPath`, and with `node` missing from `PATH`, must still run (or warn and allow), never fail with a shell error.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/githooks.ts` (new) | `HOOKS_DIR`, hook script text, `writeHookScripts`, `hooksState`, `installHooks`, `uninstallHooks`, `cmdHooks`, `sessionNote`, push check (`parsePushRefs`, `cmdCheckPush`) |
| `scripts/githooks.spec.ts` (new) | All tests for this plan |
| `scripts/model.ts` | `githooks` config key: type, default, parsing |
| `scripts/sensors.ts` | `PROTECTED` gets `.sdlc/githooks/**`; `weakensConfig` knows `githooks` |
| `scripts/diffs.ts` | `stagedDiff`, `showStaged`, `rangeDiff`, `fileLines` text reader |
| `scripts/check.ts` | `commit` point, `after` reader, `--at commit` |
| `scripts/quality.ts` | `runQuality(slug, baseRef)` |
| `scripts/graph.ts` | `createAdhoc(tier)` moved here from `hooks.ts` so both modules can use it |
| `scripts/hooks.ts` | session-start note, warn carry-over, Stop `systemMessage`, pre-bash denials |
| `scripts/vendor.ts`, `scripts/sdlc.ts` | vendor the new module and scripts; register `hooks`; route `check --at push` |
| `skills/init/SKILL.md`, `README.md`, `DESIGN.md`, `CHANGELOG.md`, `scripts/size.spec.ts` | docs and cap |

Shared test setup used by every task (defined once at the top of `scripts/githooks.spec.ts` in Task 2):

```ts
const SECRET = 'const apikey = "abcdefghijklmnop12345678"\n'
let repo: string
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', '{}')
})
```

---

### Task 1: `githooks` config key and protected hook scripts

**Files:**
- Modify: `scripts/model.ts` (type at `:24-42`, `DEFAULT_CONFIG` at `:44-62`, `parseConfig` at `:296-340`)
- Modify: `scripts/sensors.ts` (`PROTECTED` at `:224`, `weakensConfig` at `:232-260`)
- Test: `scripts/sensors.spec.ts`

**Interfaces:**
- Produces: `SensorConfig.githooks: { prePush: 'ship' | 'off'; budgetMs: number }`; `DEFAULT_CONFIG.githooks = { prePush: 'ship', budgetMs: 300_000 }`; `isProtected('.sdlc/githooks/pre-commit') === true`.

- [ ] **Step 1: Write the failing tests** (append to `scripts/sensors.spec.ts`; add `parseConfig` to its `./model.ts` import)

```ts
test('githooks config defaults to ship, parses, and turning pre-push off counts as weakening', () => {
  assert.deepEqual(parseConfig('').config.githooks, { prePush: 'ship', budgetMs: 300_000 })
  const off = parseConfig('{"githooks":{"prePush":"off","budgetMs":1000}}')
  assert.deepEqual(off.errors, [])
  assert.deepEqual(off.config.githooks, { prePush: 'off', budgetMs: 1000 })
  assert.match(parseConfig('{"githooks":{"prePush":"later"}}').errors.join(), /githooks\.prePush must be/)
  assert.match(parseConfig('{"githooks":{"budgetMs":-1}}').errors.join(), /githooks\.budgetMs must be a positive number/)
  assert.match(parseConfig('{"githooks":{"nope":1}}').errors.join(), /githooks: unknown key "nope"/)
  assert.match(parseConfig('{"githooks":5}').errors.join(), /githooks must be/)
  assert.ok(weakensConfig('{}', '{"githooks":{"prePush":"off"}}').some(r => /prePush/.test(r)))
  assert.ok(weakensConfig('{}', '{"githooks":{"budgetMs":900000}}').some(r => /budgetMs/.test(r)))
  assert.deepEqual(weakensConfig('{}', '{"githooks":{"budgetMs":1000}}'), [])
})

test('the git hook scripts are protected harness files', () => {
  assert.ok(isProtected('.sdlc/githooks/pre-commit'))
  assert.ok(isProtected('.sdlc/githooks/pre-push'))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="githooks config|hook scripts are protected" scripts/sensors.spec.ts`
Expected: FAIL (`githooks` is `undefined`; `unknown key "githooks"`).

- [ ] **Step 3: Implement**

In `scripts/model.ts`, add to `SensorConfig` (after `build`):

```ts
  githooks: { prePush: 'ship' | 'off'; budgetMs: number }
```

Add to `DEFAULT_CONFIG` (after `build: 'native',`):

```ts
  githooks: { prePush: 'ship', budgetMs: 300_000 },
```

In `parseConfig`, immediately before `parseV4(value, config, errors)`:

```ts
  if ('githooks' in value) {
    const g = isObject(value.githooks) ? value.githooks : null
    if (!g) errors.push('githooks must be { prePush?: "ship" | "off", budgetMs?: number }')
    else {
      if ('prePush' in g) {
        if (g.prePush === 'ship' || g.prePush === 'off') config.githooks.prePush = g.prePush
        else errors.push('githooks.prePush must be "ship" or "off"')
      }
      if ('budgetMs' in g) {
        if (typeof g.budgetMs === 'number' && g.budgetMs > 0) config.githooks.budgetMs = g.budgetMs
        else errors.push('githooks.budgetMs must be a positive number')
      }
      for (const k of Object.keys(g)) if (k !== 'prePush' && k !== 'budgetMs') errors.push(`githooks: unknown key "${k}"`)
    }
  }
```

In `scripts/sensors.ts`, append `'.sdlc/githooks/**'` to `PROTECTED`, and in `weakensConfig` after the `ratchet` loop:

```ts
  if (b.githooks.prePush === 'ship' && a.githooks.prePush === 'off') reasons.push('githooks.prePush turned off')
  if (a.githooks.budgetMs > b.githooks.budgetMs) reasons.push(`githooks.budgetMs raised ${b.githooks.budgetMs} → ${a.githooks.budgetMs}`)
```

- [ ] **Step 4: Run to verify pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/sensors.spec.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/model.ts scripts/sensors.ts scripts/sensors.spec.ts
git commit -m "feat(config): githooks key; hook scripts are protected harness files

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `check --at commit` judges the staged diff

**Files:**
- Modify: `scripts/diffs.ts` (add after `branchDiff` at `:84`; `fileLines` at `:88`)
- Modify: `scripts/check.ts` (`Point`/`CheckInput` at `:17-30`, `runChecks` at `:292-317`, `cmdCheck` at `:377-409`)
- Create: `scripts/githooks.spec.ts`

**Interfaces:**
- Produces: `stagedDiff(): FileDiff[]`; `showStaged(rel: string): string | null`; `fileLines(files, textOf?)`; `Point = 'stop' | 'commit' | 'ship' | 'ci'`; `CheckInput.after?: (file: string) => string`; CLI `check --at commit`.

- [ ] **Step 1: Write the failing tests** (create `scripts/githooks.spec.ts`)

```ts
// Git hooks: check --at commit and push, install, the hook scripts, warning carry-over and the model's bypass denials.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'

const SECRET = 'const apikey = "abcdefghijklmnop12345678"\n'
let repo: string
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', '{}')
})
const stage = (rel: string, text: string): void => {
  write(repo, rel, text)
  gitIn(repo, 'add', rel)
}
const commit = () => sdlc(repo, ['check', '--at', 'commit'])

test('check --at commit blocks a staged secret and ignores what is not staged', () => {
  stage('src/a.js', SECRET)
  const bad = commit()
  assert.equal(bad.code, 1)
  assert.match(bad.stdout, /secrets/)
  gitIn(repo, 'reset', '-q')
  assert.equal(commit().code, 0, 'nothing staged: nothing to judge')
  stage('src/b.js', 'export const ok = 1\n')
  write(repo, 'src/c.js', SECRET) // untracked and unstaged: not part of this commit
  assert.equal(commit().code, 0, commit().stdout)
})

test('the index is what counts, not the working copy', () => {
  stage('src/a.js', SECRET)
  write(repo, 'src/a.js', 'export const ok = 1\n') // working copy cleaned after staging
  assert.equal(commit().code, 1, 'the staged secret still blocks')
  gitIn(repo, 'reset', '-q')
  stage('src/a.js', 'export const ok = 1\n')
  write(repo, 'src/a.js', SECRET) // secret only in the working copy
  assert.equal(commit().code, 0)
})

test('staged assertion removal blocks as test-tamper', () => {
  stage('test/a.test.js', "import assert from 'node:assert'\nassert.equal(1, 1)\nassert.equal(2, 2)\n")
  gitIn(repo, 'commit', '-qm', 'tests')
  stage('test/a.test.js', "import assert from 'node:assert'\n")
  const r = commit()
  assert.equal(r.code, 1)
  assert.match(r.stdout, /test-tamper/)
})

test('a failing fast command blocks; a size warning prints but does not block', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "process.exit(1)"' }, limits: { fileLines: 5 } }))
  stage('src/a.js', 'export const a = 1\n')
  const red = commit()
  assert.equal(red.code, 1)
  assert.match(red.stdout, /fast\.test/)
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { fileLines: 5 } }))
  stage('src/big.js', Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n')
  const warn = commit()
  assert.equal(warn.code, 0)
  assert.match(warn.stdout, /size/)
})

test('file names with spaces are judged; a binary file is skipped without a crash', () => {
  stage('src/my file.js', SECRET)
  const r = commit()
  assert.equal(r.code, 1)
  assert.match(r.stdout, /my file\.js/)
  gitIn(repo, 'reset', '-q')
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0, 0, 1, 2, 3]))
  gitIn(repo, 'add', 'logo.png')
  assert.equal(commit().code, 0)
})

test('a repo with no commits yet is judged against nothing, not a crash', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-fresh-'))
  gitIn(fresh, 'init', '-q', '-b', 'main')
  write(fresh, '.sdlc/sensors.json', '{}')
  write(fresh, 'src/a.js', SECRET)
  gitIn(fresh, 'add', 'src/a.js')
  const r = sdlc(fresh, ['check', '--at', 'commit'])
  assert.equal(r.code, 1, r.stderr)
  assert.match(r.stdout, /secrets/)
})

test('a merge or rebase in progress is skipped, and the skip says so', () => {
  stage('src/a.js', SECRET)
  const rebase = sdlc(repo, ['check', '--at', 'commit'], { env: { GIT_REFLOG_ACTION: 'rebase (pick)' } })
  assert.equal(rebase.code, 0)
  assert.match(rebase.stdout, /skipped/)
  fs.writeFileSync(path.join(repo, '.git/MERGE_HEAD'), gitIn(repo, 'rev-parse', 'HEAD') + '\n')
  const merge = commit()
  assert.equal(merge.code, 0)
  assert.match(merge.stdout, /skipped/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --disable-warning=ExperimentalWarning --test scripts/githooks.spec.ts`
Expected: FAIL (`usage: check --at stop|ship|ci|plan …`, exit 1 from `fail`, so the "code 0" assertions fail).

- [ ] **Step 3: Implement `diffs.ts`**

After `branchDiff`:

```ts
// What `git commit` would record: the index against HEAD (no HEAD yet means everything staged is new).
export const stagedDiff = (): FileDiff[] => parseUnifiedDiff(git([...DIFF, '--cached']) ?? '')
export const showStaged = (rel: string): string | null => git(['show', `:${rel}`])
```

Replace `fileLines` with a version that can read from the index:

```ts
export function fileLines(files: string[], textOf: (rel: string) => string = rel => read(path.join(ROOT, rel))): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of files) {
    if (tooBig(f)) continue
    const text = textOf(f)
    if (text) counts[f] = text.replace(/\n$/, '').split('\n').length
  }
  return counts
}
```

- [ ] **Step 4: Implement `check.ts`**

Change the types:

```ts
export type Point = 'stop' | 'commit' | 'ship' | 'ci'
export type CheckInput = {
  point: Point
  // ...existing fields...
  after?: (file: string) => string // the text being judged; defaults to the working tree (commit passes the index)
```

Import `stagedDiff, showStaged` from `./diffs.ts`. In `runChecks`, normalise at the top and use `point`/`after` where `i.point` was compared for judging (leave `logRuleFires(…, i.point)` and the `runDeclared` `i.point === 'ci'` uses alone):

```ts
export function runChecks(i: CheckInput): CheckResult {
  const { diffs, config } = i
  // A commit judges a partial diff, like Stop: same severities, same sensors. Only its wiki check and its text source differ.
  const point = i.point === 'commit' ? 'stop' : i.point
  const after = i.after ?? ((f: string) => read(path.join(ROOT, f)))
  const pattern = withoutFixtures(diffs, config)
  const findings: Finding[] = [
    ...testTamper(pattern, config),
    ...suppressions(pattern, config),
    ...layering(pattern, config),
    ...size(diffs, config, fileLines(diffs.filter(d => d.status !== 'D').map(d => d.file), after), point),
    ...secretsInDiff(pattern),
    ...rulesSensor(pattern, i.rules),
    ...contractFindings({ ...i, point }),
    ...harnessTamper(diffs, { point, toolEdited: i.toolEdited, before: i.before, after }),
  ]
  // ... size-severity block unchanged ...
  if (point !== 'stop') for (const slug of i.slugs) findings.push(...shipVerdicts(slug, config, diffs, i.base, i.budgetMs))
  if (i.point !== 'stop') findings.push(...wikiFindings())
  if (i.point === 'ci' && !i.slugs.length) findings.push(...unrecorded(diffs, config))
  if (point !== 'stop') findings.push(...tierFindings(i.slugs, diffs, config))
```

(Keep the unchanged lines between as they are: the plan-approved size downgrade, `runDeclared`, `applyWaivers`, `logRuleFires`.)

In `cmdCheck`: update the usage text to `check --at stop|commit|ship|ci|plan …`, accept `'commit'`, and replace the diff block and the `runChecks` call:

```ts
  if (at !== 'stop' && at !== 'commit' && at !== 'ship' && at !== 'ci') fail('usage: check --at stop|commit|ship|ci|plan [--base <ref>] [--config-from <ref>] [--slug <s>] [--budget-ms <n>] [--json]')
  // ...
  const partial = at === 'stop' || at === 'commit'
  let diffs: FileDiff[]
  let before: (f: string) => string
  let after: ((f: string) => string) | undefined
  if (at === 'commit') {
    // A merge replays other people's commits and a rebase replays your own: CI judges the result.
    if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']) || /^(?:rebase|merge)/.test(process.env.GIT_REFLOG_ACTION ?? '')) return out('sdlc check commit: skipped (merge or rebase in progress; CI judges the result)')
    diffs = stagedDiff()
    if (!diffs.length) return out('sdlc check commit: nothing staged')
    before = f => showAt('HEAD', f) ?? ''
    after = f => showStaged(f) ?? ''
    if (git(['diff', '--name-only'])) process.stderr.write('rig: the fast commands run against your working tree, which has unstaged changes\n')
  } else if (at === 'stop') {
    // ... existing stop block unchanged ...
  } else {
    // ... existing branchDiff block unchanged ...
  }
```

and:

```ts
  const budgetMs = Number(optString(args, 'budget-ms') ?? (partial ? 60_000 : 1_800_000))
  // ...
  const result = runChecks({ point: at, diffs, config, rules, slugs, commands: partial ? 'fast' : 'full', budgetMs, before, after, base, ratchet: !optString(args, 'config-from') && at !== 'commit' })
```

Note `slugs` for `commit` follows the existing non-`ci` branch (`[activeSlug()]`).

- [ ] **Step 5: Run to verify pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/githooks.spec.ts scripts/check.spec.ts scripts/gate.spec.ts && npm run typecheck`
Expected: PASS. If the "no commits yet" test fails inside `snapshot()`/`defaultBase()`, the `commit` path must not call them (it does not in the code above); fix the call, do not weaken the test.

- [ ] **Step 6: Commit**

```bash
git add scripts/diffs.ts scripts/check.ts scripts/githooks.spec.ts
git commit -m "feat(check): --at commit judges the staged diff from the index

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `hooks install | uninstall | status` and the hook scripts

**Files:**
- Create: `scripts/githooks.ts`
- Modify: `scripts/sdlc.ts` (import and `COMMANDS` at `:381`), `scripts/vendor.ts` (`VENDORED` at `:9`, `cmdVendor` at `:~110`)
- Test: `scripts/githooks.spec.ts`

**Interfaces:**
- Produces (all exported from `scripts/githooks.ts`): `HOOKS_DIR = '.sdlc/githooks'`; `writeHookScripts(written?: string[]): void`; `hooksState(): { state: 'installed' | 'missing' | 'other'; path: string }`; `installHooks(force?: boolean): { ok: boolean; message: string }`; `uninstallHooks(): string`; `cmdHooks(args: Args): void`.

- [ ] **Step 1: Write the failing tests** (append to `scripts/githooks.spec.ts`)

```ts
test('hooks install needs the vendored checker, writes executable scripts and sets core.hooksPath', () => {
  const early = sdlc(repo, ['hooks', 'install'])
  assert.equal(early.code, 1)
  assert.match(early.stderr, /vendor/)
  assert.equal(sdlc(repo, ['vendor']).code, 0)
  for (const n of ['pre-commit', 'pre-push']) assert.ok(fs.statSync(path.join(repo, '.sdlc/githooks', n)).mode & 0o111, `${n} is executable after vendor`)
  const r = sdlc(repo, ['hooks', 'install'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.sdlc/githooks')
  assert.match(sdlc(repo, ['hooks', 'status']).stdout, /installed/)
  assert.equal(sdlc(repo, ['hooks', 'uninstall']).code, 0)
  assert.match(sdlc(repo, ['hooks', 'status']).stdout, /not installed/)
})

test('hooks install leaves another core.hooksPath alone unless --force', () => {
  sdlc(repo, ['vendor'])
  gitIn(repo, 'config', 'core.hooksPath', '.husky')
  const r = sdlc(repo, ['hooks', 'install'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /\.husky/)
  assert.match(r.stderr, /sh \.sdlc\/githooks\/pre-commit/)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.husky')
  assert.equal(sdlc(repo, ['hooks', 'install', '--force']).code, 0)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.sdlc/githooks')
})

test('with hooks installed, git commit refuses a staged secret (also from a subdirectory) and accepts clean code', () => {
  sdlc(repo, ['vendor'])
  sdlc(repo, ['hooks', 'install'])
  stage('src/a.js', SECRET)
  assert.throws(() => gitIn(repo, 'commit', '-qm', 'bad'))
  assert.throws(() => execFileSync('git', ['commit', '-qm', 'bad'], { cwd: path.join(repo, 'src'), stdio: 'ignore' }), 'a subdirectory commit is judged too')
  gitIn(repo, 'reset', '-q')
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'ok')
  assert.equal(gitIn(repo, 'log', '-1', '--format=%s'), 'ok')
})

test('a hook that cannot find node warns and lets the commit through', () => {
  sdlc(repo, ['vendor'])
  sdlc(repo, ['hooks', 'install'])
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-path-'))
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'))
  const r = spawnSync('/bin/sh', [path.join(repo, '.sdlc/githooks/pre-commit')], { cwd: repo, env: { PATH: bin }, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /Node >= 22\.18 not found/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="hooks install|hook that cannot|with hooks installed" scripts/githooks.spec.ts`
Expected: FAIL (`usage: sdlc.ts <…>` for the unknown `hooks` command).

- [ ] **Step 3: Implement `scripts/githooks.ts`**

```ts
// Git hooks: the same checker as Stop, ship and CI, run at `git commit` and `git push`, so any editor, agent or person is judged.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, git, exists, out, fail, type Args } from './core.ts'

export const HOOKS_DIR = '.sdlc/githooks'
const NAMES = ['pre-commit', 'pre-push'] as const
const AT = { 'pre-commit': 'commit', 'pre-push': 'push' } as const

// A hook that cannot run warns and lets git go on: CI is the floor, and a broken hook must not wedge a repo.
const script = (name: (typeof NAMES)[number]): string => [
  '#!/bin/sh',
  '# rig: runs the same checker as Stop, ship and CI.',
  'cd "$(git rev-parse --show-toplevel)" || exit 0',
  `if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then`,
  `  echo "rig: Node >= 22.18 not found, skipping ${name} (CI still checks)" >&2; exit 0`,
  'fi',
  `[ -f .sdlc/bin/sdlc.ts ] || { echo "rig: .sdlc/bin/sdlc.ts is missing, skipping ${name} (run vendor, then hooks install)" >&2; exit 0; }`,
  `exec node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts check --at ${AT[name]}`,
  '',
].join('\n')

export function writeHookScripts(written: string[] = []): void {
  fs.mkdirSync(path.join(ROOT, HOOKS_DIR), { recursive: true })
  for (const name of NAMES) {
    const file = path.join(ROOT, HOOKS_DIR, name)
    fs.writeFileSync(file, script(name))
    fs.chmodSync(file, 0o755)
    written.push(`${HOOKS_DIR}/${name}`)
  }
}

export type HooksState = 'installed' | 'missing' | 'other'
export function hooksState(): { state: HooksState; path: string } {
  const p = git(['config', '--local', '--get', 'core.hooksPath']) ?? ''
  return { state: p === HOOKS_DIR ? 'installed' : p === '' ? 'missing' : 'other', path: p }
}

export function installHooks(force = false): { ok: boolean; message: string } {
  if (!exists(path.join(SDLC, 'bin', 'sdlc.ts'))) return { ok: false, message: 'git hooks run the vendored checker: run `vendor` (or `vendor --standalone`) first so .sdlc/bin/sdlc.ts exists' }
  writeHookScripts()
  const { state, path: current } = hooksState()
  if (state === 'other' && !force) {
    return { ok: false, message: `core.hooksPath is already ${current}, so it was left alone. Call rig from your existing hooks instead:\n  sh .sdlc/githooks/pre-commit\n  sh .sdlc/githooks/pre-push "$@"\nor re-run with --force to replace it.` }
  }
  git(['config', '--local', 'core.hooksPath', HOOKS_DIR])
  return { ok: true, message: `git hooks installed (core.hooksPath = ${HOOKS_DIR}): commit and push now run the rig checks` }
}

export function uninstallHooks(): string {
  if (hooksState().state !== 'installed') return 'rig git hooks are not installed; nothing changed'
  git(['config', '--local', '--unset', 'core.hooksPath'])
  return 'rig git hooks uninstalled (core.hooksPath unset); the scripts stay in .sdlc/githooks'
}

export function cmdHooks(args: Args): void {
  const sub = args.pos[0]
  if (sub === 'install') {
    const r = installHooks(Boolean(args.opt.force))
    if (!r.ok) fail(r.message)
    return out(r.message)
  }
  if (sub === 'uninstall') return out(uninstallHooks())
  if (sub === 'status') {
    const { state, path: p } = hooksState()
    return out(state === 'installed' ? `rig git hooks installed (${HOOKS_DIR})` : state === 'other' ? `rig git hooks not installed: core.hooksPath is ${p}` : 'rig git hooks not installed: run `sdlc.ts hooks install`')
  }
  out('usage: hooks install [--force] | uninstall | status')
}
```

- [ ] **Step 4: Wire it up**

`scripts/sdlc.ts`: add `import { cmdHooks } from './githooks.ts'` beside the other command imports, and `hooks: cmdHooks,` in `COMMANDS`.

`scripts/vendor.ts`: add `'githooks'` to `VENDORED`, import `writeHookScripts` from `./githooks.ts`, and in `cmdVendor` after the `for (const name of VENDORED)` loop:

```ts
  writeHookScripts(written)
```

- [ ] **Step 5: Run to verify pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/githooks.spec.ts scripts/vendor.spec.ts && npm run typecheck`
Expected: PASS. If the no-`node` test is flaky on a platform where a symlinked `git` cannot find its helpers, keep the assertion and make the PATH dir also contain symlinks to the platform's `sh` utilities the script uses (`cd`, `command` are builtins; only `git` is external), rather than dropping the test.

- [ ] **Step 6: Commit**

```bash
git add scripts/githooks.ts scripts/sdlc.ts scripts/vendor.ts scripts/githooks.spec.ts
git commit -m "feat(hooks): install rig pre-commit and pre-push as git hooks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `check --at push` (ship verdicts plus the quality ratchet)

**Files:**
- Modify: `scripts/diffs.ts` (`rangeDiff`), `scripts/quality.ts:83-85` (`runQuality`), `scripts/graph.ts` (`createAdhoc`), `scripts/hooks.ts:355-362` (remove `createAdhoc`, import it), `scripts/githooks.ts` (push check), `scripts/sdlc.ts` (route)
- Modify: `docs/superpowers/specs/2026-10-06-everywhere-enforcement-design.md` §4.2
- Test: `scripts/githooks.spec.ts`

**Interfaces:**
- Consumes: `runChecks`, `loadConfig`, `report`-style output from Task 2; `installHooks` from Task 3.
- Produces: `rangeDiff(base: string, head?: string): FileDiff[]`; `runQuality(slug: string, baseRef?: string | null)`; `createAdhoc(tier: Tier): string` (graph.ts); `parsePushRefs(stdin: string): PushRef[]`; `cmdCheckPush(args: Args): void`; CLI `check --at push` (reads git's pre-push stdin).

- [ ] **Step 1: Amend the spec** (§4.2, replace the first paragraph's diff sentence and add the slug rule)

Replace "For `pre-push`, `check --at ship --base <default base>` on the pushed branch." with: "For `pre-push`, `check --at push`: for each pushed branch, the commits the remote lacks (`git diff <remote sha> <local sha>` from the hook's stdin; a new branch uses the merge-base with the default branch; a delete or tag push and a new branch with no base are skipped with a notice) are judged by the ship checks." Add: "Ship verdicts (traceability, red-proof, tier, `adhoc`) apply to an `adhoc-*` change only; a rig-managed change in flight is gated by `/rig:pr`, which owns it, and CI re-judges it. The quality ratchet runs for whichever change is active." Commit with the code in Step 7.

- [ ] **Step 2: Write the failing tests** (append to `scripts/githooks.spec.ts`)

```ts
const ZERO = '0'.repeat(40)
const push = (local: string, remote: string, ref = 'refs/heads/main') => sdlc(repo, ['check', '--at', 'push'], { input: `${ref} ${local} ${ref} ${remote}\n` })
const head = () => gitIn(repo, 'rev-parse', 'HEAD')

test('push judges the commits the remote lacks, including a direct push to trunk', () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-'))
  gitIn(remote, 'init', '-q', '--bare', '-b', 'main')
  gitIn(repo, 'remote', 'add', 'origin', remote)
  gitIn(repo, 'push', '-q', 'origin', 'main')
  const remoteSha = head()
  stage('src/a.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad', '--no-verify')
  const r = push(head(), remoteSha)
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /secrets/)
  gitIn(repo, 'reset', '-q', '--hard', remoteSha)
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'ok')
  assert.equal(push(head(), remoteSha).code, 0)
})

test('push skips deletes, tags and a new branch with no base, and says so', () => {
  assert.match(push(ZERO, head()).stdout, /nothing to judge/)
  assert.match(push(head(), ZERO, 'refs/tags/v1').stdout, /nothing to judge/)
  stage('src/a.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad')
  const r = push(head(), ZERO, 'refs/heads/feat')
  assert.equal(r.code, 0)
  assert.match(r.stdout, /no base/)
})

test('a new branch is judged against the merge-base with the default branch', () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-'))
  gitIn(remote, 'init', '-q', '--bare', '-b', 'main')
  gitIn(repo, 'remote', 'add', 'origin', remote)
  gitIn(repo, 'push', '-q', 'origin', 'main')
  gitIn(repo, 'checkout', '-q', '-b', 'feat')
  stage('src/a.js', SECRET)
  gitIn(repo, 'commit', '-qm', 'bad')
  const r = push(head(), ZERO, 'refs/heads/feat')
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /secrets/)
})

test('an unplanned tier M ad-hoc change is refused at push; prePush off skips; a second push reuses the change', () => {
  const base = head()
  for (const n of ['a', 'b', 'c', 'd']) stage(`src/${n}.js`, `export const ${n} = 1\n`)
  gitIn(repo, 'commit', '-qm', 'four files')
  const r = push(head(), base)
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /adhoc/)
  assert.equal(fs.readdirSync(path.join(repo, '.sdlc/changes')).filter(s => s.startsWith('adhoc-')).length, 1)
  push(head(), base)
  assert.equal(fs.readdirSync(path.join(repo, '.sdlc/changes')).filter(s => s.startsWith('adhoc-')).length, 1, 'reused, not recreated')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ githooks: { prePush: 'off' } }))
  const off = push(head(), base)
  assert.equal(off.code, 0)
  assert.match(off.stdout, /off/)
})

const LINT = `node -e "for (const f of require('fs').readdirSync('.')) if (f.startsWith('bad')) console.log(f)"`

test('push blocks a quality regression against the base and a dropped test count; no quality declared is skipped', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ quality: { lint: { cmd: LINT, count: 'lines' } } }))
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'config')
  const base = head()
  stage('bad1.js', 'export const x = 1\n')
  gitIn(repo, 'commit', '-qm', 'adds a lint finding')
  const r = push(head(), base)
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stdout, /quality\.lint/)
  gitIn(repo, 'reset', '-q', '--hard', base)
  write(repo, '.sdlc/sensors.json', '{}')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'no quality')
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'clean')
  assert.equal(push(head(), base).code, 0)
})

test('an overrun push budget warns and lets the push through', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ full: { slow: 'node -e "setTimeout(()=>{},3000)"' }, githooks: { budgetMs: 500 } }))
  const base = head()
  stage('src/a.js', 'export const a = 1\n')
  gitIn(repo, 'commit', '-qm', 'x')
  const r = push(head(), base)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /budget|timed out/)
})
```

- [ ] **Step 3: Run to verify failure**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="push" scripts/githooks.spec.ts`
Expected: FAIL (`check --at push` is rejected by `cmdCheck`'s usage check).

- [ ] **Step 4: Move `createAdhoc` to `graph.ts` and add `rangeDiff`, `runQuality(baseRef)`**

`scripts/graph.ts` (add `createChange`, `now`, `CHANGES`, `exists` to its core import if missing; `Tier` is already exported from `core.ts`):

```ts
// Work done without /rig:start is recorded as an ad-hoc chore so the ship gate and CI still triage it.
export function createAdhoc(tier: Tier): string {
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12)
  let slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}`
  for (let n = 2; exists(path.join(CHANGES, slug)); n++) slug = `adhoc-${stamp.slice(0, 8)}-${stamp.slice(8)}-${n}`
  createChange(slug, 'chore', tier, 'Ad-hoc change made without /rig:start')
  return slug
}
```

`scripts/hooks.ts`: delete the local `createAdhoc` (`:355-362`), import `createAdhoc` from `./graph.ts`, and call it as `createAdhoc(tierFromDiff(diffs, config))` at `:396`.

`scripts/diffs.ts`:

```ts
// The commits a push would send: `head` against what the remote already has, never the working tree.
export const rangeDiff = (base: string, head = 'HEAD'): FileDiff[] => parseUnifiedDiff(git([...DIFF, base, head]) ?? '')
```

`scripts/quality.ts`: change the signature and its first lines:

```ts
export function runQuality(slug: string, baseRef: string | null = defaultBase()): { categories: CategoryResult[]; blocks: Finding[] } {
  const { config, rules } = loadConfig()
  const base = baseRef
```

- [ ] **Step 5: Implement the push check in `scripts/githooks.ts`**

Add imports: `fs`, and from other modules `loadConfig, runChecks` (`./check.ts`), `rangeDiff, showAt` (`./diffs.ts`), `activeSlug, createAdhoc, listChanges` (`./graph.ts`), `runQuality` (`./quality.ts`), `tierFromDiff, isProtected` (`./sensors.ts`), `defaultBase` (`./core.ts`), `formatFindings, isSource, type Finding` (`./model.ts`).

```ts
const ZERO = /^0+$/
export type PushRef = { localRef: string; localSha: string; remoteRef: string; remoteSha: string }

// git feeds pre-push one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
export function parsePushRefs(stdin: string): PushRef[] {
  return stdin.split('\n').filter(l => l.trim()).map(l => {
    const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = l.trim().split(/\s+/)
    return { localRef, localSha, remoteRef, remoteSha }
  })
}

const readStdin = (): string => { try { return fs.readFileSync(0, 'utf8') } catch { return '' } }
// Running out of budget is a warning at push: CI still runs the commands.
const soften = (f: Finding): Finding => (f.sensor === 'commands' && /budget ran out|timed out/.test(f.message) ? { ...f, severity: 'warn' } : f)

export function cmdCheckPush(_args: Args): void {
  const { config, rules, errors } = loadConfig()
  if (config.githooks.prePush === 'off') return out('sdlc check push: off (githooks.prePush)')
  const raw = readStdin()
  const refs = raw.trim()
    ? parsePushRefs(raw).filter(r => !ZERO.test(r.localSha) && r.localRef.startsWith('refs/heads/'))
    : [{ localRef: 'refs/heads/HEAD', localSha: git(['rev-parse', 'HEAD']) ?? '', remoteRef: '', remoteSha: '0' }]
  if (!refs.length) return out('sdlc check push: nothing to judge (a delete or tag push)')
  const t0 = Date.now()
  const findings: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: '.sdlc/sensors.json', message: e, fix: 'fix the file' }))
  const notes: string[] = []
  for (const r of refs) {
    const base = ZERO.test(r.remoteSha) ? defaultBase() : r.remoteSha
    if (!base || git(['cat-file', '-e', `${base}^{commit}`]) === null) { notes.push(`${r.localRef.replace('refs/heads/', '')}: no base to compare against, so CI judges it`); continue }
    const diffs = rangeDiff(base, r.localSha)
    if (!diffs.length) continue
    const active = activeSlug()
    const touched = diffs.some(d => isSource(d.file, config) && !isProtected(d.file))
    const slug = active ?? (touched ? createAdhoc(tierFromDiff(diffs, config)) : null)
    // A rig-managed change in flight is gated by /rig:pr; only ad-hoc work gets ship verdicts here.
    const shipSlugs = slug?.startsWith('adhoc-') ? [slug] : []
    const result = runChecks({
      point: 'ship', diffs, config, rules, slugs: shipSlugs, commands: 'full', budgetMs: config.githooks.budgetMs,
      before: f => showAt(base, f) ?? '', after: f => showAt(r.localSha, f) ?? '', base, ratchet: false,
    })
    findings.push(...result.findings.map(soften))
    if (slug && Object.values(config.quality).some(Boolean)) {
      if (Date.now() - t0 > config.githooks.budgetMs) notes.push('quality ratchet skipped: the push budget is used up')
      else findings.push(...runQuality(slug, base).blocks.filter(b => b.sensor.startsWith('quality.') || b.sensor === 'invariant'))
    }
  }
  if (!Object.values(config.quality).some(Boolean)) notes.push('quality ratchet skipped: no quality commands declared in .sdlc/sensors.json')
  const blocks = findings.filter(f => f.severity === 'block')
  out([formatFindings(findings) || 'sdlc check push: pass', ...notes].join('\n'))
  process.exitCode = blocks.length ? 1 : 0
}
```

`scripts/sdlc.ts`: import `cmdCheckPush` with `cmdHooks`, and change the `check` entry:

```ts
  check: args => (args.opt.at === 'push' ? cmdCheckPush(args) : cmdCheck(args)),
```

- [ ] **Step 6: Run to verify pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/githooks.spec.ts scripts/quality.spec.ts scripts/gate.spec.ts scripts/check.spec.ts && npm run typecheck`
Expected: PASS. The "unplanned tier M" test depends on `tierFromDiff` (4 source files = M) and on `shipVerdicts` raising the `adhoc` finding (`check.ts:251`); if the finding text differs, adjust the regex to the real sensor name `adhoc`, not the test's intent.

- [ ] **Step 7: Commit**

```bash
git add scripts docs/superpowers/specs/2026-10-06-everywhere-enforcement-design.md
git commit -m "feat(check): --at push judges what the remote lacks, with ship verdicts and the quality ratchet

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Warnings the agent can see

**Files:**
- Modify: `scripts/hooks.ts` (`Gate`/`GateSummary` types at `:322-323`, `summarize` at `:349`, `hookStop` pass branch at `:407-412`, `hookPromptSubmit` at `:365`)
- Test: `scripts/githooks.spec.ts`

**Interfaces:**
- Produces: `GateSummary` gains `warnRows?: string[]; shown?: boolean`.

- [ ] **Step 1: Write the failing test** (append)

```ts
test('a Stop that passes with a warning tells the person, and the next prompt tells the agent once', () => {
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { fileLines: 5 } }))
  hook(repo, 'prompt-submit', { session_id: 's' })
  write(repo, 'src/big.js', Array.from({ length: 20 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n')
  const stop = hook(repo, 'stop', { session_id: 's' })
  assert.match(JSON.parse(stop.stdout).systemMessage, /1 warning.*size.*big\.js/)
  const next = JSON.parse(hook(repo, 'prompt-submit', { session_id: 's' }).stdout)
  assert.equal(next.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(next.hookSpecificOutput.additionalContext, /big\.js/)
  assert.equal(hook(repo, 'prompt-submit', { session_id: 's' }).stdout, '', 'shown once, not again')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="passes with a warning" scripts/githooks.spec.ts`
Expected: FAIL (`stop.stdout` is empty, `JSON.parse('')` throws).

- [ ] **Step 3: Implement**

In `scripts/hooks.ts`:

```ts
export type GateSummary = { at: string; blocks: number; warns: number; bySensor: Record<string, number>; warnRows?: string[]; shown?: boolean }
```

```ts
const warnRow = (f: Finding): string => `${f.sensor}${f.file ? ` ${f.file}` : ''}: ${f.message} → ${f.fix}`.slice(0, 200)

function summarize(findings: Finding[]): GateSummary {
  const bySensor: Record<string, number> = {}
  for (const f of findings) bySensor[f.sensor] = (bySensor[f.sensor] ?? 0) + 1
  const warns = findings.filter(f => f.severity === 'warn')
  return { at: now(), blocks: findings.filter(f => f.severity === 'block').length, warns: warns.length, bySensor, warnRows: warns.slice(0, 5).map(warnRow) }
}
```

In `hookStop`, replace the pass branch's tail:

```ts
  if (!blocks.length) {
    gate.passed[key] = hash
    save()
    if (!sub && exists(UNRESOLVED)) fs.rmSync(UNRESOLVED)
    const warns = gate.last?.warnRows ?? []
    if (!sub && warns.length) out(JSON.stringify({ systemMessage: `sdlc: ${gate.last?.warns} warning(s), not blocking: ${warns.join(' | ')}` }))
    return
  }
```

Replace `hookPromptSubmit`:

```ts
// Each prompt starts a turn: record the tree and reset the per-turn gate, so Stop diffs exactly this turn's changes.
// Warnings the last turn left are handed to the agent once, here, because a passing Stop cannot show them to it.
function hookPromptSubmit(): void {
  if (!exists(SDLC)) return
  const last = readGate().last
  const carry = last && !last.shown && last.warns > 0 && last.warnRows?.length ? last.warnRows : null
  const snap = snapshot()
  if (snap) writeBaseline(snap)
  updateGate(g => {
    Object.assign(g, { turn: snap?.at ?? now(), blocks: {}, passed: {}, tool: [], agents: {} })
    if (carry && g.last) g.last.shown = true
  })
  if (carry) {
    out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `sdlc: the last turn left ${carry.length} warning(s) that did not block. Fix them if they are yours:\n${carry.map(r => `- ${r}`).join('\n')}` } }))
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/githooks.spec.ts scripts/gate.spec.ts scripts/reliability.spec.ts && npm run typecheck`
Expected: PASS. (`reliability.spec.ts` covers the gate's locking; the new fields must not break it.)

- [ ] **Step 5: Commit**

```bash
git add scripts/hooks.ts scripts/githooks.spec.ts
git commit -m "feat(hooks): carry non-blocking warnings to the agent and tell the person at Stop

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The model cannot bypass the hooks

**Files:**
- Modify: `scripts/hooks.ts` (`hookPreBash` at `:217`)
- Test: `scripts/githooks.spec.ts`

**Interfaces:**
- Produces: `pre-bash` denies, for the model only, hook bypasses.

- [ ] **Step 1: Write the failing test** (append)

```ts
const bash = (command: string) => {
  const r = hook(repo, 'pre-bash', { tool_input: { command } })
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined
}

test('the model may not bypass the git hooks; ordinary commits and pushes are untouched', () => {
  sdlc(repo, ['init'])
  for (const cmd of [
    'git commit --no-verify -m x', 'git commit -nm x', 'git commit -m x --no-verif', 'git push --no-verify origin main',
    'git config core.hooksPath /dev/null', 'git -c core.hooksPath=/x commit -m y',
  ]) assert.equal(bash(cmd), 'deny', cmd)
  for (const cmd of ['git commit -m "fix the -n flag"', 'git commit -am x', 'git push origin main', 'git status']) assert.notEqual(bash(cmd), 'deny', cmd)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="may not bypass" scripts/githooks.spec.ts`
Expected: FAIL (`undefined !== 'deny'` for `git commit --no-verify -m x`).

- [ ] **Step 3: Implement** (in `scripts/hooks.ts`, beside the other command patterns, and a check at the top of `hookPreBash` after the evidence check)

```ts
// The person may bypass the git hooks (`git commit --no-verify`); the model fixes the findings instead.
const NO_VERIFY = /\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*(?:--no-v\w*|\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$))|\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*--no-v\w*|\bgit\b[^;&|\n]*core\.hookspath/i
export const bypassesGitHooks = (cmd: string): boolean => NO_VERIFY.test(cmd.replace(/"[^"]*"|'[^']*'/g, '""'))
```

In `hookPreBash`, after the evidence `if (...) { return decide('deny', …) }` block:

```ts
  if (bypassesGitHooks(cmd)) {
    return decide('deny', 'The rig git hooks run the quality checks at commit and push. Only the person bypasses them (git commit --no-verify); fix the findings instead. See their state with `sdlc.ts hooks status`.')
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --disable-warning=ExperimentalWarning --test scripts/githooks.spec.ts scripts/gate.spec.ts scripts/shell.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/hooks.ts scripts/githooks.spec.ts
git commit -m "feat(hooks): deny the model's git-hook bypasses (--no-verify, core.hooksPath)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Session-start install, init skill, docs and the line cap

**Files:**
- Modify: `scripts/githooks.ts` (`sessionNote`), `scripts/hooks.ts` (`hookSessionStart` at `:61-82`), `skills/init/SKILL.md` (step 3), `README.md`, `DESIGN.md`, `CHANGELOG.md`, `scripts/size.spec.ts:39-41`
- Test: `scripts/githooks.spec.ts`

**Interfaces:**
- Consumes: `hooksState`, `installHooks`, `HOOKS_DIR` from Task 3.
- Produces: `sessionNote(): string`.

- [ ] **Step 1: Write the failing test** (append)

```ts
test('session-start installs the git hooks when they are committed but not wired, and stays quiet once they are', () => {
  sdlc(repo, ['vendor'])
  sdlc(repo, ['hooks', 'install'])
  gitIn(repo, 'config', '--local', '--unset', 'core.hooksPath')
  const first = JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.match(first, /Git hooks: installed/)
  assert.equal(gitIn(repo, 'config', '--local', 'core.hooksPath'), '.sdlc/githooks')
  const again = JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.doesNotMatch(again, /Git hooks/)
  gitIn(repo, 'config', '--local', 'core.hooksPath', '.husky')
  assert.match(JSON.parse(hook(repo, 'session-start', { source: 'startup' }).stdout).hookSpecificOutput.additionalContext, /Git hooks: core\.hooksPath is \.husky/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="session-start installs" scripts/githooks.spec.ts`
Expected: FAIL (no `Git hooks:` line in the context).

- [ ] **Step 3: Implement**

`scripts/githooks.ts`:

```ts
// Session start wires committed hooks in a fresh clone (core.hooksPath is local git config, so a clone never has it).
export function sessionNote(): string {
  if (!exists(path.join(SDLC, 'bin', 'sdlc.ts')) || !exists(path.join(ROOT, HOOKS_DIR))) return ''
  const { state, path: current } = hooksState()
  if (state === 'installed') return ''
  if (state === 'other') return `Git hooks: core.hooksPath is ${current}, so the rig commit and push checks are not wired; \`sdlc.ts hooks install --force\` replaces it.`
  const r = installHooks()
  return r.ok ? `Git hooks: installed the rig pre-commit and pre-push checks (core.hooksPath = ${HOOKS_DIR}).` : `Git hooks: ${r.message}`
}
```

`scripts/hooks.ts`: import `sessionNote` from `./githooks.ts` and add `sessionNote(),` to the `context` array in `hookSessionStart` (after the `wikiMissing` line; the existing `.filter(Boolean)` drops an empty note).

- [ ] **Step 4: Docs, init skill, cap**

`skills/init/SKILL.md` step 3, append one sentence after the vendor command: "Then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts hooks install` so commits and pushes made outside Claude Code are checked too; say that a teammate who never opens Claude Code runs `node .sdlc/bin/sdlc.ts hooks install` once."

`README.md`:
- In **What fires when**, add two rows: `| You commit | git pre-commit | The staged diff goes through the Stop sensors and the fast commands; warnings print, blocks refuse the commit (rebase and merge are skipped). |` and `| You push | git pre-push | What the remote lacks goes through the ship checks and the quality ratchet against the base; \`githooks.prePush: "off"\` disables it. |`.
- In **Install**, after step 2: "Run `node .sdlc/bin/sdlc.ts hooks install` (or let the first Claude Code session do it) to wire the git hooks; they cover editors and other agents. `--no-verify` still works for a person; CI is the floor."
- In **Guides and sensors → Config**, add `githooks` (`{ prePush: "ship" | "off", budgetMs }`) to the key list, and add `hooks` to the script command list.

`CHANGELOG.md` under `## Unreleased`:

```
- Git hooks: `sdlc.ts hooks install` wires `pre-commit` (the staged diff through the Stop sensors and the fast commands) and `pre-push` (what the remote lacks through the ship checks and the quality ratchet), so edits made outside a Claude turn are judged too. A fresh clone is wired at session start. A hook that cannot run warns and lets git continue; `--no-verify` stays a person's option and the model is denied it, along with `core.hooksPath`. New config `githooks: { prePush, budgetMs }`.
- Stop now tells the person about non-blocking warnings, and the next prompt hands them to the agent once (a 90-line file over a 60-line limit used to pass in silence).
```

`DESIGN.md`: append a section `## 16. Enforcement everywhere (spec 5)` in the style of §14 and §15 (read their last 15 lines first): the problem (the 2026-10-06 spike: what Stop already caught with no active change, and gaps 1 to 5 from the spec's §1 table), the decision (git as the common layer; same checker; fail-soft hooks; model denied bypass), a "Deviations from the spec" list (push diffs the remote sha from stdin; ship verdicts only for `adhoc-*`; commit-time `harness-tamper` only warns because the commit point follows Stop semantics, and push blocks it), and "Open items" (the fast commands at commit see the working tree, not the index; `--no-verify` leaves CI as the only judge).

`scripts/size.spec.ts`: run `node --disable-warning=ExperimentalWarning --test scripts/size.spec.ts`; if it fails, read the reported `harness is N lines` and set both `6100` occurrences in the test to `N` rounded up to the next 50.

- [ ] **Step 5: Run the whole suite**

Run: `npm run typecheck && node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`
Expected: all PASS.

- [ ] **Step 6: Re-run the spike against the new code** (the acceptance check from the spec's §6.8)

```bash
SP=$(mktemp -d) && cd "$SP" && git init -q -b main && git config user.email t@t && git config user.name t
cp -R /Users/chamindawijayasundara/Documents/learning_101/claude_code_harness_lite_v2/tests/trials/todo-core/. . && rm -rf .claude
mkdir -p .sdlc && echo '{"fast":{"test":"npm test --silent"},"limits":{"fileLines":60}}' > .sdlc/sensors.json
git add -A && git commit -qm base
node --disable-warning=ExperimentalWarning /Users/chamindawijayasundara/Documents/learning_101/claude_code_harness_lite_v2/scripts/sdlc.ts vendor
node .sdlc/bin/sdlc.ts hooks install
echo 'const apikey = "abcdefghijklmnop12345678"' > src/x.js && git add src/x.js && git commit -m bad; echo "exit $?"
```

Expected: `exit 1`, a `[secrets]` block printed by the hook, and no new commit (`git log --oneline` still shows only `base`). Then `git commit --no-verify -m bad` succeeds (a person's bypass), proving CI is the remaining floor.

- [ ] **Step 7: Commit**

```bash
git add scripts skills README.md DESIGN.md CHANGELOG.md
git commit -m "feat(hooks): session-start wiring, init guidance, docs and the raised line cap

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §2 decisions (git layer: Tasks 2-3; same checker: Tasks 2 and 4; install: Task 3; fail-soft: Task 3 script and test; bypass: Task 6; warnings: Task 5). §4.1 `check --at commit`: Task 2. §4.2 push and quality: Task 4 (with the two refinements recorded in the spec). §4.3 install, session-start, vendor, init: Tasks 3 and 7. §4.4 warning visibility: Task 5. §4.5 protection: Tasks 1 and 6. §6 tests 1 to 10: 1-2 (Task 2), 3 (Task 3), 4 (Task 3), 5 (Task 7), 6 (Task 5), 7 (Task 6), 8 (Task 7 Step 6 plus Task 2's tamper/secret cases), 9 and 10 (Task 4). Review Focus 1-5: Task 2 (1 to 3), Task 4 (4), Task 3 (5).

**Placeholder scan:** none. Every code step has code; the two prose-only items (DESIGN.md section, README rows) give the exact content to add.

**Type consistency:** `hooksState`/`installHooks`/`HOOKS_DIR` defined in Task 3 and used unchanged in Task 7; `createAdhoc(tier)` defined in Task 4 and used in `hooks.ts` and `githooks.ts`; `runQuality(slug, baseRef)` default keeps `pr.ts` and `cmdQuality` callers unchanged; `Point` extension touches only `check.ts`; `GateSummary.warnRows/shown` defined and used in Task 5 only.

**Known limits stated in the plan:** commit-time fast commands run against the working tree; `harness-tamper` at commit only warns (push blocks); config at push is the working tree's, not the base's (CI uses the base's).
