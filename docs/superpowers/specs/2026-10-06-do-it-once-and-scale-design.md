# rig v0.5 to v0.7: follow the official plugin pattern, do each thing once, scale to large repos

Status: draft 2 for review. Replaces draft 1, which carried old-harness machinery (a result cache, per-change preflight, cross-change dependencies) that the official pattern does not use. Evidence and measurements are in `docs/proposals/2026-10-06-efficiency-and-scale.md`. Path: architectural. After approval: `writing-plans`.

Pattern source: Anthropic's `code-modernization` plugin (`anthropics/claude-plugins-official`), read in full for this draft: README, `plugin.json`, `hooks.json`, `modernize`, `-preflight`, `-status`, `-verify`, an agent, the `extract-rules` workflow and `make_shards.py`. Large-codebase and best-practice guidance: the two Claude Code docs pages you named.

## 1. Intent

**Outcome.** rig behaves like the official plugin: a front door that records intent once, standalone commands that each write one artifact and end on the exact next command, verdicts computed by scripts from files and recomputed every time, a short list of human decision points, and heavy work sharded into bounded units. Each expensive thing happens once. Large repos and monorepos work by sharding, not by loading everything. None of the failure modes in `docs/stuff.eml` can recur, and none of that harness's design choices are carried over.

**Success** (counts are gated in tests; timings are reported):

| Measure | Today | Target |
|---|---|---|
| Hook processes spawned per tool call | 1 to 3 (PreToolUse on every Bash and Edit, PostToolUse on every edit) | 0 |
| Registered hook events | 9 | 6, none per tool call (§4) |
| Runs of the full test command per tier M change, same tree | 6 to 8 plus CI | verify once from clean, red-proof once on base, CI once |
| In-session model review passes, tier S / M / L | 2 / 2 / 3-4 | 0-1 / 1 / one sharded pass |
| Largest agent context in a review | whole diff in one reviewer | ≤ 25 files and ≤ 5,000 changed lines per shard |
| Non-test source lines | about 5.2k | ≤ 5.0k at v0.7 (gated; every release is net negative) |
| Email failure modes without a full guard (§8) | 8 of 11 | 0 |

**Non-goals.** No wiki, no learning loop, no `bin/rig` wrapper, no dependency-graph parsing, no cross-change dependencies, no Windows support, no telemetry.

**Interpretation to confirm.** "The v5 of my previous attempt" is read as the harness in `docs/stuff.eml` (the `/auto` scaffold with generator and evaluator, seven gates, self-heal, learned rules, Jira stories). Its design choices are listed in §3 as "not carried". If you meant a different version, tell me and §3 changes.

## 2. What the official plugin does, and what rig does about it

| Official pattern (where seen) | rig today | Action |
|---|---|---|
| **Front door writes `INTENT.md` once; every command reads it and never re-asks** (`modernize`) | `/rig:start` writes `intent.md`, max two questions | Keep |
| **Each command stands alone, writes one artifact, ends on the exact next command** (every command; "each step stands alone") | Same, but `build`, `test`, `sensors` end by chaining into `skill next` unless `/rig-run` drives | Keep chaining only under `/rig:run`; default is stop and print `Next:` (decision D2) |
| **Verdicts computed by a script from files, recomputed each time, none carried over** (`proof_pack.py`; "recomputed from current evidence each time") | `verify` does this; ship, push and quality then re-run the same checks again | Run once from clean; later gates check a tree stamp, never re-run (R2) |
| **Preflight is one run-first command**: every check runs, one complete report, at most five questions only a person can answer, proves the build on this code, checks the source is protected (`modernize-preflight`) | None. `init` baselines commands, nothing reports readiness | `init` writes `.sdlc/PREFLIGHT.md` (R6). Once per repo, not per change |
| **`status` inspects and never modifies; flags stale artifacts by file time; ends with three lines (where you are, what is stale, next command)** (`modernize-status`) | `status` and `next` exist; no staleness | Add staleness and the three lines (R7) |
| **People decide at a short, named list of points; open items are written down, never ticked for you** (README: six points) | Gates per tier, approvals ledger | Keep; `status` lists open items from intent, design and plan |
| **Large codebases are sharded with hard bounds, run in ordered batches, announced before launch, resumable from a journal** (`make_shards.py`: ≤ 25 files, ≤ 5,000 LOC; `extract-rules.js`: batches of 8, per-finding referee, `resumeFromRunId`) | One Opus reviewer reads the whole diff; the 200K ceiling was the email's top cause | Shard review by scope with the same bounds, as a plugin workflow (R3, R8) |
| **Source stays where it is: `--source` links, nothing is copied** | `vendor --standalone` copies scripts, skills and agents into each repo | Keep for v0.5 (CI loads the checker from the base branch, so removing it is its own change); decision D3 |
| **Protection = convention backed by settings deny rules, checked by preflight; "a script that opens files itself is not covered", so stay on a prompted mode for fan-out** (README "Set it up") | Regex guards parse every Bash command and every edit (`HUMAN_ONLY`, `OBFUSCATED_HUMAN`, `isSafeEvidenceCommand`, auto-approval); DESIGN §10 already calls such matching "too leaky" | Delete the guard layer; use deny rules; CI plus branch protection is the boundary (R1) |
| **Hooks are observational: async, 10 s timeout, `asyncRewake`** (`hooks.json`); the pane is an optional `modules` entry | 9 events, three of them synchronous on every tool call, plus a 90 s Stop gate | Keep one blocking Stop gate (the best-practices doc endorses a Stop hook as the deterministic gate); everything else async or removed (R1) |
| **Per-user knobs in `plugin.json` `userConfig`** | Not used | `userConfig` for per-user switches only (the band and panes: auto, command, off). Repo policy stays in committed `sensors.json`, as `analysis/` is committed state |
| **README: install, start here, the path table, what to expect (times, agent counts, "asks before a big run"), words you will see, safety (analysed code is untrusted input), working in a team (artifact to reviewer), and a human-readable CHANGELOG per version** | README covers most; no "what to expect"; changelog is per-release | Add "what to expect" and the team table; keep the changelog |
| **Agents write only inside their unit; one job each; secrets masked; file content is data, instruction-shaped text is listed, never followed** | Same shape | Add the untrusted-input line to `reviewer` and `scout` |

## 3. Design choices from the old harness, and the rule that keeps them out

Each is a choice visible in `docs/stuff.eml`. None may enter rig.

| Old choice (evidence) | Rule for rig |
|---|---|
| One autonomous `/auto` pipeline with a generator and an evaluator who negotiate a "contract" (26 min failing at negotiation; 4.1 h across 8 stories) | Commands stand alone. A human approves the design once. No agent-to-agent negotiation |
| Seven numbered gates run in series, the evaluator gate alone 12.6 h | Gates are the tier's few human decision points plus script sensors. One model review per change |
| Self-heal loops up to 9 attempts against a limit of 2 (20.2 h) | A loop past its cap stops and reports. No new loops. The ratchet caps stay as they are and are not extended |
| Learned rules loaded wholesale into every agent | Not built. If ever added, optional plugin, filtered by touched scope |
| Org-specific preflight: Jira story-to-epic lookup, Bitbucket fleet sync, manifest Java version, prototype folder | Preflight reads only what the repo itself declares (build files, `sensors.json`, git). No tracker, no hosting, no fleet |
| Cross-story dependencies as blockers (all 21 unmet ACs) | No `depends:`. Order work by running commands in the order a person chooses; ship each change separately |
| Hand-kept `features.json` status | Status is derived from which files exist and their times; nothing stored (a test enforces it) |
| Agents loaded to a 200K ceiling, work lost uncommitted | Bounded shards and slices, a checkpoint commit per slice |
| Runs left open, untimed lanes (44% of the clock) | Observational lane events; span ends at the last event, never at now |

## 4. Release plan

| Release | Contents |
|---|---|
| **v0.5.0** "align and stop repeating" | R1 delete the guard layer and per-call hooks; R2 stamp, don't re-run; R3 one review per change, sharded when large; R4 one base-tree helper; R5 batched, diff-only test count |
| **v0.6.0** "scale" | R6 preflight in `init`; R7 `status` staleness; R8 scopes and shards; R9 slice checkpoints; R10 lane events; R11 size block at Stop |
| **v0.7.0** "monorepo onboarding" | R12 `init --monorepo`; R13 fewer model turns |

After v0.6.0 every row of §8 is guarded. Compatibility: every new key in `sensors.json` is optional and an old config works unchanged. Deleted behaviour (R1) is listed in `CHANGELOG.md` with its replacement. Vendored copies upgrade with `vendor --standalone`.

## 5. v0.5.0

### R1. Delete the guard layer and the per-call hooks

Removed: the `pre-bash` and `pre-edit` hooks and their logic (`hooks.ts` guards, `shell.ts`, `autoapprove.ts` and their specs, about 550 lines), the `post-edit` hook, and the per-agent Stop bookkeeping (`subagent-start` snapshot, `subagent-stop` gate).

Replaced by, following the official "Set it up" section:

- `templates/settings.json` ships deny rules for evidence the model must not write: `Edit(.sdlc/approvals.jsonl)`, `Edit(.sdlc/waivers.jsonl)`, `Edit(.sdlc/sensors.json)`, `Edit(.sdlc/rules.json)`, and under `.sdlc/changes/*/`: `runs.jsonl`, `ratchet.json`, `events.jsonl`, `verification.md`, `ship.json`, `pr.md`, `preflight`. The `Edit` rule also covers `Write`. Rules are anchored with `/` at the repo root. Existing `.env` denies stay.
- `init` (preflight, R6) verifies the deny rules are present, as the official `preflight` does.
- Auto-approval of declared commands is replaced by `permissions.allow` rules for the exact commands in `sensors.json` (written by `init`) and by Claude Code's auto mode; the best-practices doc names both.
- Human-only approve and waive keep `disable-model-invocation` on their skills. A script that opens files itself is not covered by deny rules (the official README says the same); the boundary is CI: `check --at ci` already refuses approval and waiver rows added by a PR unless an independent reviewer approves the head commit, and recomputes every verdict from the base branch's checker and config. DESIGN §10 already states this ("CI plus branch protection is the boundary"). Document that in the README's Safety section.

Registered hooks after R1: `SessionStart` (context), `UserPromptSubmit` (turn baseline), `Stop` (the one blocking gate), `SubagentStart` and `SubagentStop` (async, observational, R10), `PostToolUseFailure` for the Skill fallback (kept until D2 settles chaining). No hook runs per Bash or Edit call.

Tests: a repo whose `settings.json` lacks a deny rule is reported by `preflight`; deleted-module imports are gone (`tsc`, existing size test); the Stop gate and baseline tests still pass; a scenario test confirms an Edit to a denied evidence path is refused by the permission rule (using Claude Code's `--permission-mode dontAsk` in a recorded run, not a mock); the non-test source ceiling test (≤ 5.0k at v0.7) is added.

Risk: the model can write evidence through a shell script. Accepted and documented: CI recomputes everything, so tampered local evidence cannot reach the trunk. This is the trade the official plugin makes.

### R2. Stamp, don't re-run

Proof stays single and fresh, as in the official `verify`: `verify` runs from the declared commands once, writes `verification.md`, and now adds `tree: <sha>` to its front matter, where `tree` is the sha of `HEAD`'s tree plus `git diff HEAD -- . ':(exclude).sdlc'` plus fingerprints of untracked files outside `.sdlc/` (the existing `snapshot()` fingerprint, minus `.sdlc/`). `verify` also runs the declared `full` commands (deduplicated by normalised command, as it already deduplicates levels), so one run covers everything ship used to re-run.

Later gates check the stamp instead of re-running:

- ship gate: `verification.md` `result: pass` and `tree` equals the current tree, else `not shipping: the tree changed since verify; run /rig:test <slug>`. The `full` commands are no longer re-run at ship.
- `quality` (sensors node) writes its tree stamp into `ratchet.json`; ship and pre-push compare it instead of calling `runQuality` again (`pr.ts:104` is removed).
- pre-commit keeps running the `fast` commands on the staged diff (cheap, already budgeted); pre-push checks the two stamps.
- Red-proof on the base still runs once, at ship, because it is the one check that cannot be stamped on the branch tree (it is the official plugin's canary idea: prove the tests can fail).
- CI re-runs everything and reads no stamp. No cache, no TTL, no volatile list, no key schema.

Tests: ship refuses after any tracked edit, an untracked file, or a change to `sensors.json` after verify; passes with a matching stamp without executing the declared commands (spy on `runCommand`); `.sdlc/` churn does not change the tree stamp; CI path ignores stamps; a test counts command executions across a full change (target above).

### R3. One model review per change; sharded when large

- **build slices.** Tier S and M: no model review. A slice is done when `ratchet record build --slice N --checks` verifies, by script, that the slice's tests are green, `check --at stop` has no block and the diff is inside `## Files`. The model never self-certifies the row. Tier L: one `rig:reviewer` slice review with `model: sonnet`.
- **pr-review.** S/M with the CI workflow: CI review only (as today). S/M otherwise: one `code-review medium`. Tier L: one whole-diff review. If the diff exceeds one shard (R8 bounds) it runs as the plugin workflow `workflows/review.js`: shards by scope in batches of 8, one `rig:reviewer` per shard, one Sonnet referee per finding that drops what it cannot re-derive from the cited lines, merged into `review.md`. The skill prints the shard count before launching and asks when it exceeds 8, as `extract-rules` does. A stopped run resumes with its run ID. Without the Workflow tool it falls back to the same shards run as plain subagents, as the official plugin does.
- `security-review` runs only when `intent.md` risks name auth, payments, data, secrets or a public API.
- A model re-review after a fix runs at most once, on the fix diff only.

Files: `skills/build`, `skills/pr-review`, `scripts/ratchet.ts`, new `workflows/review.js` (declared in `plugin.json` `workflows`), `agents/reviewer.md` (data-not-instructions line, mode slice runs on the caller's model).

Tests: `record build --checks` refuses red or missing tests, a stop block, an out-of-plan edit; refuses model text as the verdict; the S/M build path contains no model review call; the workflow script's shard batching is pure and unit-tested; referee drops a finding with a bad citation.

### R4. One base-tree helper

`scripts/basetree.ts` exports `withBaseTree(base, { sparse?: string[] }, fn)`. `quality.ts` (`baseCounts`) and `check.ts` (`proofOnBase`) both use it, with one `DEP_DIRS` constant (`check.ts` omits `venv` today). Always removed and pruned. Full checkout by default; with `scopes` (R8) and `scopes.sparse: true`, `git worktree add --no-checkout` plus cone sparse-checkout of the affected scopes, their declared dependency closure and root files (measured: 6.3 s to 0.36 s on 50k files). Sparse is opt-in because Maven reactors and workspaces fail on partial trees.

Tests: the worktree is removed on success, failure and timeout; `venv` linked; sparse fixture checks out only the listed directories.

### R5. Batched, diff-only test count

The invariant becomes: tests in the diff only; base side by one `git cat-file --batch`; branch side from disk; block when the delta is negative. Equal to the whole-repo comparison because untouched files count equally on both sides (measured: 8.9 s to 0.41 s per 2,000 tests).

Tests: parity with the old function on a seeded repo (removed, renamed, deleted and added test files); one process spawn for N files.

## 6. v0.6.0

### R6. Preflight inside `init`

`sdlc.ts preflight` (called by `init`, re-runnable) is the official `preflight` shape, scaled to what rig needs. **Every check runs; one complete report** goes to `.sdlc/PREFLIGHT.md` with a pass, fail-with-exact-fix, or skip per line, and open items for anything it could not decide. It runs once per repo, and `/rig:start` tells you to run it if the file is missing; it is not a per-change gate and not a stage.

| Check | Rule |
|---|---|
| Stack | Detected from manifests and extensions. |
| Toolchain | The required version is read from the build's own source of truth in this order: `.tool-versions`, `.nvmrc` or `.node-version`, `package.json` `engines`, `go.mod`, `.python-version` or `pyproject` `requires-python`, and for Maven the effective `java.version` or `maven.compiler.release` resolved up the `<parent>` chain. The host passes when it satisfies that minimum. A different version in some other manifest is a warning. |
| Commands, proven on this code | Each declared `fast`, `levels` and `quality` command resolves (first token on PATH, or the package script, Makefile target or wrapper exists). `init`'s existing baseline run of `fast` and `levels` supplies the proof, recorded in the file; nothing new executes. |
| Base and remote | `defaultBase()` resolves; tree clean outside `.sdlc/` (warning otherwise); `git ls-remote --heads origin` with a 10 s timeout. On an SSH auth failure, one retry over HTTPS. No other sync exists, so nothing repeats. |
| Consumers | Every declared `consumers[].path` is a git repo; all missing ones listed with the `git clone` command. |
| Protection | The deny rules from R1 are present (as the official check 7). |
| People | The three questions `init` already asks (gates, value rate, consumers) are recorded verbatim in an **Answers** section; unanswered ones become open items. No new questions. |

Tests (fixture repos): Maven with a parent POM at Java 21, a manifest at 25 and a host at 21 passes with a warning; a host below the parent minimum fails with the fix; `.nvmrc` mismatch; an undeclared script; an unreachable SSH remote retried once over HTTPS; three missing consumers reported in one run; a missing deny rule reported; every check runs even when the first fails.

### R7. `status` staleness and the three lines

`status` (read-only, as the official `status`) lists, per stage, the artifact and its file time, and flags stale ones: `design.md` older than `intent.md`; `plan.md` older than `design.md`; `verification.md` whose `tree` stamp differs from the current tree; `PREFLIGHT.md` older than `sensors.json` or a build manifest. It lists open items found in `intent.md`, `design.md` and `plan.md` (`## Open questions` not `none`). It ends with **Where you are / What is stale / Next command**. Design and plan approval already refuse open questions; the same refusal is added for `intent.md`. No state is stored.

Tests: each staleness rule; a change with no stored status file computes the same result as one with it deleted; open intent question blocks approval.

### R8. Scopes and shards

`sensors.json` gains optional `scopes`:

```json
"scopes": {
  "packages/api/**":    { "name": "api",    "root": "packages/api",    "fast": {...}, "full": {...}, "levels": {...}, "quality": {...}, "deps": ["packages/shared/**"] },
  "packages/shared/**": { "name": "shared", "root": "packages/shared", "fast": {...} }
}
```

Value shapes match today's top-level keys and run with `cwd = root`; top-level keys remain the fallback.

**Selection.** `selectScopes(diffs, config)` is pure: each changed file maps to its longest matching glob; the affected set is those scopes plus every scope that lists one of them in `deps`, transitively. An optional `affected` command (turbo, nx, `pnpm -r` or similar, declared in the protected config) may add names; unknown names are ignored with a warning. Files matching no scope fall back to the top-level commands and warn `unscoped`.

**Where it applies.** Stop `fast`; `verify` and its levels; `quality` on both sides, counting only affected scopes; red-proof's test command; pre-commit. CI uses the same selection from the base branch's config and also runs the fallback whenever an unscoped file changed; `ci.scope: "all"` forces everything. A diff spanning more than `scopeLimit` scopes (default 3) is re-tiered to L by the `tier` sensor, with the reason printed.

**Shards.** `sdlc.ts shards <slug>` prints the diff split by scope into shards of at most 25 files and 5,000 changed lines (the official `make_shards.py` bounds), small shards of one scope merged, ordered by scope. It is the input to `workflows/review.js` (R3). Without scopes it splits by top-level directory.

Edits that remove a scope glob or a `deps` edge are weakening edits, already detected by `weakensConfig` and extended here.

Tests: overlapping globs; transitive `deps`; an unscoped file; an `affected` command naming an unknown scope; quality counts only affected scopes; CI fallback; weakening detected; shard bounds on a fixture with a 60-file diff; a repo without `scopes` behaves as v0.5.0 (golden test).

### R9. Slice checkpoints

After `ratchet record build --slice N` returns `done`, the script commits that slice itself on `sdlc/<slug>`: `git add` of changed files inside the plan's `## Files`, `git commit --no-verify -m "sdlc/<slug>: slice N"`. Never on the trunk, never a push, no squash (teams squash at merge; the official plugin likewise leaves commits to the person). A failed commit leaves the slice not done. `planProblems` warns when a slice lists more than 5 files. A partial implementer reply (stopped at `maxTurns`, no `Status:` line) is recorded only if the slice's checks pass; otherwise the same agent is resumed once, then the node blocks.

Tests: the commit holds only plan files; none on trunk; a killed session leaves committed slices that `ratchet show` lists as done; the 6-file warning.

### R10. Lane events

`SubagentStart` and `SubagentStop` become `async: true` command hooks that append a `lane` event (agent, start, duration, whether it reported) to `events.jsonl`, as the official telemetry hooks are async and observational. `scorecard` adds work (union of command and lane intervals), span (first to last event) and idle (gaps over 15 minutes). They run in `-p` and CI, so headless numbers exist.

Tests: overlapping lanes counted once; a 3 h gap is idle; the hooks are `async` in `hooks.json`; a headless fixture yields the numbers.

### R11. Size block at Stop

In the Stop gate, a file at or under `limits.fileLines` at the turn baseline that crosses it now blocks (waivable). Already-large files still warn. This replaces the per-edit check removed in R1 and still lands before review.

## 7. v0.7.0

### R12. `init --monorepo`

Detects npm, pnpm or yarn workspaces, `go.work`, Maven `<modules>`, `nx.json`, `turbo.json`. It generates, at zero tokens: a root `CLAUDE.md` of at most 60 lines (workspace table, commands); a `CLAUDE.md` of at most 15 lines per package from its manifest, skipped if one exists; a proposed `scopes` block with `deps` from the workspace graph the tool already declares; settings merged into `.claude/settings.json`: `Read` deny rules for detected generated and vendored paths, `worktree.sparsePaths` and `symlinkDirectories`. It prints, but does not write, the personal `claudeMdExcludes` suggestion and the language-server plugin install line per detected language (`/plugin install typescript-lsp@claude-plugins-official` and equivalents), since those are user-level. It replaces the three whole-repo scouts in monorepos; `/rig:init <package>` can enrich one package with one Haiku scout. Existing files are never overwritten.

Tests: npm, Maven and Go fixtures produce the expected stubs, `scopes` and settings; a re-run changes nothing; deny rules do not match source files.

### R13. Fewer model turns

Skills pre-run `next $0 --json` with the `!` injection; node-finishing commands end with `Next:` themselves, so the closing `next --json` call is dropped; boilerplate repeated across skills moves to the `SessionStart` rules block. A test asserts the duplicated lines are gone and total skill bytes shrink by at least 15%.

## 8. Email failure modes: closure matrix

Each row has a regression test that fails if the guard is removed. "Not by" names the old-harness mechanism that must not be used.

| # | Email problem (evidence) | Guard | Not by | Test |
|---|---|---|---|---|
| E1 | Fix loops far past their limit (20.2 h, 5 stories) | Ratchet caps stay; R2 means a loop cannot re-run an identical verified tree | More loops or learned rules | Existing cap tests; verify-once count test |
| E2 | Agents run out of context and lose work (10.3 h; 22 findings; 9 of 15 stories) | R3 shards ≤ 25 files and 5,000 lines; R9 checkpoint commits; ≤ 5-file slices | Bigger windows | R3, R9 tests; killed-session fixture resumes |
| E3 | Gates fail then re-run (5.7 h) | R2 stamp checks at ship and push; sensors are scripts | A result cache | R2 spy test |
| E4 | Preflight blockers: Java check, fetch, clones, prototype path (13 of 22 runs, zero code written) | R6 `PREFLIGHT.md`, every check runs, exact fixes, one retry | Jira, Bitbucket or fleet-specific steps | R6 tests |
| E5 | Restart with questions unanswered (21 unmet ACs) | Intent recorded once; R7 lists open items; design, plan and intent approval refuse open questions | Cross-change `depends:` | R7 tests |
| E6 | 44% idle or untimed (lanes, review-fix loops, runs left open) | R10 lane events, span ends at last event, R7 last-activity | A run clock that must be stopped | R10 tests |
| E7 | Learned rules loaded wholesale | Not built | Any rule loader | Documented; none |
| E8 | Repo sync three times in one run | R6 is the only remote check, once per repo | A per-change sync step | R6 tests |
| E9 | File growth found at review | R11 block at Stop | A per-edit hook | R11 tests |
| E10 | `features.json` stale after merge | Status derived from files | A stored status list | R7 derivation test |
| E11 | The 200K ceiling as top cause | E2 guards, R3 one review, R13 fewer turns, README note on the status line context meter | n/a | R3, R13 tests |

One scenario test (`scripts/scenario.spec.ts`, fixture repo) covers E2, E4, E5 and E8 together: start a change with a toolchain mismatch and a missing consumer clone (preflight lists both with fixes), satisfy them, kill the implementer mid-slice, resume from the checkpoint, and assert the declared test command ran at most twice on the final tree (verify, then red-proof on base).

## 9. Decisions to confirm

- **D1. Guard layer deletion (R1).** The largest call. It removes about 550 lines and every per-call hook, accepts that a shell script can bypass local deny rules, and relies on CI recomputing everything. It follows the official plugin and DESIGN §10's own conclusion. Veto here and R1 shrinks to the hook-count reduction only.
- **D2. Chaining.** Official commands stop and print the next command; rig chains nodes unless `/rig-run` drives. Proposed: stop by default, chain only under `/rig:run` (which uses `/goal`). Cost: more "continue" prompts for people not using `/rig:run`.
- **D3. Standalone vendoring.** The official plugin is installed, never copied. rig vendors its checker so CI can load it from the base branch. Proposed: keep for v0.5 and revisit once CI can pin the plugin by commit.
- **D4. Review shards use Opus reviewers and Sonnet referees** at tier L. A cheaper split is possible if a measured run shows no quality loss.

Earlier decisions stand: monorepo toolchains first are npm/pnpm/yarn, Maven, Go; proving ground is the generated fixture (`scripts/fixture-monorepo.ts`, never committed) plus a real repo when available.

## 10. Measurement and open items

Same three tasks before and after: a tier S bugfix, a tier M feature, and a tier L change in the generated 40-package, 50k-file fixture. Gated counts: hook processes per tool call, command executions per change, worktrees, process spawns, shard sizes. Reported: wall-clock, work/span/idle, dollars (interactive runs only; headless records $0, DESIGN §11). Not verified and not depended on: `autoCompactWindow` from project settings. Still open from DESIGN §11: the mod's interactive parts have never been checked by a person; git hooks have not been trialled live.
