# Spec 1: quality guides, sensors and always-on enforcement

Status: design for review · 2026-10-03 · extends `DESIGN.md` (v0.1). Spec 2, review triage and the review brief, is a follow-up (§14).

## 1. Problem

Generating code is no longer the hard part. The hard part is controlling it: making sure that agent-written code stays modular, loosely coupled and well tested, and that the codebase stays easy to manage. Three problems motivate this spec:

1. **No quality sensors.** Today the harness checks secrets, plan size, scope drift, sleep-polling and approvals. Nothing runs lint, types, tests, size, coupling or test-tamper checks while code is being written. Structural quality (SRP, SOLID) is left to a single model review at the end.
2. **The checks can be bypassed.**
   - The guards that need an active change return early when there isn't one (`scripts/sdlc.ts:586-590`), so someone who skips `/sdlc:start` skips the scope check, the plan check and the ship gate.
   - Edits made through Bash bypass the Write/Edit hooks (`DESIGN.md` §11).
   - A model can report results it never saw: trial defect 2, inferred exit codes.
3. **Changes across repos are invisible.** This is the Thoughtworks example: renaming `discount_rate` in billing-service passes locally while checkout-service and invoicing-service drift out of sync. The tier M trial let a contract change through without a gate (`DESIGN.md` §10, trial details).

Sources for the design:
- Thoughtworks, *Engineering the harness* (2026-09-29)
- Böckeler, *Harness engineering* (martinfowler.com)
- the official plugins: code-modernization, code-review, pr-review-toolkit, security-guidance, hookify and superpowers
- the 2026-10-03 trials

## 2. Decisions already made (with the person)

| Decision | Choice |
|---|---|
| Overall approach | **A**: computational sensors over git diffs on the hot path; inferential review once per change |
| Stacks | **Stack-agnostic only.** Built-in sensors use git and regex. Real tools come in as commands the project declares. |
| Edits with no active change | **Allowed. Sensors always run, and Stop gates the turn.** An ad-hoc change is recorded so ship and CI still triage it. |
| Unbypassable enforcement | **GitHub PR + a required Actions check** running the same `sdlc.ts check` |
| Service layout | **Sibling repos**, each declared with a local `path`, a GitHub `repo` and a `test` command |
| Mods | Human-facing UX and zero-token human-only commands. **Never the only enforcement.** |
| Footprint | Small and tidy, like code-modernization. The harness follows its own size limits. |

## 3. Non-goals

- `sdlc.ts` never becomes a linter or parser. It runs the project's tools and adds only checks that work in any language.
- No model calls on the hot path. Edit, Stop and SubagentStop are zero-token. The forensics found $79 (14% of spend) on per-change Opus security reviews.
- No new agents. The reviewer gains a lens; no second reviewer is added.
- No per-language adapters. Language knowledge lives in data tables (patterns), not in code.
- Review triage, risk labels, the review brief and PR creation across repos belong to spec 2.

## 4. Thoughtworks traceability

Every item in the post maps to a mechanism here. §-numbers refer to this spec.

| Post | Mechanism |
|---|---|
| Agent = Model + Harness; guides, sensors, selective gates | Whole spec |
| Scoped instructions, progressive disclosure | Three layers: CLAUDE.md (≤ 120 lines), stage skills, and path-scoped guides injected on first touch (§8) |
| Least-privilege tools, structural | Read-only agents; Bash write-deny keyed on `agent_type`; consumer repos deny-by-default (§8.4) |
| Explicit defaults instead of guesses | `intent.md ## Decisions`; missing intake fields asked for or recorded as explicit defaults (§8.3, §11) |
| Confirmation only for high blast radius | Tier gates plus the `impact` gate (§6.3) |
| Automated verification | Declared commands plus built-in sensors at Stop, ship and CI (§5, §6) |
| Silent success, verbose failure | Output contract (§7.8) |
| Promote prose to executable rules | `rules.json`, `/sdlc:rule`, and metrics-driven suggestions (§8.5) |
| Impact analysis across the workspace | contract-impact sensor (§5.3) |
| Multi-repo confirmation gate | `impact` approval; a held tool call in the mod (§6.3, §10) |
| Coordinated update, multi-service tests | Plan lists consumer files and tests; ship across repos (§6.3, §11) |
| ANALYZE: structured intake | `/sdlc:start` accepts an issue ref; explicit defaults (§11) |
| BLUEPRINT gate | Existing spec/plan gates plus `impact` |
| RED, then GREEN | Proof of red from captured runs (§5.8) |
| REFACTOR | Implementer refactor step under green tests (§8.3) |
| REVIEW: coverage vs acceptance criteria, auto-route back | Traceability sensor; ship routes untested criteria back to the implementer once (§5.9, §6.4) |
| Harness as software, peer reviewed | Harness-tamper sensor; harness edits need a human (§5.10) |
| Earn every rule; prune | Required `why:`; fire counts; prune after 90 quiet days (§8.5) |

## 5. Sensor catalogue

### 5.1 Project declaration: `.sdlc/sensors.json` (committed)

Onboard discovers it, and the person confirms it.

```jsonc
{
  "fast": { "lint": "<cmd>", "typecheck": "<cmd>", "test": "<cmd>" },  // Stop: 60 s total
  "full": { "test": "<cmd>", "coverage": "<cmd>", "arch": "<cmd>" },    // verify, ship, CI
  "tests":     ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.py", "**/*Test.java", "**/*_spec.rb"],
  "ignore":    ["**/*.md", "**/*.lock", "**/package-lock.json"],
  "contracts": ["api/**", "schema/**", "migrations/**", "**/*.proto", "**/openapi.*"],
  "consumers": [{ "name": "checkout-service", "path": "../checkout-service", "repo": "acme/checkout-service", "test": "npm test" }],
  "layers":    [{ "from": "src/domain/**", "mustNotImport": ["infra", "http"], "why": "domain stays framework-free" }],
  "limits":    { "fileLines": 400, "diffLines": 500 },
  "knownRed":  []                                            // written by onboard only (§7.5)
}
```

- Every key is optional. The defaults shown are what an absent key means.
- A missing `fast` block means only the built-in sensors run at Stop.
- `sdlc.ts check` validates the file and reports a malformed one as a failure.

### 5.2 Diff model

All sensors are pure functions over one parsed diff: `{ file, status: A|M|D|R, added: Line[], removed: Line[] }[]`.

- **Turn diff** (used at Stop and SubagentStop):
  - Tracked changes come from `git diff --unified=0 <baseline-sha>`.
  - Untracked files come from comparing `git ls-files --others --exclude-standard` with their content hashes recorded at the baseline. `git stash create` ignores untracked files, so they are snapshotted separately.
- **Branch diff** (used at ship and CI): `git diff --unified=0 <merge-base>` plus untracked files.
- **"Source"** means a file outside `.sdlc/` that is not matched by `ignore`.
- Sensors receive the diff and the config, and return `Finding[]`, where a Finding is `{ sensor, file, line?, severity: block|warn, message, fix }`.

### 5.3 contract-impact

1. Take every source file in the diff that matches `contracts`.
2. Collect **retired identifiers** from two sources:
   - **(a) Removed tokens:** tokens matching `[A-Za-z_][A-Za-z0-9_]{2,}` that appear in removed lines but not in added lines of that file.
   - **(b) Rename and drop statements** in added lines, via a small data table, `RETIRE_PATTERNS`: `RENAME COLUMN a TO b`, `DROP COLUMN a`, `ALTER TABLE … RENAME TO`, `rename_column :t, :a, :b`, `remove_column`, `RenameField(…old_name='a'`, `RemoveField`, `renameColumn('a'`, `dropColumn('a'`. These catch the canonical migration-style rename, which lives only in added lines of a new file.
3. **Filter out noise:**
   - Drop identifiers that still occur anywhere in the producer's `contracts` files after the change.
   - Drop a stop-list of generic words (`id`, `name`, `type`, `string`, `number`, `value`, `data`, keywords).
   - Cap at 50.
4. For each consumer, run `git -C <path> grep -n -w -F -e <id>…`.
5. Each hit becomes a finding: `checkout-service/src/cart.ts:42 still uses discount_rate`.

| Situation | Result |
|---|---|
| Hit, and the active change has an `impact` approval and the consumer files are in plan `## Files` | Tracked as work to do; blocks only at ship if still present |
| Hit with no `impact` approval | **block**, with: *"cross-repo contract change: N consumers still reference X (paths). This needs a gated change: run /sdlc:start."* |
| Consumer path missing locally | warn at Stop ("not checked out, can't verify"); **block** at ship and CI ("can't run = fail") |

The matching is a heuristic, so it may report hits that aren't real breakages. A hit leads to a gate or a fix, never to a silent pass.

### 5.4 test-tamper

This runs on files matched by `tests`, plus suppression comments in any file. The patterns are a data table, `TAMPER_PATTERNS`, with one row per framework.

| Check | Rule | Severity |
|---|---|---|
| Deleted test file | status D on a test file that git's rename detection does not pair with an added file, and whose content does not reappear (≥ 60% similar lines) in a new untracked file | block |
| Added skip or focus | Added line matches, anchored to call or annotation position: `\b(it\|describe\|test)\.(skip\|only)\(`, `^\s*x(it\|describe\|test)\(`, `^\s*@pytest\.mark\.(skip\|xfail)`, `^\s*@unittest\.skip`, `^\s*@(Disabled\|Ignore)\b`, `\bt\.Skip(Now)?\(`, `^\s*pending\b` (RSpec block form only; never inside a string) | block |
| Fewer assertions | Counted **across all test files in the diff** (so moving tests between files is neutral): removed assertion calls outnumber added ones. Comment lines are excluded. Tokens: `assert\w*\(`, `expect\(`, `\.should\b`, `Assert\.\w+\(`, `t\.(Error\|Fatal)f?\(`, `require\.\w+\(` | block |
| Lowered threshold | In a config file, a number decreases on a line matching `coverage\|threshold\|fail_under\|lines\|branches\|functions\|statements` | block |
| Suppression added | Added line matches `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore`, `# noqa`, `pylint: disable`, `//nolint`, `@SuppressWarnings`, `rubocop:disable` | block, unless the same line carries a reason after `--` or `because` |
| Snapshot rewritten | `__snapshots__/**` or `*.snap` modified | warn |

Every `TAMPER_PATTERNS` row ships with a **negative fixture** in the unit tests. For example, `expect(t.status).toBe('pending')` must not match the RSpec `pending` row.

### 5.5 layering

- For files matching a rule's `from`, look at added lines that look like imports: `^\s*(import|from|require|use|using|#include|include)\b` or containing `require(`.
- A line that contains any `mustNotImport` token is a **block**. The message carries the rule's `why`.
- This is the only stack-agnostic proxy for coupling. Projects with a real architecture tool declare it as `full.arch`.

### 5.6 size

| Check | Stop | Ship / CI |
|---|---|---|
| A changed file grows past `fileLines` (only when this diff crossed the limit) | warn | warn |
| Branch diff over `diffLines` added+removed, excluding `ignore` | warn | **block**, unless a human waiver exists |

### 5.7 secrets and rules

- **secrets:** the existing `scanSecrets`, run on the diff's added lines and on whole new files.
- **rules:** `.sdlc/rules.json`, of the form `[{ id, pattern, paths?, message, why, action: warn|block }]`, applied to added lines. `why` is required, and a rule without one is rejected by `check`.

### 5.8 Captured runs and proof of red

- `sdlc.ts run [--expect-fail] [--slug s] -- <cmd>` runs the command and appends a row to `.sdlc/changes/<slug>/runs.jsonl`: `{ at, cmd, exit, ms, tail (last 30 lines), expectFail }`.
- **Every verdict in the harness reads exit codes from this log only**: `verification.md` `result:`, ship, and the declared-command sensor.
- A model-written `result: pass` with no matching passing row is ignored. This fixes trial defect 2.
- **Proof of red is recomputed, never read from a log.** The model chooses which commands it logs, and a run made before the test file exists fails for the wrong reason. So ship and CI recompute it instead. Applies to tiers M and L of every type, and to bugfix at every tier:
  1. `git worktree add` at the merge-base.
  2. Overlay the branch's added and modified test files (by the `tests` globs).
  3. Run `full.test`, or each acceptance command in plan `## Slices`, through `sdlc.ts run`.
  4. **It must exit non-zero.**

  This proves the property that matters: **the new tests do not pass against the old code.**
- **Which proof applies depends on the change type** (decided on 2026-10-03):
  - feature and greenfield at M and L, and bugfix and incident at every tier, prove **red**: the changed tests must fail on the base.
  - refactor at M and L proves **green on the base**: its characterization tests must pass on the old code, which pins the behaviour being preserved.
  - chore and migration get no extra proof, because their full suite already runs as the ship gate's commands. It works in any language, can't be forged, and needs no history, so CI can run it. When it passes against the old code, it is a **block**: *"the new tests already pass on the base; they prove nothing about this change."* A test that fails to compile against the base counts as red. That is honest: the old code cannot satisfy it.
- The `--expect-fail` rows in `runs.jsonl` stay useful as build-time evidence in `verification.md`, but no gate depends on them.

### 5.9 traceability

- **At ship:** every `B<n>` in `spec.md ## Behaviours` (or every `B<n>` named in plan `## Slices` when there is no spec) must appear in a test file reachable by `git grep` over `tests`. Each one that is missing is a **block**, naming the B-number and its text.
- **Stack-agnostic:** test names and comments are free text in every language.

### 5.10 harness-tamper

| Check | Rule |
|---|---|
| Protected paths | Config: `.sdlc/sensors.json`, `.sdlc/rules.json`, `.sdlc/guides/**`, `.sdlc/bin/**`, `CLAUDE.md`, `.claude/**`, `.github/workflows/sdlc-check.yml`, `CODEOWNERS`. **Evidence and gate state, writable only by `sdlc.ts` itself:** `.sdlc/approvals.jsonl`, `.sdlc/waivers.jsonl`, `.sdlc/changes/*/runs.jsonl`, `.sdlc/.baseline`, `.sdlc/.gate`, `.sdlc/unresolved.json`. The model is denied Write/Edit on evidence files, and denied Bash writes to them except through `sdlc.ts run`. Without this, a forged `runs.jsonl` row, or a gate count bumped to 2, would cancel the guarantees in §5.8 and §7. |
| PreToolUse Write/Edit on a protected path | **ask** the human: the mod dialog shows what gets weaker (§10); the settings hook falls back to `ask`, or `deny` under `-p`. Approvals and waivers stay **deny** (existing). |
| Turn diff touches a protected path with no PreToolUse event (a Bash edit) | **block**: *"harness file changed via Bash; revert it, or have the person make this change"*. Two exemptions: (1) `approvals.jsonl` and `waivers.jsonl`, which are append-only, written only by the human mod commands, and already denied to the model at PreToolUse and in Bash; (2) a `sensors.json` change that only removes `knownRed` entries, which is the ratchet's own tightening (§7.5). |
| Weakening detection | A raised limit, a removed rule, entry or consumer, an added `knownRed`, or removed `tests`/`contracts` globs is labelled `weakens-harness` in the finding |
| CI | Harness-file changes are reported, and spec 2 marks them needs-human-review. CI blocks only on the weakening labels, unless a human waiver exists. |

### 5.11 Declared commands

- `fast.*` runs at Stop and `full.*` at verify, ship and CI, all through `sdlc.ts run`.
- A non-zero exit or a timeout is a **block**. "Can't run = fail, never skip."
- Commands listed in `knownRed` (§7.5) are reported and do not block.

## 6. Firing points

There is one entry point, `sdlc.ts check --at <point> [--base <ref>]`. The same sensors run everywhere; only the diff and the set of sensors change.

| Point | Trigger | Diff | Sensors | On failure |
|---|---|---|---|---|
| session | SessionStart `startup\|clear\|compact` | — | none; injects the active change, the list of guides and "sensors on" | — |
| baseline | UserPromptSubmit | — | writes `.sdlc/.baseline` (gitignored): stash SHA or HEAD, plus untracked hashes | — |
| pre-edit | PreToolUse Write/Edit | — | scope ask (exists); harness-tamper ask; consumer-repo deny (§8.4); first-touch guide injection (§8.1) | ask / deny |
| post-edit | PostToolUse Write/Edit | that file | secrets, rules, test-tamper, size | exit 2 + fix |
| stop | Stop, SubagentStop | turn | all built-ins except traceability and red proof; then `fast.*` | `decision: block` (§7) |
| plan | the plan skill runs `check --at plan` | plan `## Contracts` | contract-impact on the declared identifiers | escalates (§6.3) |
| ship | the verify and ship skills | branch | everything, including traceability, red proof, `full.*` and consumer tests | ship refuses |
| ci | required GitHub check | branch vs `origin/main` | same as ship | merge blocked; fails closed |

### 6.1 No-op exit

Stop returns in milliseconds when the turn diff contains no source files: Q&A turns, or turns that only touched `.sdlc/`.

### 6.2 Work with no active change (vibe coding)

On the first Stop with a source diff and no active change, the script runs `sdlc.ts new adhoc-<yyyymmdd-hhmm> --type chore --tier <computed>`.
- The computed tier is: S if 3 or fewer files and no contract file; M if 15 or fewer; otherwise L.
- It is a record, not a gate. The sensors still block on their own findings.
- **Ad-hoc tier S** ships like any tier S change.
- **Ship refuses ad-hoc tier M and L.** Without a plan, the proof-of-red, traceability and scope checks would pass vacuously, so a vibe-coded large change would get *weaker* gating than one that came through the front door. Ship prints *"this ad-hoc change is tier <M|L>: run /sdlc:start <slug> to adopt it"*. Adopting writes the plan and applies the tier's normal gates; the code already written is kept.
- CI applies the same rule: an ad-hoc M/L change in a PR with no plan fails the check.

### 6.3 Impact gate (the Thoughtworks flow)

1. **Plan.** The architect writes `## Contracts` in plan.md, naming the identifiers being renamed or removed. `check --at plan` greps every consumer for them.
2. **Hits.** The change is escalated to tier L. `/sdlc-approve <slug> impact` becomes a required gate before build. The plan must list consumer files in `## Files` (as `../<consumer>/…` globs), and each consumer's `test` command in `## Verification`.
3. **Build.** Consumer edits are allowed only for paths that are in plan `## Files` and only while `impact` is approved (§8.4).
4. **Verify and ship.** All affected consumers' tests run through `sdlc.ts run`. Ship runs across repos (§11).
5. **Vibe path.** contract-impact blocks at Stop (§5.3), and CI is the backstop.

### 6.4 Automatic routing back (REVIEW → RED/GREEN)

If ship finds traceability or red-proof blocks, the ship skill launches **one** implementer run with only those items, then re-runs `check --at ship`. Anything still failing goes to the person. This matches the existing one-fix-round budget.

## 7. Stop-gate safety

1. **Loop cap.** A turn gets at most 2 blocks, counted in `.sdlc/.gate` (gitignored), keyed by baseline SHA, together with `stop_hook_active`. On the third attempt Stop is allowed. Findings are written to `.sdlc/unresolved.json`, and the person sees a `systemMessage`: *"quality gate: N problems unresolved after 2 attempts; ship and CI will refuse."*
2. **Cache.** Results are cached by diff hash, so SubagentStop and the main Stop never run the same checks twice.
3. **Subagents and parallel slices.** A large build is often one main turn with up to 3 implementers running in parallel in the same working tree. A turn-wide diff at SubagentStop would blame implementer A for B's half-finished edits in files A must not touch.
   - **If a `SubagentStart` hook exists** (to verify, §15): each subagent gets its own baseline in `.sdlc/.baseline`, keyed by agent id.
   - **In both cases:** SubagentStop filters findings to the files the slice owns (from the plan, through the active slice in `STATE.md`) and **skips `fast.*`**, because whole-project commands cannot be attributed to one slice.
   - The main Stop, after all slices finish, runs everything.
   - **If neither per-agent baselines nor a slice lookup are possible:** parallel slices are disabled while the gate is on (the build skill runs them sequentially).
4. **Time.** Built-in sensors take under 1 s. `fast.*` has a 60 s budget inside a 90 s hook timeout. A timeout is a failure, and the message says to make `sensors.json fast` faster.
5. **Ratchet.** Onboard runs `fast.*` once. Commands that are already red go into `knownRed`; they are reported but do not block. When a known-red command passes once, `check` removes it from the list, so it blocks from then on. This is the one automatic edit to sensors.json, and it can only tighten. Built-in sensors only look at the diff, so problems that already existed never block.
6. **Waivers are human-only.** `/sdlc-waive <sensor> <file|*> <reason>` is a mod command that writes `waivers.jsonl`, guarded like approvals. Waivers apply to the active change only, and the review brief lists them.
7. **Fail-open locally, fail-closed in CI.** A crash in `sdlc.ts` allows Stop, with a warning, so a broken harness cannot lock up a session. CI treats the same crash as a failure.
8. **Output contract.**
   - On pass: one line, or nothing at all for hooks.
   - On fail: at most 40 lines, grouped by sensor, severity first, deduplicated, each with `file:line`, what is wrong and how to fix it.
   - Warns never block, and they appear as a single summary line.

## 8. Guides, the review lens, least privilege and rules

### 8.1 Path-scoped guides (progressive disclosure)

- **Format:** `.sdlc/guides/*.md`, with frontmatter `paths:` (globs) and `why:`, each **60 lines or fewer**.
- **Injection:** PreToolUse Write/Edit injects a guide as `additionalContext` the first time in a session that a file matches one of its `paths`. The injected set is tracked in `.sdlc/.gate`.
- **SessionStart:** lists the guide names only.
- **The plugin ships three defaults.** Onboard copies them into the project, where they can be edited:
  - `engineering.md`: one reason to change per unit; dependencies point inward; inject at boundaries; no god files; composition over inheritance; no abstraction with a single implementation; reuse before writing; small functions with clear names.
  - `testing.md`: test behaviour, not implementation; one reason to fail per test; cover edges and errors; never weaken a test; a test you never saw fail proves nothing; name tests after the behaviour (B-number).
  - `contracts.md` (paths are the `contracts` globs): expand, migrate, contract; never rename in place; list consumers; version breaking changes; additive first.
- **Style:** hard rules plus a short table of rationalizations, borrowed from superpowers.

### 8.2 The plan template

The architect's plan.md gains two sections:
- `## Design`: modules and the direction of dependencies (5 lines or fewer). This is what the layering rules check.
- `## Contracts`: identifiers that are added, renamed or removed. Write `none` if there are none.

### 8.3 Implementer and intent

- **The implementer brief adds:**
  - the guides that apply
  - `sdlc.ts run --expect-fail` for the red run
  - the refactor step: once green, tidy within the slice's files and re-run the tests
- **intent.md gains `## Decisions`:** optional steps that were skipped, and defaults that were taken, each on one line. They are never left implicit.

### 8.4 Least privilege

The PreToolUse Bash guard is keyed on `agent_type`. It applies the existing write-command matcher in `WRITES` to deny anything that writes a file, for these agents:
- `sdlc:scout`
- `sdlc:reviewer`
- `sdlc:verifier` (except `sdlc.ts run` and `sdlc.ts verify-report`)

This hook is the only place to enforce it, because plugin agents ignore the `hooks` setting in agent frontmatter.

Edits outside the repo root:
- **Denied by default.**
- Allowed only when the path is under a declared consumer, the active change has `impact` approval, and the path matches plan `## Files`.

### 8.5 Rules: promotion and pruning

- `/sdlc:metrics` counts review findings by category, using a `category:` tag the reviewer adds. When a category occurs 3 or more times in 30 days, metrics suggests a rule.
- `/sdlc:rule "<what keeps recurring>"` is a new skill of 60 lines or fewer. It drafts a `rules.json` entry with `why:` and a test line that should match. The person commits it, because harness-tamper puts the edit to a human.
- Each rule's fire count is appended to `usage.jsonl`. Rules with zero fires in 90 days are listed for pruning.

### 8.6 The model review lens (the one inferential sensor)

The reviewer agent's checklist gains the following:
- **Design lens:**
  - one responsibility per unit
  - coupling and the direction of dependencies, against plan `## Design`
  - abstractions with a single implementation
  - leaked layers
  - tests that pin behaviour versus tests that merely execute code
  - "if I could change only one thing…" (from code-modernization's architecture critic)
- **False-positive list (from the code-review plugin):** nothing a linter, type checker or sensor catches; nothing pre-existing; nothing on lines the diff did not touch; nothing that the intent's non-goals exclude.
- **Tier L only, recall then refute:** before dropping a candidate finding, the reviewer must cite `file:line` evidence that it is not real.
- **`category:`** on each finding, to feed §8.5.

## 9. CI parity

- `templates/sdlc-check.yml` is about 25 lines. It:
  1. checks out this repo
  2. checks out each consumer's `repo` into `../<name>`
  3. sets up Node 22.18+
  4. runs the checker **from the base ref**: `git show origin/main:.sdlc/bin/…` into a temp dir, then `node <tmp>/sdlc.ts check --at ci --base origin/main --config-from origin/main`
- Onboard offers to install it. The person makes it a required check.
- **The PR does not get to grade itself.**
  - CI loads the checker (`.sdlc/bin/**`) and `sensors.json`, `rules.json` and the guides from the **base ref**, and evaluates the head against that config. A PR that loosens the config or neuters the vendored checker is judged by the old, stricter version, and harness-tamper reports the loosening.
  - **Bootstrap exception:** the PR that first introduces `.sdlc/bin` uses the head version, and is flagged needs-human-review in spec 2.
  - Onboard also proposes **CODEOWNERS** entries for `.sdlc/**` and the workflow file, so harness changes need an owner's review. That is the post's "harness edits through peer-reviewed PRs".
- **Private consumer repos** need a read token, because `GITHUB_TOKEN` is scoped to one repo. The template reads a `SDLC_CONSUMERS_TOKEN` secret (a fine-grained PAT or GitHub App token with contents:read). If the secret is missing, the check fails with a message saying how to add it. Under "can't run = fail" it never skips silently.
- **Vendoring.** Onboard copies `sdlc.ts`, `sensors.ts` and `hooks.ts` into `.sdlc/bin/`, with the plugin version in a header comment, so CI does not depend on the plugin. Re-running `onboard --update-bin` refreshes them. The ship check warns when `.sdlc/bin` is older than the plugin.
- **Results.** CI writes the findings to `$GITHUB_STEP_SUMMARY`, and spec 2 builds the brief on top of it.
- **Dogfooding.** The plugin repo's own CI runs `sdlc.ts check --at ci` on itself.

## 10. The mod: human-facing only

| Feature | Mechanism | Fallback without a mod |
|---|---|---|
| Quality band: `sensors ✓ lint ✓ types ✗ tamper(1) · gate 1/2 · known-red 2 · waivers 1` | `ui.render` AbovePrompt (extends the existing band) | Stop message |
| `/sdlc-sensors` pane: last findings, known-red, waivers | `ui.open` + `command.run` | `sdlc.ts check` |
| Impact gate dialog: holds an edit to a contract file or consumer repo, lists the consumers that would break, Approve/Cancel; Approve writes the `impact` approval | `tool.call` hold + `$.ui.ask`, modelled on the `blast-radius` sample | PreToolUse ask/deny; Stop and CI sensors |
| Harness-tamper dialog: shows what gets weaker | `tool.call` hold + `$.ui.ask` | PreToolUse ask/deny |
| `/sdlc-waive` | `command.run`, human origin only (like `/sdlc-approve`) | none needed; CI without a waiver means fail |
| Notes on tool rows: `✓ sdlc` / `✗ tamper: test/x.spec.ts:12` | `ui.notice` | exit 2 message |
| Sensor telemetry: fires, ms, extra turns per blocked Stop | `turn.complete` → `usage.jsonl` | script appends counts |

Deliberately not used:
- `prompt.section` and `prompt.context` for guides: they break the prompt cache
- the built-in `you-should-know` side agent: a model on the hot path
- `tool.check` auto-approve: the harness only ever tightens

## 11. Changes to existing stages

| Stage | Change |
|---|---|
| `start` | Accepts `#123` or an issue URL (`gh issue view`) as the request. Required intent fields are asked for, or recorded as an explicit default in `## Decisions`. |
| `onboard` | Discovers `sensors.json` (scout sweep (b) already finds the commands), asks about consumers, runs `fast.*` once for `knownRed`, copies guides, offers the CI workflow, vendors `.sdlc/bin`. |
| `plan` | `## Design` and `## Contracts`; runs `check --at plan`; escalation to impact. |
| `build` | Briefs carry guides, the red run and the refactor step. |
| `verify` | Commands go through `sdlc.ts run`; `verification.md` is generated from `runs.jsonl` by `sdlc.ts verify-report`, never typed by the model. |
| `review` | Lens, false-positive list and `category:` (§8.6). |
| `ship` | `check --at ship`; one automatic routing round (§6.4); ship across repos: for each consumer with changes, branch `sdlc/<slug>`, run its test through `sdlc.ts run`, commit with the same message plus `Part of <repo>@sdlc/<slug>`, and record `repos: [{ name, branch, commit }]` in ship.json. Clear `STATE.md` and stage it (trial defect 3). Pushing and PRs belong to spec 2. |

## 12. Files and footprint

| | Today | After |
|---|---|---|
| `scripts/sdlc.ts` | 774 lines, everything | ≤ 500: CLI, state, gates, ship, metrics |
| `scripts/sensors.ts` | — | ≤ 500: diff parsing, sensors as pure functions, the `TAMPER_PATTERNS` table |
| `scripts/hooks.ts` | (inside sdlc.ts) | ≤ 300: hook adapters (stdin → check → hook JSON), gate state |
| `.sdlc/bin/` (in the consumer project) | — | the three scripts, vendored for CI (§9) |
| skills | 12 | 13 (`rule`) |
| agents | 5 | 5 |
| hook entries | 4 | 7 (UserPromptSubmit, Stop, SubagentStop) |
| mod | `register.tsx` 166 | `register.tsx` (wiring) + `band.tsx` + `gates.tsx`, each ≤ 300 |
| guides | — | 3 × ≤ 60 lines |
| templates | settings.json | + `sdlc-check.yml` |

**Size limits for the harness itself:**

| Thing | Max |
|---|---|
| Script file | 500 lines |
| Skill | 60 lines |
| Guide | 60 lines |

The plugin's CI enforces these through its own `check`.

## 13. Proof

1. **Unit tests** in `scripts/sensors.spec.ts`:
   - one pass fixture and one fail fixture per sensor and per `TAMPER_PATTERNS` row
   - diff parsing, including untracked files
   - the loop cap
   - the no-op exit
   - the ratchet
   - fail-open locally and fail-closed in CI
2. **Mod tests** (`claude plugin test`): the band renders, `/sdlc-waive` refuses a non-human origin, and the impact hold asks and then writes the approval.
3. **Seeded-defect trial.** This uses the todo-core sample plus a sibling consumer repo created for the trial. Each defect must be caught **at Stop locally and in CI**, using the harness both with and without an active change:

   | # | Defect |
   |---|---|
   | 1 | weakened assertion |
   | 2 | added `.skip` |
   | 3 | domain→infra import |
   | 4 | 700-line diff (blocked at ship and CI) |
   | 5 | an edit made through Bash (`sed -i`) that adds a suppression comment |
   | 6 | `discount_rate` renamed with the consumer still using it, twice: (a) by editing the schema file, and (b) by a new migration file containing only `RENAME COLUMN discount_rate TO promotional_discount` |
   | 7 | the agent raising `limits.diffLines` |
   | 8 | `verification.md` claiming a pass with no run recorded |
   | 9 | a B-number with no test |

4. **Cost and time.** Re-run the tier M trial. Targets:
   - The Stop gate adds **≤ 5%** cost.
   - Q&A turns cost **zero** extra tokens.
   - The **median** Stop gate takes **≤ 15 s** on turns that change code (the worst case is bounded by the 60 s `fast.*` budget).
   - The trial reports wall time for the harness against plain Claude Code.
5. **Forgery attempts.** The seeded trial also tries to:
   - append a passing row to `runs.jsonl`
   - bump `.sdlc/.gate`
   - edit `.sdlc/bin/sensors.ts` in a PR

   Each must be denied locally, or judged against the base in CI.
6. **Noise.** Count false-positive blocks across the trial runs. The target is 0, and each one found is fixed before release.

## 14. Spec 2 (follow-up): review triage and brief

- Risk labels computed from path globs: public API, auth, schema/migrations, harness files, agent skills.
- `needs-human-review` vs `ai-reviewed`.
- A PR size cap with recorded overrides.
- The review brief: risk reasons, plan/spec links, the test diff and schema diff inline, sensor results, reviewer findings at ≥ 80 confidence, and waivers.
- PRs across repos, cross-linked.
- The `/sdlc-brief` pane.

## 15. To verify while implementing

- The Stop hook input carries `stop_hook_active`, and SubagentStop input carries `agent_type`.
- PreToolUse hook output accepts `additionalContext` (for guide injection).
- `git stash create` behaviour on a clean tree (it returns nothing, so use HEAD) and with a staged-only tree.
- The relative `../consumer/**` globs in plan `## Files` with `relPosix`/`isPlanned`, which today assume paths inside the repo.
- Whether a `tool.call` hold in the mod applies to subagent tool calls.
- Whether a `SubagentStart` hook event exists, for per-agent baselines (§7.3).
- `git worktree add` at the merge-base plus the test overlay for proof of red: time cost on a mid-size repo, and cleanup on failure.
