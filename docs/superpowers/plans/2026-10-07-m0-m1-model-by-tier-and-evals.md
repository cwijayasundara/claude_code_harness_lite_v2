# M0 Model by Tier and M1 Manual Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every subagent a change launches runs on the model its tier calls for (S Haiku 5.5, M Sonnet 5.5, L and greenfield Opus 5.5), and a person can regression-test the agent configuration with `sdlc.ts evals` before merging it.

**Architecture:** `sdlc.ts next --json` gains one derived field, `model`, computed from the change's effective tier in `graph.ts`; skills pass it on every Agent launch (the per-call `model` beats an agent file's `model:`), and the CI review reads the tier the same way. Evals are a new leaf script, `scripts/evals.ts`: each `.sdlc/evals/<id>.json` is a prompt plus deterministic checks, run with `claude -p --output-format stream-json --verbose` in a throwaway worktree (code at the eval's `base`, agent configuration from HEAD), scored from exit codes and files, appended to `.sdlc/evals/results.jsonl`. No workflow runs evals; a person does.

**Tech Stack:** Node 22.18+ running TypeScript directly (no build step, no dependencies), `node:test`, POSIX `sh`, GitHub Actions YAML, Claude Code CLI.

**Spec:** `docs/ai-sdlc-harness-design.html` (§2 model routing, §5.4 evals, §9 size, §10 M0 and M1, §11 decisions). Revised 2026-10-07: model by tier uses the Agent call's `model` parameter, not nine agent files.

## Global Constraints

- The harness line cap in `scripts/size.spec.ts` is **7,600** (raised from 6,900 in Task 1). Every script ≤ 500 lines, mod file ≤ 300, skill and guide ≤ 60.
- Model IDs, verbatim: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`. Agent `model` aliases: `haiku`, `sonnet`, `opus`.
- Tier → model: S → `haiku`, M → `sonnet`, L → `opus`; type `greenfield` → `opus` at any tier. The tier is the **effective** tier (`graph.ts` `effective()`, the stricter of intent.md and ratchet.json).
- Evals are **manual**: no workflow, no schedule, no PR trigger. `evals.minPass` is advisory; nothing in rig blocks on it.
- Eval definitions live in `.sdlc/evals/<id>.json`; results in `.sdlc/evals/results.jsonl` (written only by sdlc; denied to Edit and Write).
- Scripts: zero dependencies, plain Node, imports from sibling `./*.ts` files only.
- **No dogfooding** (standing rule for this repo): never run `sdlc.ts new`, `init`, `evals` or any rig check against this repository itself. Verify with `npm run typecheck`, `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts` and `claude plugin validate .claude-plugin/plugin.json`. Tests create their own temp repos.
- Commit messages: one line, `type: summary`, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Call sites: model before and after (confirm on review)

| Site | Today | After this plan |
|---|---|---|
| `design`, `plan`, `spec` skills: tier L architect | `rig:architect` (agent file: Opus) | same, `model` from `next --json` (= `opus`) |
| `design`, `plan`: tier S and M drafts | main thread writes them | **unchanged (d)**: main thread (session model, Sonnet by template). A subagent for a 15-line plan costs more than it saves |
| `build`: tier S implementation | main thread, inline | **(a)** one `rig:implementer` with `model: haiku` |
| `build`: tier M ≤ 3 slices and ≤ 8 files | main thread, inline | unchanged: main thread (Sonnet = tier M's model) |
| `build`: other implementation | `rig:implementer` (agent file: Sonnet) | `model` from `next --json` (M `sonnet`, L `opus`) |
| `build`: tier L slice review | `rig:reviewer` with `model: sonnet` | **(c)** `model` from `next --json` (= `opus`) |
| `test`, `sensors`, `pr`, `pr-review`: fix runs | `rig:implementer` (Sonnet) | `model` from `next --json` |
| `pr-review`: tier S and M review | built-in `code-review` at `medium` (no model choice) | **(b)** one `rig:reviewer` with `model` from `next --json` (S `haiku`, M `sonnet`) |
| `pr-review`: tier L review | `code-review` at `high` or `rig:reviewer` shards (Opus) | unchanged |
| `rig-review.yml` (CI) | `--model claude-opus-5-5` | S `claude-haiku-5-5`, M `claude-sonnet-5-5`, else Opus |
| `scout` agent file | `model: haiku` (alias, unpinned) | `model: claude-haiku-5-5` |
| general subagents (`CLAUDE_CODE_SUBAGENT_MODEL`) | `claude-sonnet-5-5` | `claude-haiku-5-5` |

(a), (b), (c) follow the plain reading of decision 4 ("the tier picks the model"); (c) raises the cost of every tier L slice review. (d) keeps inline drafting. Change any of them before execution by editing Task 4.

## Review Focus

- A person or the model lowers `tier:` in `intent.md` on an L change: `next --json` must still say `opus` (the recorded tier is a floor). Pinned in Task 2.
- A PR touches two change folders, none, or carries an unreadable `ratchet.json`: the CI review must use Opus, never a cheaper model. Pinned in Task 5.
- An eval's file check names `../x` or `/etc/passwd`: the check fails as "outside the repository" and nothing outside the worktree is read. Pinned in Task 7.
- `claude` is missing or times out on several evals: those count as errors, and past `evals.maxErrors` the run is `unmeasured` (exit 1), never `pass`. Pinned in Task 7.
- The person edits CLAUDE.md and runs evals before committing: the run must say plainly that uncommitted configuration is not evaluated. Pinned in Task 7.

---

### Task 1: Branch and raise the line cap

**Files:**
- Modify: `scripts/size.spec.ts:40-42`

**Interfaces:**
- Consumes: nothing.
- Produces: headroom of 700 lines for every later task.

- [ ] **Step 1: Create the branch from main**

```bash
git checkout main
git checkout -b feat/m0-m1-model-by-tier-and-evals
```

- [ ] **Step 2: Raise the cap**

In `scripts/size.spec.ts`, replace:

```ts
test('the harness is at most 6900 lines (tests and docs excluded)', () => {
```
with
```ts
test('the harness is at most 7600 lines (tests and docs excluded)', () => {
```
and replace
```ts
  assert.ok(total <= 6900, `harness is ${total} lines`)
```
with
```ts
  assert.ok(total <= 7600, `harness is ${total} lines`)
```

- [ ] **Step 3: Run the size test**

Run: `node --disable-warning=ExperimentalWarning --test scripts/size.spec.ts`
Expected: PASS (total is 6900 today).

- [ ] **Step 4: Commit**

```bash
git add scripts/size.spec.ts
git commit -m "chore: raise the harness line cap to 7600 for model routing and evals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `next --json` names the model for the change's tier

**Files:**
- Modify: `scripts/graph.ts` (the `Step` type near line 145, `step()` near line 152)
- Test: `scripts/graph.spec.ts` (append)

**Interfaces:**
- Consumes: `loadChange(slug).type` (`ChangeType`) and `.tier` (`Tier`), already the effective values.
- Produces: `export type ModelAlias = 'haiku' | 'sonnet' | 'opus'`, `export const modelFor(type: ChangeType, tier: Tier): ModelAlias`, and `Step.model: ModelAlias`. Every `next <slug> --json` output now carries `"model"`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/graph.spec.ts` (it already imports `fs`, `path`, `makeRepo`, `sdlc`, `write`, and defines `stepOf` at line 70):

```ts
test('next --json names the model for the tier: S haiku, M sonnet, L opus, greenfield opus at any tier', () => {
  const cases: [string, string, string, string][] = [['s1', 'feature', 'S', 'haiku'], ['m1', 'refactor', 'M', 'sonnet'], ['l1', 'bugfix', 'L', 'opus'], ['g1', 'greenfield', 'S', 'opus']]
  for (const [slug, type, tier, model] of cases) {
    sdlc(repo, ['new', slug, '--type', type, '--tier', tier])
    assert.equal(stepOf(slug).model, model, `${type} ${tier}`)
  }
})

test('the model follows the effective tier: lowering tier in intent.md does not lower the model', () => {
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  const f = path.join(repo, '.sdlc/changes/big/intent.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^tier: L$/m, 'tier: S'))
  assert.equal(stepOf('big').model, 'opus')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="model" scripts/graph.spec.ts`
Expected: FAIL, `undefined !== 'haiku'`.

- [ ] **Step 3: Implement**

In `scripts/graph.ts`, directly above `export type Verdict = ...`, add:

```ts
// The tier picks the model for every subagent a change launches (architect, implementer, reviewer); greenfield is always Opus.
// Skills pass it as the Agent call's `model`, which takes precedence over the agent file's own.
export type ModelAlias = 'haiku' | 'sonnet' | 'opus'
export const modelFor = (type: ChangeType, tier: Tier): ModelAlias => (type === 'greenfield' || tier === 'L' ? 'opus' : tier === 'M' ? 'sonnet' : 'haiku')
```

Change the `Step` type to:

```ts
export type Step = { slug: string; node: Stage | null; verdict: Verdict; reason: string; command: string; round: number; progress: number; model: ModelAlias }
```

In `step()`, change the `base` line to:

```ts
  const base = { slug, node, round, progress, command: nextCommand(change), model: modelFor(change.type, change.tier) }
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `node --disable-warning=ExperimentalWarning --test scripts/graph.spec.ts && npm run typecheck`
Expected: PASS, no type errors. (`ChangeType` and `Tier` are already imported in `graph.ts`; if the typecheck says otherwise, add them to the existing `./core.ts` import.)

- [ ] **Step 5: Commit**

```bash
git add scripts/graph.ts scripts/graph.spec.ts
git commit -m "feat: next --json names the model for the change's effective tier" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Pin the model aliases and put search and general subagents on Haiku 5.5

**Files:**
- Modify: `templates/settings.json` (`env` block)
- Modify: `agents/scout.md:4`
- Test: `scripts/models.spec.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: projects onboarded or re-vendored get `haiku`/`sonnet`/`opus` resolving to the 5.5 IDs, so the `model` from Task 2 means what the plan says.

- [ ] **Step 1: Write the failing test**

Create `scripts/models.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/models.spec.ts`
Expected: FAIL, `undefined !== 'claude-haiku-5-5'`.

- [ ] **Step 3: Implement**

In `templates/settings.json`, replace the `env` block:

```json
  "env": {
    "CLAUDE_CODE_DISABLE_ADVISOR_TOOL": "true",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5-5"
  }
```
with
```json
  "env": {
    "CLAUDE_CODE_DISABLE_ADVISOR_TOOL": "true",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-haiku-5-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5"
  }
```

In the same file, update the `$comment` sentence that says subagents are Sonnet, if any: search the file for `Sonnet subagents` and, if present, replace it with `Haiku 5.5 general subagents; the tier picks the model for rig's own agents`.

In `agents/scout.md`, replace the line `model: haiku` with `model: claude-haiku-5-5`.

- [ ] **Step 4: Run the test and the suite that reads the template**

Run: `node --disable-warning=ExperimentalWarning --test scripts/models.spec.ts scripts/vendor.spec.ts scripts/preflight.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/settings.json agents/scout.md scripts/models.spec.ts
git commit -m "feat: pin model aliases to 5.5; scout and general subagents on Haiku 5.5" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Skills pass the tier's model on every architect, implementer and reviewer launch

**Files:**
- Modify: `skills/build/SKILL.md`, `skills/design/SKILL.md`, `skills/plan/SKILL.md`, `skills/spec/SKILL.md`, `skills/test/SKILL.md`, `skills/sensors/SKILL.md`, `skills/pr/SKILL.md`, `skills/pr-review/SKILL.md`, `skills/start/SKILL.md`
- Modify: `scripts/review.spec.ts:11-18` (the tier L Sonnet assertion)
- Test: `scripts/models.spec.ts` (append)

**Interfaces:**
- Consumes: `model` in `next <slug> --json` (Task 2).
- Produces: one sentence, identical in every skill that names `rig:architect`, `rig:implementer` or `rig:reviewer`:

```
**Models:** pass `model` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` on every `rig:architect`, `rig:implementer` and `rig:reviewer` launch.
```

- [ ] **Step 1: Write the failing tests**

Append to `scripts/models.spec.ts`:

```ts
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
  const review = read('skills/pr-review/SKILL.md')
  assert.match(review, /Tier S and M: one `rig:reviewer`/)
  assert.doesNotMatch(review, /Tier S and M: one `code-review`/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/models.spec.ts`
Expected: FAIL, `build lacks the Models line`.

- [ ] **Step 3: Insert the Models line**

In each of these eight skills — `build`, `design`, `plan`, `spec`, `test`, `sensors`, `pr`, `pr-review` — find the line

```
Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.
```

and insert directly after it a blank line followed by:

```
**Models:** pass `model` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` on every `rig:architect`, `rig:implementer` and `rig:reviewer` launch.
```

- [ ] **Step 4: Route tier S implementation and the tier L slice review**

In `skills/build/SKILL.md`, replace:

```
   1. **Implement.** Tier S, and tier M with ≤ 3 slices and ≤ 8 files: do it yourself, test first:
```
with
```
   1. **Implement.** Tier M with ≤ 3 slices and ≤ 8 files: do it yourself, test first:
```

and in the same sentence replace `Otherwise launch one \`rig:implementer\` with a brief` with `Otherwise (tier S included, which runs on Haiku) launch one \`rig:implementer\` with a brief`.

Replace:

```
      Tier L: launch `rig:reviewer` with `mode: slice` and `model: sonnet`, the change folder, the slice number and the diff range for that slice.
```
with
```
      Tier L: launch `rig:reviewer` with `mode: slice`, the change folder, the slice number and the diff range for that slice.
```

In `skills/start/SKILL.md`, replace the sentence `Tier S builds inline with no subagents.` with `Tier S builds through one Haiku \`rig:implementer\` (the build skill passes the model).`

- [ ] **Step 5: Route the tier S and M review**

In `skills/pr-review/SKILL.md`, replace:

```
Tier S and M: one `code-review` at `medium` on the branch diff, applying `REVIEW.md`.
```
with
```
Tier S and M: one `rig:reviewer` on the branch diff, applying `REVIEW.md` (the built-in `code-review` cannot take a model).
```

and replace `(one \`rig:implementer\` run for tier L)` with `(one \`rig:implementer\` run)`.

- [ ] **Step 6: Update the existing review spec**

In `scripts/review.spec.ts`, replace the test

```ts
test('build: tier S and M verify a slice with --checks and no model review; tier L reviews on Sonnet', () => {
```
through its closing `})` with:

```ts
test('build: tier S and M verify a slice with --checks and no model review; tier L reviews with the tier model', () => {
  assert.match(build, /ratchet record \$0 build --slice N --checks/)
  const tierSM = build.split('\n').find(l => /Tier S and M/.test(l) && /--checks/.test(l)) ?? ''
  assert.ok(tierSM, 'a Tier S and M line names --checks')
  assert.doesNotMatch(tierSM, /rig:reviewer|code-review/)
  const tierL = build.split('\n').find(l => /Tier L/.test(l) && /rig:reviewer/.test(l)) ?? ''
  assert.ok(tierL, 'a Tier L line launches rig:reviewer')
  assert.doesNotMatch(tierL, /model: /, 'the model comes from next --json, not the line')
})
```

- [ ] **Step 7: Run the skill tests, size and vendor**

Run: `node --disable-warning=ExperimentalWarning --test scripts/models.spec.ts scripts/review.spec.ts scripts/size.spec.ts scripts/vendor.spec.ts`
Expected: PASS (each skill stays under 60 lines; `wc -l skills/*/SKILL.md` to confirm).

- [ ] **Step 8: Commit**

```bash
git add skills scripts/models.spec.ts scripts/review.spec.ts
git commit -m "feat: skills pass the tier's model to architect, implementer and reviewer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The CI review picks its model by tier and fails closed to Opus

**Files:**
- Modify: `templates/rig-review.yml` (new step before `anthropics/claude-code-action`, and the `--model` argument)
- Test: `scripts/models.spec.ts` (append)

**Interfaces:**
- Consumes: `.sdlc/changes/<slug>/ratchet.json` `tier` and `type` on the PR head.
- Produces: step output `steps.model.outputs.model`, one of the three full IDs.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/models.spec.ts` (add `import { execFileSync } from 'node:child_process'` and `import { makeRepo, gitIn, write } from './testkit.ts'` at the top, and `import os from 'node:os'`):

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="CI review" scripts/models.spec.ts`
Expected: FAIL, `the workflow carries the model-by-tier markers`.

- [ ] **Step 3: Implement**

In `templates/rig-review.yml`, insert this step immediately before `      - uses: anthropics/claude-code-action@...`:

```yaml
      - name: Pick the review model by tier
        id: model
        env:
          BASE: ${{ github.base_ref }}
        run: |
          # model-by-tier:start
          # S Haiku, M Sonnet, L or greenfield Opus. ratchet.json comes from the PR head, which the PR controls, so any doubt
          # is Opus; rig-check's tier sensor still re-tiers a diff that reaches auth, payments, data or contracts to L.
          model=claude-opus-5-5
          slugs=$(git diff --name-only "origin/$BASE...HEAD" -- .sdlc/changes | cut -d/ -f3 | sort -u)
          if [ -n "$slugs" ] && [ "$(printf '%s\n' "$slugs" | wc -l | tr -d ' ')" = 1 ]; then
            tier=$(node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(r.type === "greenfield" ? "L" : String(r.tier || "L")) } catch { process.stdout.write("L") }' ".sdlc/changes/$slugs/ratchet.json")
            case "$tier" in S) model=claude-haiku-5-5 ;; M) model=claude-sonnet-5-5 ;; esac
          fi
          echo "model=$model" >> "$GITHUB_OUTPUT"
          # model-by-tier:end
```

In the same file, replace `--model claude-opus-5-5 --max-turns 30` with `--model ${{ steps.model.outputs.model }} --max-turns 30`.

Also update the header comment: add the line `# The review model follows the change's tier (S Haiku 5.5, M Sonnet 5.5, L Opus 5.5) and is Opus whenever the tier is in doubt.`

- [ ] **Step 4: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --test scripts/models.spec.ts scripts/size.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/rig-review.yml scripts/models.spec.ts
git commit -m "feat: the CI review picks its model by tier and falls back to Opus" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `evals` settings in sensors.json

**Files:**
- Modify: `scripts/model.ts` (`SensorConfig` type near line 52, `DEFAULT_CONFIG` near line 79)
- Modify: `scripts/configparse.ts` (`parseV6`, before `if ('scopes' in value)`)
- Test: `scripts/model.spec.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `SensorConfig.evals: { minPass: number; maxErrors: number; maxTurns: number; timeoutMs: number }`, default `{ minPass: 0.9, maxErrors: 2, maxTurns: 30, timeoutMs: 600_000 }`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/model.spec.ts`:

```ts
test('evals settings: defaults, overrides and precise errors', () => {
  assert.deepEqual(DEFAULT_CONFIG.evals, { minPass: 0.9, maxErrors: 2, maxTurns: 30, timeoutMs: 600_000 })
  const ok = parseConfig(JSON.stringify({ evals: { minPass: 0.8, maxErrors: 0, maxTurns: 10, timeoutMs: 60000 } }))
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.config.evals, { minPass: 0.8, maxErrors: 0, maxTurns: 10, timeoutMs: 60000 })
  const errs = (evals: unknown): string => parseConfig(JSON.stringify({ evals })).errors.join()
  assert.match(errs({ minPass: 1.5 }), /evals\.minPass must be a number from 0 to 1/)
  assert.match(errs({ maxTurns: 0 }), /evals\.maxTurns must be a positive integer/)
  assert.match(errs({ maxErrors: -1 }), /evals\.maxErrors must be a whole number/)
  assert.match(errs({ bogus: 1 }), /evals: unknown key "bogus"/)
  assert.match(errs('yes'), /evals must be \{ minPass, maxErrors, maxTurns, timeoutMs \}/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="evals settings" scripts/model.spec.ts`
Expected: FAIL, `undefined` vs the default object.

- [ ] **Step 3: Implement**

In `scripts/model.ts`, add to the `SensorConfig` type (after `idleGapMs: number`):

```ts
  evals: { minPass: number; maxErrors: number; maxTurns: number; timeoutMs: number }
```

and to `DEFAULT_CONFIG` (after `idleGapMs: 900_000,`):

```ts
  evals: { minPass: 0.9, maxErrors: 2, maxTurns: 30, timeoutMs: 600_000 },
```

In `scripts/configparse.ts`, inside `parseV6`, insert before `if ('scopes' in value) parseScopes(...)`:

```ts
  if ('evals' in value) {
    if (!isObject(value.evals)) errors.push('evals must be { minPass, maxErrors, maxTurns, timeoutMs }')
    else for (const [k, v] of Object.entries(value.evals)) {
      if (k === 'minPass') { if (typeof v === 'number' && v >= 0 && v <= 1) config.evals.minPass = v; else errors.push('evals.minPass must be a number from 0 to 1') }
      else if (k === 'maxErrors') { if (Number.isInteger(v) && (v as number) >= 0) config.evals.maxErrors = v as number; else errors.push('evals.maxErrors must be a whole number') }
      else if (k === 'maxTurns' || k === 'timeoutMs') { if (posInt(v)) config.evals[k] = v; else errors.push(`evals.${k} must be a positive integer`) }
      else errors.push(`evals: unknown key "${k}"`)
    }
  }
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `node --disable-warning=ExperimentalWarning --test scripts/model.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/model.ts scripts/configparse.ts scripts/model.spec.ts
git commit -m "feat: evals settings in sensors.json (minPass, maxErrors, maxTurns, timeoutMs)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `sdlc.ts evals` runs and scores the evals

**Files:**
- Create: `scripts/evals.ts`
- Modify: `scripts/sdlc.ts` (import, `COMMANDS` table)
- Modify: `scripts/vendor.ts:8` (`VENDORED` list)
- Modify: `templates/settings.json` (`deny` list)
- Test: `scripts/evals.spec.ts` (create)

**Interfaces:**
- Consumes: `config.evals` (Task 6); `withBaseTree(base, fn, { prefix })` from `basetree.ts`; `runCommand(cmd, { cwd, timeoutMs })` from `runs.ts`; `gitIn`, `git`, `readJsonl`, `read`, `exists`, `now`, `out`, `fail`, `optString`, `SDLC` from `core.ts`; `loadConfig` from `check.ts`.
- Produces (Task 8 and 9 rely on these):
  - `export const EVALS: string` (`.sdlc/evals`), `export const RESULTS: string` (`.sdlc/evals/results.jsonl`)
  - `export type Check`, `export type Eval = { id; prompt; checks; allowedTools?; base?; files?; source? }`
  - `export type EvalResult = { at: string; run: string; id: string; pass: boolean; error?: string; checks: { kind: string; ok: boolean; detail: string }[]; ms: number }`
  - `export type Summary = { run: string; passed: number; total: number; errors: number; rate: number; verdict: 'pass' | 'fail' | 'unmeasured' }`
  - `export function parseEval(text: string, id: string): Eval | string`
  - `export function skillsLoaded(stream: string): string[]`
  - `export function summarize(rows: EvalResult[], cfg: { minPass: number; maxErrors: number }): Summary | null`
  - `export const lastRun: () => Summary | null`
  - `export function cmdEvals(args: Args): void`
  - The binary is `process.env.RIG_CLAUDE || 'claude'` (tests point it at a stub; nothing else should set it).

- [ ] **Step 1: Write the failing tests**

Create `scripts/evals.spec.ts`:

```ts
// Manual evals: a prompt plus deterministic checks, run with claude -p in a throwaway worktree. A stub stands in for claude.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { parseEval, skillsLoaded, summarize, type EvalResult } from './evals.ts'

const STUB = `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n')
if (process.env.STUB_WRITE) fs.writeFileSync(process.env.STUB_WRITE, 'done by stub\\n')
if (process.env.STUB_SKILL) console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: process.env.STUB_SKILL } }] } }))
console.log(JSON.stringify({ type: 'result', is_error: false }))
process.exit(Number(process.env.STUB_EXIT || 0))
`
let repo: string
let stub: string
let log: string
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', '{}\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'sdlc')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-stub-'))
  stub = path.join(dir, 'claude')
  fs.writeFileSync(stub, STUB, { mode: 0o755 })
  log = path.join(dir, 'log.jsonl')
})
const evals = (args: string[], env: Record<string, string> = {}) => sdlc(repo, ['evals', ...args], { env: { RIG_CLAUDE: stub, STUB_LOG: log, ...env } })
const defineEval = (id: string, body: object) => write(repo, `.sdlc/evals/${id}.json`, JSON.stringify(body))
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { cwd: string; args: string[] })
const results = () => fs.readFileSync(path.join(repo, '.sdlc/evals/results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as EvalResult)

test('parseEval accepts a full definition and rejects what it cannot trust', () => {
  const e = parseEval(JSON.stringify({ prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }, { kind: 'skill-loaded', name: 'build' }], base: 'abc', files: ['t.js'], source: 'change:x' }), 'one')
  assert.deepEqual(e, { id: 'one', prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }, { kind: 'skill-loaded', name: 'build' }], base: 'abc', files: ['t.js'], source: 'change:x' })
  assert.match(parseEval('{', 'x') as string, /not valid JSON/)
  assert.match(parseEval(JSON.stringify({ prompt: 'p', checks: [] }), 'x') as string, /at least one check/)
  assert.match(parseEval(JSON.stringify({ prompt: 'p', checks: [{ kind: 'vibes' }] }), 'x') as string, /unknown or incomplete check/)
})

test('skillsLoaded reads Skill tool calls from stream-json and ignores everything else', () => {
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Skill', input: { skill: 'rig-build' } }] } }),
    'not json',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('\n')
  assert.deepEqual(skillsLoaded(stream), ['rig-build'])
})

test('summarize: pass at minPass, fail below it, unmeasured past maxErrors', () => {
  const row = (pass: boolean, error?: string): EvalResult => ({ at: 't', run: 'r', id: 'x', pass, ...(error ? { error } : {}), checks: [], ms: 0 })
  const cfg = { minPass: 0.5, maxErrors: 1 }
  assert.equal(summarize([row(true), row(false)], cfg)?.verdict, 'pass')
  assert.equal(summarize([row(true), row(false), row(false)], cfg)?.verdict, 'fail')
  assert.equal(summarize([row(true), row(false, 'e'), row(false, 'e')], cfg)?.verdict, 'unmeasured')
  assert.equal(summarize([], cfg), null)
})

test('a passing eval runs claude in a throwaway worktree with stream-json and records the result', () => {
  defineEval('writes', { prompt: 'write out.txt', checks: [{ kind: 'file-contains', path: 'out.txt', text: 'done by stub' }, { kind: 'skill-loaded', name: 'build' }] })
  const r = evals([], { STUB_WRITE: 'out.txt', STUB_SKILL: 'rig-build' })
  assert.equal(r.code, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /^pass writes$/m)
  assert.match(r.stdout, /evals: 1\/1 pass \(1\.00\), 0 error\(s\), minPass 0\.9 → pass/)
  const [call] = calls()
  assert.notEqual(fs.realpathSync(call?.cwd ?? ''), fs.realpathSync(repo), 'claude ran in a worktree, not the repo')
  assert.deepEqual(call?.args.slice(0, 7), ['-p', 'write out.txt', '--output-format', 'stream-json', '--verbose', '--max-turns', '30'])
  assert.equal(fs.existsSync(path.join(repo, 'out.txt')), false, 'the repo itself is untouched')
  assert.equal(results()[0]?.pass, true)
})

test('a failing check fails the eval and the run exits 1 with the check that failed', () => {
  defineEval('nothing', { prompt: 'p', checks: [{ kind: 'command', cmd: 'test -f missing.txt' }] })
  const r = evals([])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^FAIL nothing: test -f missing\.txt → exit 1$/m)
  assert.match(r.stdout, /→ fail$/m)
})

test('a file check outside the worktree fails and reads nothing', () => {
  defineEval('escape', { prompt: 'p', checks: [{ kind: 'file-contains', path: '../../etc/passwd', text: 'root' }, { kind: 'file-absent', path: '/etc/hosts' }] })
  const r = evals([])
  assert.match(r.stdout, /\.\.\/\.\.\/etc\/passwd is outside the repository/)
  assert.match(r.stdout, /\/etc\/hosts is outside the repository/)
})

test('a missing claude is an error; past maxErrors the run is unmeasured, never pass', () => {
  for (const id of ['a', 'b', 'c']) defineEval(id, { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  const r = evals([], { RIG_CLAUDE: path.join(os.tmpdir(), 'no-such-claude') })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /FAIL a: .*not found/)
  assert.match(r.stdout, /3 error\(s\), minPass 0\.9 → unmeasured/)
})

test('a malformed definition is reported and the others still run', () => {
  write(repo, '.sdlc/evals/broken.json', '{')
  defineEval('fine', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  const r = evals([])
  assert.match(r.stdout, /^FAIL broken: broken: not valid JSON$/m)
  assert.match(r.stdout, /^pass fine$/m)
})

test('uncommitted configuration is not evaluated, and the run says so', () => {
  defineEval('fine', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  write(repo, 'CLAUDE.md', '# edited, not committed\n')
  assert.match(evals([]).stdout, /^warn: uncommitted changes to CLAUDE\.md.*commit first$/m)
})

test('code comes from the eval base; configuration and the eval files come from HEAD', () => {
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  write(repo, 'tests/t.test.js', 'test\n')
  write(repo, 'CLAUDE.md', 'newrule\n')
  write(repo, 'src/later.js', 'later\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'later')
  defineEval('overlay', { prompt: 'p', base, files: ['tests/t.test.js'], checks: [{ kind: 'command', cmd: 'test -f tests/t.test.js && grep -q newrule CLAUDE.md && test ! -f src/later.js' }] })
  const r = evals([])
  assert.match(r.stdout, /^pass overlay$/m, r.stdout)
})

test('--only runs one eval; an unknown id fails with its name', () => {
  defineEval('a', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  defineEval('b', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  assert.match(evals(['--only', 'b']).stdout, /evals: 1\/1 pass/)
  assert.match(evals(['--only', 'zz']).stderr, /no eval zz in \.sdlc\/evals/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/evals.spec.ts`
Expected: FAIL, `Cannot find module './evals.ts'`.

- [ ] **Step 3: Implement `scripts/evals.ts`**

```ts
// Evals: the agent's configuration (CLAUDE.md, .claude/**, guides, rules) regression-tested by a person before it merges.
// Each .sdlc/evals/<id>.json is a prompt plus deterministic checks, run with `claude -p` in a throwaway worktree: the code at
// the eval's `base` (default HEAD), the configuration and the eval's own `files` from HEAD. Verdicts come from exit codes and
// files, never from what the model says it did. Nothing in rig blocks on the result: a person reads it.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { SDLC, exists, read, now, out, fail, git, gitIn, optString, readJsonl, type Args } from './core.ts'
import { loadConfig } from './check.ts'
import { runCommand } from './runs.ts'
import { withBaseTree } from './basetree.ts'

export const EVALS = path.join(SDLC, 'evals')
export const RESULTS = path.join(EVALS, 'results.jsonl')
export const CONFIG_PATHS = ['CLAUDE.md', '.claude', '.sdlc/guides', '.sdlc/rules.json', '.sdlc/sensors.json']

export type Check = { kind: 'command'; cmd: string } | { kind: 'file-contains'; path: string; text: string } | { kind: 'file-absent'; path: string } | { kind: 'skill-loaded'; name: string }
export type Eval = { id: string; prompt: string; checks: Check[]; allowedTools?: string; base?: string; files?: string[]; source?: string }
type CheckResult = { kind: string; ok: boolean; detail: string }
export type EvalResult = { at: string; run: string; id: string; pass: boolean; error?: string; checks: CheckResult[]; ms: number }
export type Summary = { run: string; passed: number; total: number; errors: number; rate: number; verdict: 'pass' | 'fail' | 'unmeasured' }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

// A definition the runner cannot trust is an error for that file, never a silent skip.
export function parseEval(text: string, id: string): Eval | string {
  let v: unknown
  try { v = JSON.parse(text) } catch { return `${id}: not valid JSON` }
  if (!isObj(v) || !str(v.prompt) || !Array.isArray(v.checks) || v.checks.length === 0) return `${id}: needs a prompt and at least one check`
  const checks: Check[] = []
  for (const c of v.checks) {
    if (isObj(c) && c.kind === 'command' && str(c.cmd)) checks.push({ kind: 'command', cmd: c.cmd })
    else if (isObj(c) && c.kind === 'file-contains' && str(c.path) && str(c.text)) checks.push({ kind: 'file-contains', path: c.path, text: c.text })
    else if (isObj(c) && c.kind === 'file-absent' && str(c.path)) checks.push({ kind: 'file-absent', path: c.path })
    else if (isObj(c) && c.kind === 'skill-loaded' && str(c.name)) checks.push({ kind: 'skill-loaded', name: c.name })
    else return `${id}: unknown or incomplete check ${JSON.stringify(c).slice(0, 80)}`
  }
  const files = Array.isArray(v.files) ? v.files.filter(str) : []
  return { id, prompt: v.prompt, checks, ...(str(v.allowedTools) ? { allowedTools: v.allowedTools } : {}), ...(str(v.base) ? { base: v.base } : {}), ...(files.length ? { files } : {}), ...(str(v.source) ? { source: v.source } : {}) }
}

// The skills the session invoked: with --output-format stream-json, assistant messages carry the tool_use blocks.
export function skillsLoaded(stream: string): string[] {
  const names: string[] = []
  for (const line of stream.split('\n')) {
    let ev: unknown
    try { ev = JSON.parse(line) } catch { continue }
    const content = isObj(ev) && ev.type === 'assistant' && isObj(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : []
    for (const b of content) if (isObj(b) && b.type === 'tool_use' && b.name === 'Skill' && isObj(b.input) && str(b.input.skill)) names.push(b.input.skill)
  }
  return names
}

// A relative path that stays inside the worktree, else null: a check never reads outside the code under test.
const inside = (dir: string, rel: string): string | null => {
  const p = path.resolve(dir, rel)
  return !path.isAbsolute(rel) && p.startsWith(dir + path.sep) ? p : null
}

function scoreChecks(checks: Check[], dir: string, stream: string, timeoutMs: number): CheckResult[] {
  const skills = skillsLoaded(stream)
  return checks.map(c => {
    if (c.kind === 'command') {
      const r = runCommand(c.cmd, { cwd: dir, timeoutMs })
      return { kind: c.kind, ok: r.exit === 0, detail: `${c.cmd} → exit ${r.exit}` }
    }
    if (c.kind === 'skill-loaded') {
      const ok = skills.some(s => s === c.name || s.endsWith(`:${c.name}`) || s === `rig-${c.name}`)
      return { kind: c.kind, ok, detail: ok ? c.name : `skill ${c.name} not loaded (loaded: ${skills.join(', ') || 'none'})` }
    }
    const p = inside(dir, c.path)
    if (!p) return { kind: c.kind, ok: false, detail: `${c.path} is outside the repository` }
    if (c.kind === 'file-absent') return { kind: c.kind, ok: !fs.existsSync(p), detail: `${c.path} ${fs.existsSync(p) ? 'exists' : 'absent'}` }
    const ok = fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(c.text)
    return { kind: c.kind, ok, detail: `${c.path} ${ok ? 'contains' : 'lacks'} the text` }
  })
}

// The code under test is the eval's base; the agent configuration and the eval's own files come from HEAD.
function overlay(dir: string, head: string, files: string[]): void {
  for (const p of [...CONFIG_PATHS, ...files]) if (gitIn(dir, ['cat-file', '-e', `${head}:${p}`]) !== null) gitIn(dir, ['checkout', head, '--', p])
}

function runEval(e: Eval, run: string, cfg: { maxTurns: number; timeoutMs: number }, model?: string): EvalResult {
  const started = Date.now()
  const head = git(['rev-parse', 'HEAD']) ?? 'HEAD'
  const done = (pass: boolean, checks: CheckResult[], error?: string): EvalResult => ({ at: now(), run, id: e.id, pass, ...(error ? { error } : {}), checks, ms: Date.now() - started })
  const bin = process.env.RIG_CLAUDE || 'claude'
  const r = withBaseTree(e.base ?? head, dir => {
    overlay(dir, head, e.files ?? [])
    const args = ['-p', e.prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(cfg.maxTurns), ...(e.allowedTools ? ['--allowedTools', e.allowedTools] : []), ...(model ? ['--model', model] : [])]
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const c = spawnSync(bin, args, { cwd: dir, env, encoding: 'utf8', timeout: cfg.timeoutMs, maxBuffer: 256 * 1024 * 1024 })
    const code = (c.error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return done(false, [], `${bin} not found: install Claude Code`)
    if (c.error) return done(false, [], `${bin} did not finish: ${code === 'ETIMEDOUT' ? `timed out after ${cfg.timeoutMs} ms` : c.error.message}`)
    if (c.status !== 0) return done(false, [], `${bin} exited ${c.status}: ${(c.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`)
    const checks = scoreChecks(e.checks, dir, c.stdout ?? '', cfg.timeoutMs)
    return done(checks.every(x => x.ok), checks)
  }, { prefix: 'rig-eval-' })
  return r.ok ? r.value : done(false, [], r.error)
}

export function summarize(rows: EvalResult[], cfg: { minPass: number; maxErrors: number }): Summary | null {
  const run = rows.at(-1)?.run
  if (!run) return null
  const last = rows.filter(r => r.run === run)
  const passed = last.filter(r => r.pass).length
  const errors = last.filter(r => r.error).length
  const rate = passed / last.length
  return { run, passed, total: last.length, errors, rate, verdict: errors > cfg.maxErrors ? 'unmeasured' : rate >= cfg.minPass ? 'pass' : 'fail' }
}

export const lastRun = (): Summary | null => summarize(readJsonl<EvalResult>(RESULTS), loadConfig().config.evals)

export function cmdEvals(args: Args): void {
  if (!exists(SDLC)) fail('sdlc not initialised here')
  const cfg = loadConfig().config.evals
  const only = optString(args, 'only')
  const files = exists(EVALS) ? fs.readdirSync(EVALS).filter(f => f.endsWith('.json') && (!only || f === `${only}.json`)).sort() : []
  if (!files.length) fail(only ? `no eval ${only} in .sdlc/evals` : 'no evals in .sdlc/evals: run `sdlc.ts evals --seed` or write one')
  if (git(['status', '--porcelain', '--', ...CONFIG_PATHS])) out('warn: uncommitted changes to CLAUDE.md, .claude, guides, rules or sensors are not evaluated: evals use the configuration at HEAD; commit first')
  const run = now()
  const model = optString(args, 'model')
  const rows: EvalResult[] = files.map(f => {
    const id = f.slice(0, -'.json'.length)
    const e = parseEval(read(path.join(EVALS, f)), id)
    return typeof e === 'string' ? { at: now(), run, id, pass: false, error: e, checks: [], ms: 0 } : runEval(e, run, cfg, model)
  })
  fs.appendFileSync(RESULTS, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const s = summarize(rows, cfg) as Summary
  const why = (r: EvalResult): string => r.error ?? r.checks.filter(c => !c.ok).map(c => c.detail).join('; ')
  out([...rows.map(r => (r.pass ? `pass ${r.id}` : `FAIL ${r.id}: ${why(r)}`)), `evals: ${s.passed}/${s.total} pass (${s.rate.toFixed(2)}), ${s.errors} error(s), minPass ${cfg.minPass} → ${s.verdict}`].join('\n'))
  if (s.verdict !== 'pass') process.exitCode = 1
}
```

- [ ] **Step 4: Wire the command, vendoring and the deny rule**

In `scripts/sdlc.ts`, add to the imports `import { cmdEvals } from './evals.ts'` and to `COMMANDS` the entry `evals: cmdEvals,` (after `metrics: cmdMetrics,`).

In `scripts/vendor.ts`, add `'evals'` to the `VENDORED` array after `'metrics'`.

In `templates/settings.json`, add to `permissions.deny` after `"Edit(/.sdlc/PREFLIGHT.md)",`:

```json
      "Edit(/.sdlc/evals/results.jsonl)",
```

- [ ] **Step 5: Run the tests, typecheck and the suites that read the CLI and vendor list**

Run: `node --disable-warning=ExperimentalWarning --test scripts/evals.spec.ts scripts/vendor.spec.ts scripts/sdlc.spec.ts scripts/size.spec.ts && npm run typecheck`
Expected: PASS. If `vendor.spec.ts` asserts the exact `VENDORED` list or file count, update that assertion to include `evals`.

- [ ] **Step 6: Commit**

```bash
git add scripts/evals.ts scripts/evals.spec.ts scripts/sdlc.ts scripts/vendor.ts templates/settings.json
git commit -m "feat: sdlc.ts evals runs agent-configuration evals in a throwaway worktree" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `sdlc.ts evals --seed` drafts evals from shipped changes

**Files:**
- Modify: `scripts/evals.ts` (add `seed`, call it from `cmdEvals`)
- Test: `scripts/evals.spec.ts` (append)

**Interfaces:**
- Consumes: `listChanges()`, `isShipped(slug)`, `planVerification(slug)`, `frontmatter`, `CHANGES` from `core.ts`; `matchesAny(file, globs)` from `model.ts`; `config.tests`.
- Produces: `.sdlc/evals/change-<slug>.json` drafts `{ prompt, base, files, checks: [{ kind: 'command', cmd }], source: 'change:<slug>' }`; never overwrites an existing file.

- [ ] **Step 1: Write the failing test**

Append to `scripts/evals.spec.ts`:

```ts
test('--seed drafts one eval per shipped change from its intent, base, tests and verification, and never overwrites', () => {
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  write(repo, '.sdlc/changes/demo/intent.md', '---\nslug: demo\ntype: feature\ntier: S\n---\n# demo\n\n## Problem\nAdd a greeting.\n')
  write(repo, '.sdlc/changes/demo/plan.md', '## Files\n- src/hi.js\n## Verification\n- `node --test tests/hi.test.js`\n')
  write(repo, 'tests/hi.test.js', 'test\n')
  write(repo, 'src/hi.js', 'hi\n')
  write(repo, '.sdlc/changes/demo/ship.json', JSON.stringify({ base }))
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'ship demo')
  const r = evals(['--seed'])
  assert.match(r.stdout, /seeded 1 eval/)
  const draft = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/evals/change-demo.json'), 'utf8'))
  assert.equal(draft.base, base)
  assert.deepEqual(draft.files, ['tests/hi.test.js'])
  assert.deepEqual(draft.checks, [{ kind: 'command', cmd: 'node --test tests/hi.test.js' }])
  assert.equal(draft.source, 'change:demo')
  assert.match(draft.prompt, /Add a greeting/)
  write(repo, '.sdlc/evals/change-demo.json', '{"kept":true}')
  assert.match(evals(['--seed']).stdout, /nothing to seed/)
  assert.equal(fs.readFileSync(path.join(repo, '.sdlc/evals/change-demo.json'), 'utf8'), '{"kept":true}')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="seed" scripts/evals.spec.ts`
Expected: FAIL (`--seed` falls through to "no evals in .sdlc/evals").

- [ ] **Step 3: Implement**

In `scripts/evals.ts`, extend the `./core.ts` import with `CHANGES, frontmatter, listChanges, isShipped, planVerification`, and add `import { matchesAny } from './model.ts'`. Add above `cmdEvals`:

```ts
// Drafts evals from shipped changes: the task as its intent stated it, run from the commit before it, checked by the plan's
// verification commands with the change's own tests taken from HEAD. A person curates every draft before relying on it.
function seed(limit: number): void {
  const tests = loadConfig().config.tests
  let n = 0
  for (const slug of listChanges().filter(isShipped)) {
    if (n >= limit) break
    const file = path.join(EVALS, `change-${slug}.json`)
    let ship: { base?: unknown } = {}
    try { ship = JSON.parse(read(path.join(CHANGES, slug, 'ship.json'))) as { base?: unknown } } catch { continue }
    const cmds = planVerification(slug)
    if (exists(file) || !str(ship.base) || !cmds.length) continue
    const shipCommit = git(['log', '-1', '--format=%H', '--', `.sdlc/changes/${slug}/ship.json`]) ?? 'HEAD'
    const files = (git(['diff', '--name-only', ship.base, shipCommit]) ?? '').split('\n').filter(f => f && matchesAny(f, tests))
    const { body } = frontmatter(read(path.join(CHANGES, slug, 'intent.md')))
    const draft = { prompt: `Make this change in this repository, then run its verification.\n\n${body.trim()}`, base: ship.base, files, checks: cmds.map(cmd => ({ kind: 'command', cmd })), source: `change:${slug}` }
    fs.mkdirSync(EVALS, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(draft, null, 2) + '\n')
    n++
  }
  out(n ? `seeded ${n} eval(s) in .sdlc/evals: read each prompt and check before relying on it` : 'nothing to seed: every shipped change with a base and plan verification already has an eval')
}
```

In `cmdEvals`, directly after the `if (!exists(SDLC)) fail(...)` line, add:

```ts
  if (args.opt.seed) return seed(Number(optString(args, 'limit')) || 20)
```

- [ ] **Step 4: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --test scripts/evals.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/evals.ts scripts/evals.spec.ts
git commit -m "feat: evals --seed drafts evals from shipped changes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `status` shows the last eval run; `metrics` reports eval pass rate and incident-to-eval time

**Files:**
- Modify: `scripts/sdlc.ts` (`cmdStatus` text output, the `out([...rows, ...])` call near line 159)
- Modify: `scripts/metrics.ts` (the Maintain block near line 125)
- Test: `scripts/evals.spec.ts` (append)

**Interfaces:**
- Consumes: `lastRun()`, `EVALS`, `RESULTS`, `EvalResult` from `evals.ts`; `firstCommitTime(rel)`, `share`, `median`, `hours` already in `metrics.ts`.
- Produces: a status line `evals: <passed>/<total> pass (<rate>) → <verdict>, last run <yyyy-mm-dd>`; metrics keys `eval_pass_rate` and `incident_to_eval_hours`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/evals.spec.ts`:

```ts
test('status shows the last eval run', () => {
  sdlc(repo, ['new', 'demo', '--type', 'chore', '--tier', 'S'])
  defineEval('fine', { prompt: 'p', checks: [{ kind: 'command', cmd: 'true' }] })
  evals([])
  assert.match(sdlc(repo, ['status']).stdout, /^evals: 1\/1 pass \(1\.00\) → pass, last run \d{4}-\d{2}-\d{2}$/m)
})

test('metrics: eval pass rate from the last run, incident-to-eval hours from git', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e']) defineEval(id, { prompt: 'p', checks: [{ kind: 'command', cmd: id === 'e' ? 'false' : 'true' }] })
  evals([])
  const m = JSON.parse(sdlc(repo, ['metrics', '--json']).stdout).metrics
  assert.deepEqual({ value: m.eval_pass_rate.value, n: m.eval_pass_rate.n }, { value: 0.8, n: 5 })
  assert.equal(m.incident_to_eval_hours.value, null, 'unmeasured below five incidents with an eval')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="status shows|metrics: eval" scripts/evals.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the status line**

In `scripts/sdlc.ts`, add `lastRun` to the `./evals.ts` import (`import { cmdEvals, lastRun } from './evals.ts'`). In `cmdStatus`, just before the final text `out([...rows, '', \`flow: ...` call, add:

```ts
  const ev = lastRun()
  const evalLine = ev ? `evals: ${ev.passed}/${ev.total} pass (${ev.rate.toFixed(2)}) → ${ev.verdict}, last run ${ev.run.slice(0, 10)}` : ''
```

and insert `evalLine,` into that array directly after the `` `stale: ...` `` element (the trailing `.filter(Boolean)` already drops it when empty).

- [ ] **Step 4: Implement the metrics**

In `scripts/metrics.ts`, add `import { EVALS, RESULTS, type EvalResult } from './evals.ts'`. Change the incidents read so each keeps its file name:

```ts
  const incidents = exists(incidentDir)
    ? fs.readdirSync(incidentDir).filter(f => f.endsWith('.md')).map(f => ({ file: f, ...frontmatter(read(path.join(incidentDir, f))).data }))
    : []
```

After the `m.repeat_incident_share = ...` line, add:

```ts
  // Test: the last manual eval run, and how long an incident takes to become a permanent eval (its `source` names the incident).
  const evalRows = readJsonl<EvalResult>(RESULTS)
  const lastEvalRun = evalRows.filter(r => r.run === evalRows.at(-1)?.run)
  m.eval_pass_rate = share(lastEvalRun.filter(r => r.pass).length, lastEvalRun.length)
  const evalSources = exists(EVALS) ? fs.readdirSync(EVALS).filter(f => f.endsWith('.json')).map(f => ({ rel: toPosix(path.relative(ROOT, path.join(EVALS, f))), source: String((JSON.parse(read(path.join(EVALS, f)) || '{}') as { source?: unknown }).source ?? '') })) : []
  // An incident with no eval yet has no time: never pass '' to firstCommitTime, which would date the whole repo.
  m.incident_to_eval_hours = median(incidents.map(i => {
    const ev = evalSources.find(e => e.source === `incident:${i.file}`)
    return ev ? hours(i.detected, firstCommitTime(ev.rel)) : null
  }))
```

If a definition is malformed, `JSON.parse` throws: wrap the `evalSources` `.map` callback body in `try { ... } catch { return { rel: '', source: '' } }` (an empty `source` never matches an incident).

- [ ] **Step 5: Run the tests and the existing metrics tests**

Run: `node --disable-warning=ExperimentalWarning --test scripts/evals.spec.ts scripts/sdlc.spec.ts scripts/scorecard.spec.ts && npm run typecheck`
Expected: PASS. If an existing test asserts the exact set of metric keys, add `eval_pass_rate` and `incident_to_eval_hours` to it.

- [ ] **Step 6: Commit**

```bash
git add scripts/sdlc.ts scripts/metrics.ts scripts/evals.spec.ts
git commit -m "feat: status shows the last eval run; metrics report eval pass rate and incident-to-eval time" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Point people at evals where configuration changes, and turn incidents into evals

**Files:**
- Modify: `scripts/sensors.ts:337` (the harness-tamper warn `fix`)
- Modify: `skills/diagnose/SKILL.md` (one step for incident changes)
- Test: `scripts/evals.spec.ts` (append)

**Interfaces:**
- Consumes: `harnessTamper(diffs, { point, before, after })` and `type FileDiff` from `sensors.ts`/`model.ts`.
- Produces: the warn finding's `fix` text mentions `sdlc.ts evals`; diagnose writes `.sdlc/evals/incident-<yyyymmdd>-<class>.json` for incident changes.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/evals.spec.ts` (add `import { harnessTamper } from './sensors.ts'` and `import type { FileDiff } from './model.ts'` at the top; if `FileDiff` is not exported from `model.ts`, import it from where `sensors.ts` imports it):

```ts
test('a harness change outside the weakening rules asks for an eval run', () => {
  const [f] = harnessTamper([{ file: 'CLAUDE.md', status: 'M' } as FileDiff], { point: 'ship', before: () => '', after: () => '' })
  assert.equal(f?.severity, 'warn')
  assert.match(f?.fix ?? '', /sdlc\.ts evals/)
})

test('diagnose turns an incident fix into an eval named for its class', () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'skills/diagnose/SKILL.md'), 'utf8')
  assert.match(text, /\.sdlc\/evals\/incident-<yyyymmdd>-<class>\.json/)
  assert.match(text, /"source": "incident:<incident file>"/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="harness change|diagnose turns" scripts/evals.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `scripts/sensors.ts` line 337, replace `fix: 'needs human review'` with:

```ts
fix: 'needs human review; if it changes how the agent works (CLAUDE.md, .claude/**, guides, rules), commit it on the branch, run `sdlc.ts evals` and attach the result'
```

In `skills/diagnose/SKILL.md`, after the step that commits the failing regression test, add one step (renumber the following steps):

```
N. **Incident changes only** (`type: incident` in intent.md): write `.sdlc/evals/incident-<yyyymmdd>-<class>.json` with the Write tool: `{"prompt": "<the incident's symptoms, one paragraph>", "base": "<git rev-parse HEAD before the fix>", "files": ["<the regression test file>"], "checks": [{"kind": "command", "cmd": "<the regression test command>"}], "source": "incident:<incident file>"}`. It keeps the incident in the eval suite after it ships.
```

Confirm `wc -l skills/diagnose/SKILL.md` stays at or under 60.

- [ ] **Step 4: Run the tests and the sensors suites**

Run: `node --disable-warning=ExperimentalWarning --test scripts/evals.spec.ts scripts/sensors.spec.ts scripts/check.spec.ts scripts/size.spec.ts`
Expected: PASS. If a sensors test asserts the exact old `fix` text `needs human review` for a harness-tamper warn (not the waiver-row message at `check.spec.ts:559` and `:717`, which is a different finding), update it to match the new text.

- [ ] **Step 5: Commit**

```bash
git add scripts/sensors.ts skills/diagnose/SKILL.md scripts/evals.spec.ts
git commit -m "feat: harness changes point at sdlc.ts evals; incident fixes become evals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation and the full verification pass

**Files:**
- Modify: `README.md` (model table in "What is in the box", the script command list, the command atlas)
- Modify: `DESIGN.md` (§2 principle 7, §7 Measurement)
- Modify: `CHANGELOG.md` (`## Unreleased`)

**Interfaces:**
- Consumes: everything above.
- Produces: docs that match the code.

- [ ] **Step 1: README**

- In "What is in the box", change the `agents/scout.md` row to `Haiku 5.5`, and add one sentence under the table: `Each change's tier picks the model for every architect, implementer and reviewer launch: S Haiku 5.5, M Sonnet 5.5, L and greenfield Opus 5.5 (sdlc.ts next --json carries it as "model"). The settings template pins the haiku, sonnet and opus aliases to those IDs.`
- In "The script underneath", add `evals` to the command list.
- In "Improve the harness itself", add the row: `` | `node .sdlc/bin/sdlc.ts evals` | Before merging a change to CLAUDE.md, a skill, a hook, the guides or rules: runs `.sdlc/evals/*.json` with `claude -p` in a throwaway worktree and prints a pass rate against `evals.minPass` (advisory). `--seed` drafts evals from shipped changes; `--only <id>` runs one. | ``

- [ ] **Step 2: DESIGN.md**

- §2, principle 7: replace `Sonnet main thread and implementer, Opus architect and reviewer, Haiku scout.` with `Sonnet main thread; the tier picks the subagents' model (S Haiku 5.5, M Sonnet 5.5, L and greenfield Opus 5.5), passed per Agent call from next --json; Haiku scout.`
- §7: append `Evals (sdlc.ts evals) are run by a person, never by CI: eval_pass_rate is the last run's pass share, and incident_to_eval_hours is how long an incident takes to become an eval.`

- [ ] **Step 3: CHANGELOG**

Under `## Unreleased`, add at the top:

```
- **The tier picks the model.** `next --json` carries `model` (S `haiku`, M `sonnet`, L and greenfield `opus`, from the effective tier, so lowering `tier:` in intent.md never lowers it). Every skill passes it on architect, implementer and reviewer launches; tier S now builds through one Haiku implementer and tier S and M review through `rig:reviewer` instead of the built-in `code-review`; the tier L slice review moves from Sonnet to Opus. `rig-review.yml` picks Haiku, Sonnet or Opus the same way and falls back to Opus when the tier is in doubt. The settings template pins the aliases to the 5.5 IDs and gives general subagents and the scout Haiku 5.5.
- **Manual evals.** `sdlc.ts evals` runs `.sdlc/evals/<id>.json` (a prompt and command, file and skill-loaded checks) with `claude -p --output-format stream-json` in a throwaway worktree: code at the eval's `base`, configuration and the eval's `files` from HEAD. Results go to `.sdlc/evals/results.jsonl` (denied to Edit); `status` shows the last run; `metrics` adds `eval_pass_rate` and `incident_to_eval_hours`. `--seed` drafts evals from shipped changes. `evals` settings in sensors.json (`minPass` 0.9, advisory). No workflow runs them.
- The harness line cap is 7,600.
```

- [ ] **Step 4: Full verification**

Run each and read the output:

```bash
npm run typecheck
node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts
claude plugin validate .claude-plugin/plugin.json
wc -l skills/*/SKILL.md | sort -n | tail -3
```

Expected: typecheck clean; every test passes (about 600 plus the new ones); the plugin validates; no skill over 60 lines. If `npm run typecheck:mod` is available locally, run it too (the mod reads `step`, which gained a field).

- [ ] **Step 5: Commit**

```bash
git add README.md DESIGN.md CHANGELOG.md
git commit -m "docs: model by tier and manual evals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Line budget (M0 and M1, against the 7,600 cap)

| Change | Lines |
|---|---|
| `graph.ts` model field | +4 |
| `templates/settings.json` env and deny | +5 |
| skills: Models line ×8, routing edits | +16 |
| `templates/rig-review.yml` model step | +18 |
| `model.ts`, `configparse.ts` evals settings | +12 |
| `scripts/evals.ts` | ≈ 165 |
| `sdlc.ts` command, status line | +5 |
| `metrics.ts` | +8 |
| `diagnose` skill step | +1 |
| **Total** | **≈ 235**, leaving ≈ 465 for M2–M6 |
