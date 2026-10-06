# Proposal: do each thing once, and scale to monorepos (rig v0.5)

> **Superseded by `docs/superpowers/specs/2026-10-06-do-it-once-and-scale-design.md` (draft 2).** The evidence and measurements below still stand. The tree-keyed run ledger, per-change preflight and monorepo `depends:` ideas were replaced by patterns from Anthropic's code-modernization plugin.

Status: draft for approval. No code written. Path: architectural (changes how verify, sensors, ship and init relate), so approval of this note permits a written spec, then a plan.

## 1. Understanding (please correct)

- **Goal:** rig should be cheap, fast, and never repeat work on the same task, and it must stay usable on monorepos and large repos.
- **Constraints:** stay thin (no growth in scope; every addition pays for itself or deletes something); follow Claude Code best practices and the large-codebase guide; borrow the code-modernization plugin's habits (state in files, one artifact per command, scripts compute verdicts, a cheap preflight before expensive work).
- **Success:** fewer duplicate test, quality and review runs per change; hooks that stay fast as the repo grows; a monorepo change that runs only the affected package's checks; all measured before and after on the same tasks.
- **Assumed, not told:** the `stuff.eml` page describes an *older* scaffold (`/auto`, `/test`, Jira, Java services), not rig. I use it as a catalogue of failure modes and check each against rig's code.

## 2. What the email says, mapped to rig

Source: 33 runs, 166 h. 42% productive, 13% avoidable rework, **44% "open but not measured"** (mostly runs left open or waiting for people; 3 runs hold 64%). Most of that idle time is wall-clock, not harness work: harness changes will not shrink it, only measure it honestly.

| Problem in the email | Hours / reach | In rig today |
|---|---|---|
| Fix loops past their limit (8-9 attempts vs 2) | 20.2 h, 5 stories | **Covered:** ratchet caps rounds and stalls; past a cap the finding blocks |
| Agents run out of context (200K) and lose work | 10.3 h, 9 of 15 stories; top cause (22 findings) | **Partly:** briefs ≤ 60 lines, Sonnet implementer, `maxTurns: 60`. **Gap:** `build` never commits per slice, so a dead session leaves uncommitted work and no checkpoint; no lane-size cap |
| Gates failing and re-running | 5.7 h | **Partly:** sensors are scripts, but the same checks re-run at five points (§3) |
| Preflight blockers (Java version, git fetch, missing clones, prototype path) | 13 of 22 `/auto` runs stopped, 0 code written | **Gap:** rig has no preflight. A broken toolchain shows up at the first `verify`, after the build |
| Restart with questions unanswered | all 21 unmet ACs | **Partly:** design gate is human-approved once, and plans may not carry unresolved gating questions (DESIGN §8); no restart guard found in `graph.ts` |
| Learned rules loaded wholesale | up to 16.3 h recoverable | **N/A:** learning loop removed in v0.4.x; stays out (ROADMAP v3 rule) |
| Timing gaps (untimed lanes, runs left open) | 73.7 h | **Gap:** `runs.jsonl` records ms per command, but there is no active-vs-span view |

## 3. Where rig repeats work (verified in code)

| Operation | Runs at | Times per change | Reused today? |
|---|---|---|---|
| Declared test command | slice `run`, Stop (`fast`, each turn with a new diff), `verify`, ship (`full`), red-proof on base (sanity + run), pre-commit, pre-push, CI | **6 to 8** on near-identical trees | No. `runs.jsonl` rows hold `at, cmd, cwd, exit, ms, tail, source`: nothing about the tree |
| Quality counts (lint, types, deps, coupling, security) | `sensors` node, ship gate (`pr.ts:104`), pre-push | 3, branch side each time (base side cached per SHA) | Base only |
| Test-count invariant | every `runQuality` | 3 | No; it reads **every test file** via one `git show` each |
| Base checkout | `baseCounts` (quality) and `proofOnBase` (red-proof) | 2 full worktrees of the *same* base SHA | No |
| Model review | per slice (`build` step 3.2), `pr-review` (`code-review high`, plus `security-review` at tier L), CI `rig-review` | S/M: 2 (slice + CI). L: 3 to 4 (slice Opus + pr-review + security + CI), plus a re-review after every fix round | DESIGN §2 says "one inferential review per change"; the code does not |
| Orientation | every skill: `next --json` first, `next --json` and `skill next` last | 3 extra Bash turns per node; each turn re-reads the whole context from cache | n/a |
| Hook process | every prompt, Bash call, edit (twice), stop | ~120 ms each (5 runs: 0.595 s) vs 17 ms for bare `node`; harmless alone, ~24 s of CPU across 200 tool calls | n/a |

Not a problem (measured): the per-prompt snapshot (`git stash create` + untracked scan) takes 0.17 s + 0.15 s on a 50,000-file repo. Do not spend effort there until a repo is 10x larger.

Checked and fine: `CLAUDE_CODE_SUBAGENT_MODEL` in the template does **not** override the Opus reviewer or Haiku scout (frontmatter ranks above the env var, per the sub-agents doc).

## 4. Where rig does not scale (verified)

Nothing in `scripts/` mentions workspaces, packages or monorepos. Consequences:

1. **One whole-repo command per check.** `fast`, `full`, `levels` and `quality` are single strings in one root `sensors.json`; the shipped stack templates are `eslint .`, `tsc --noEmit`, `semgrep scan`, `npm test`, `radon .`. In a 40-package repo a one-line edit triggers the whole-repo command at every Stop, twice per sensors round (branch + base), and at ship.
2. **Full checkouts for the base.** 50k files: full `git worktree add` 6.3 s vs 0.36 s sparse (measured). Done twice (quality + red-proof).
3. **O(tests) process spawns.** 2,000 `git show` calls take 8.9 s; one `git cat-file --batch` takes 0.41 s (measured). Run at every quality round.
4. **Onboarding sweeps the whole repo.** `init` runs three scouts over the entire tree and writes one root `CLAUDE.md` (≤ 120 lines). The large-codebase guide says the opposite: layered per-directory files, loaded on demand, plus excludes and read-deny rules. `templates/settings.json` denies only `.env`.
5. **No code-intelligence setup.** The scout can use LSP, but `init` never recommends or installs a language-server plugin; the docs name this the main cut in file reads.
6. **Impact is cross-repo only** (`consumers`). There is no notion of "the packages this diff touches".

## 5. Options for the core approach

**A. Ledger + scopes (recommended).** Add (1) a tree-keyed run ledger so identical work is never repeated locally, and (2) `scopes` in `sensors.json` so every check runs only for the packages a diff touches. Plus the cheap fixes in §6. No new subsystem; about +250 / −150 lines.

**B. Delegate to the repo's build tool.** Single `affected` command (turbo, nx, bazel, `mvn -pl -am`) that rig calls and trusts. Smallest code, but rig then depends on tools many repos lack; keep it as one *scope source* inside A, not the design.

**C. Rebuild the dependency graph in rig** (the old wiki's approach). Rejected: the ROADMAP records why it was removed (regex edges, per-language tables, ~2,700 lines).

## 6. Ranked changes (recommended path A)

| # | Change | Saves | Size | Risk |
|---|---|---|---|---|
| 1 | **One model review per change.** In-session: no per-slice model review; slices are judged by sensors and tests only. One Opus review of the whole diff at tier L; S/M rely on CI `rig-review` when installed, else one `code-review medium`. Drop `security-review` unless risk names auth, payments, data or secrets. | The largest token item (reviews were the biggest cost in both datasets); 3-4 passes → 1-2 | −60 lines of skill text | Medium: per-slice review catches defects early. Mitigate: keep the slice review for L only, on Sonnet |
| 2 | **Tree-keyed run ledger.** Key = sha(normalized command, sensors.json hash, tree SHA, untracked fingerprints). `verify`, `quality`, ship and pre-push read it; a passing row for the same key is reused and noted in `verification.md`. Stored in sdlc-written evidence. **CI never reads it** and always re-runs (the existing "CI is the judge" boundary). | Test suite 6-8 runs → 2 (red + green) plus CI | ~120 lines in `runs.ts` | Medium: a wrong key hides a failure. Tests: any edit, config change or untracked file invalidates |
| 3 | **Scopes.** `sensors.json` gains `scopes: { "<glob>": { fast, levels, quality } }`; the checker picks scopes from the diff (largest wins; a diff spanning > N scopes bumps to tier L as a contract-like change). Optional `affected` command as a scope source (option B). Quality counts and the test-count invariant are computed on changed scopes only, both sides. | Monorepo: whole-repo → affected packages | ~150 lines in `sensors.ts`/`quality.ts` | Medium: a mis-scoped diff skips a check. CI keeps the whole-repo `full` |
| 4 | **One shared base worktree per base SHA**, sparse by scope plus the dependency closure (opt-in, because Maven reactors and npm workspaces break on a partial tree); dep dirs linked once (`DEP_DIRS` differs between `quality.ts` and `check.ts` today: `venv` is missing from one). | 6.3 s → 0.4 s per base checkout, and one instead of two | ~40 lines, net negative | Low |
| 5 | **Batch the test-count read** (`git cat-file --batch`, diff-only counting). | 8.9 s → 0.4 s per 2,000 tests, ×3 per change | ~25 lines | Low |
| 6 | **Preflight, once** (from code-modernization): `sdlc preflight` is a script, zero tokens, cached by HEAD + config hash. Checks toolchain vs manifest, `fast`/`levels` commands actually start, base resolves, remote reachable, declared consumer clones present. Runs at the first `/rig:start` of a tier M/L change. One answer at most; no retries, no per-run stage. | Fails fast on the "13 of 22 runs, 0 code written" class | ~80 lines | Low |
| 7 | **Fewer model turns per node.** Skills pre-run `next --json` with the `!` injection instead of a Bash turn; scripts print the final `Next:` line themselves; one shared rules block replaces the boilerplate repeated across 15 skills. | ~3 Bash turns × every node, each re-reading context | −150 lines of skill text | Low |
| 8 | **Checkpoint per slice.** `build` makes a WIP commit on `sdlc/<slug>` after each recorded slice (squashed at `/rig:pr`); `plan` lint warns when a slice lists > 5 files. Answers the email's #1 cause (context exhaustion before commit). | Lost-work restarts | ~30 lines | Low |
| 9 | **Monorepo onboarding.** `init` detects workspaces (npm/pnpm/yarn, go.work, Cargo, Maven modules, nx/turbo) and, instead of three whole-repo scouts: root `CLAUDE.md` ≤ 60 lines; per-package `CLAUDE.md` stubs written lazily on first touch (one Haiku scout per package); `Read` deny rules for generated and vendored paths; `claudeMdExcludes` suggestions; an LSP plugin recommendation; `worktree.sparsePaths`. | Context per task; file reads | ~120 lines in `init` + skill | Medium: lazy stubs need a first-touch trigger (existing guide-injection hook) |
| 10 | **Hook startup.** Lazy-import per hook subcommand; `if` filters on `PostToolUse`; measure again. Low priority. | ~100 ms per hook | ~30 lines | Low |

Not doing: wiki, learning loop, a per-run preflight *stage*, a `bin/rig` wrapper. The wrapper looked like a prompt-shortener, but the approve/waive guard (`HUMAN_ONLY`, `OBFUSCATED_HUMAN`), `isSafeEvidenceCommand`, auto-approval and every skill's `allowed-tools` match on `sdlc.ts`; a bare `rig approve` would slip past the guard, a plugin `bin/` blocks claude.ai and Cowork installs, and standalone mode (the default) would not use it. Revisit only with the guard rewrites listed as part of the change.

Also optional: move the in-process mod (`hooks/*.tsx`, ~650 lines) to a companion plugin so core carries no UI code.

## 7. Borrowed from code-modernization (and left behind)

Borrowed: cheap preflight with a short list of questions only a person can answer; state read from files, never chat; `verify` computes a verdict from captured exit codes (rig already does); sharded fan-out only for heavy steps; telemetry as counts only.
Left behind: 12 commands and 8 agents (rig has 15 skills and 4 agents and should shrink, not grow); a rendered HTML report; portfolio mode.

## 8. How we prove it

Before and after on the same three tasks (tier S bugfix, tier M feature, a tier L change in a synthetic 40-package, 50k-file monorepo): count of test-command runs per change, model reviews per change, peak context, active vs span minutes, dollars. Pre-commit budget: hooks ≤ 150 ms; `quality` ≤ 10 s on the monorepo fixture. The fixture is generated by a script, not committed.

Headless `-p` runs currently record $0 (DESIGN §11), so dollar claims need that capture fixed first or must come from interactive runs. `autoCompactWindow` from project settings is still unverified (DESIGN §11), so no "compact earlier" recommendation until checked.

## 9. Open questions

1. **Reuse boundary.** OK that the local ledger reuses a passing run for an identical tree, while CI always re-runs everything?
2. **Per-slice review.** Drop it for S/M and make it Sonnet-only for L (change 1), accepting later defect discovery in exchange for cost?
3. **Monorepo toolchains in scope.** Which should the first release support: npm/pnpm workspaces, Maven modules, Go, Python? That decides which `scopes` templates and detectors ship.
4. **Proving ground.** Is there a real monorepo (or the Prism/MAGENTA repos) to run the "after" measurement on, instead of only the synthetic fixture?
5. **Ordering.** Ship 1, 2, 4, 5 first (no config change, mostly deletions and caching), then 3, 6, 8, 9?
