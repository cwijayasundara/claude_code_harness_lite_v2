# rig: design

Why the harness is shaped the way it is, and what each part costs. Per-release changes are in [CHANGELOG.md](CHANGELOG.md); the trial runner, trial transcripts, plans and specs are in git history (before the commit that trimmed this file). Code is the reference for behaviour.

## 1. Why: evidence from the last build

The "Prism" build (`edm_sementic_layer_v2.0`, 2026-09-30 to 10-02, 356 transcripts) cost about $525-554 for 785M tokens. It was plain Claude Code plus two plugins acting as an unplanned harness (superpowers for process, security-guidance for reviews).

| Fact | Number |
|---|---|
| Share of spend that was cache *reads* of long contexts | 57% |
| Spend on turns with more than 150k context | 50% |
| Opus subagent vs Sonnet subagent, per run | $2.83 vs $0.36 |
| Retry, fix-wave and re-review agents | $64 |
| security-guidance auto-reviews (141 runs, Opus xhigh) | $79 (14%) |
| Cache rebuilds after idle (sleep-polling) | $49 |
| Human prompts that were "continue / yes" | 42 of 117 |
| Plans written (full code embedded) | 880 KB for 12.8k LOC of source |
| Wall time: active vs span | 23.7 h of 79.5 h (a sleeping laptop) |

The biggest lever is **bounded context**. Everything below follows from that.

## 2. Principles

1. **Thin layer, built-ins first.** Own five things: the artifact chain, human gates, guardrails, routing and budgets, measurement. Plan mode, `/code-review`, `/security-review`, `/goal` and worktrees are Claude Code's.
2. **Ceremony scales with risk.** Routing is type × tier; gates come from risk, not size.
3. **State lives in files, not chat.** `.sdlc/changes/<slug>/` is the memory; status is derived from which files exist.
4. **Humans gate; models never self-approve.** Approval and waiver are human-only skills; approvals go stale when the artifact changes.
5. **Deterministic checks decide; models advise.** Sensors, red-proof, scope and secrets are scripts at zero tokens; one inferential review per change.
6. **Local equals CI.** One `check` entry point serves Stop, plan, ship, git hooks and CI. CI judges a PR with the base branch's checker and config, so a PR cannot weaken its own judge.
7. **Right model for the job, pinned.** Sonnet main thread; the role and the tier pick each subagent's model and effort (`scripts/routing.ts`): Haiku reads (scout, researcher, triage), Sonnet writes code (Haiku at tier S), Opus plans and reviews tier L, and reviews never run on Haiku. Skills pass `routes` from `next --json`; a per-role floor clamps every override and retry. No skill sets `model:` (a switch re-reads the context uncached). The one sanctioned mid-session switch is budget downshift: an Opus main loop moves to pinned Sonnet once under pressure and stays (spend governance spec §7).
8. **Bounded loops.** Review rounds, Stop blocks and spend are capped; past a cap the finding goes to `unresolved.json` and ship refuses it.
9. **Every step ends with the next command.**

## 3. Architecture

```
skills/      the stages, /rig:* (start intent design spec plan diagnose build test sensors pr pr-review
             incident next init rule metrics), prompts only
agents/      scout (haiku, read-only) · researcher (haiku, docs; WebFetch and WebSearch only) · architect (opus) · implementer (sonnet) · reviewer (opus)
             Each launch overrides the agent file's model and effort with its route.
hooks/       hooks.json = five settings hooks plus two async lane hooks (`SubagentStart`, `SubagentStop`, observational), none on Bash (work in -p and CI) · register.ts = the optional mod
scripts/     zero-dependency Node, no build step; sdlc.ts is the CLI; check.ts is the one checker
templates/   CI workflows (rig-check, rig-review), settings.json, stacks.json, REVIEW.md
guides/      contracts, engineering, testing: injected on first touch of a matching path
.sdlc/       the consumer repo's committed evidence (see §5)
```

- **Skills, not commands; agents for model routing.** Plugin agents ignore `hooks`, `mcpServers` and `permissionMode`, so an agent's limits are its `tools:` list; there are no per-agent gates.
- **Settings hooks vs the mod.** Settings hooks are portable and run in `-p` and CI, so every essential gate is one. The mod (band, panes, impact dialog, cost capture) is in-process and optional; nothing essential depends on it.
- **Standalone by default.** `vendor --standalone` copies skills, agents, hooks and scripts into the repo (`.claude/skills/rig-*`, `.claude/agents/rig-*`, `.sdlc/bin`), so a repo never depends on the plugin and a cloud session runs it as is. `/rig-approve` and `/rig-waive` are vendored skills with `disable-model-invocation` and a pinned `!` command; `$ARGUMENTS` is single-quoted because it is substituted raw.
- **Artifacts live in `.sdlc/`, not `.claude/`.** Claude Code protects `.claude/`: writes there prompt, or are denied in `-p`, and allow rules cannot change that.

## 4. Task routing (type × tier)

`/rig:start` classifies the request (asking at most two questions) and writes `intent.md` with `type:` and `tier:`.

| Type | Path |
|---|---|
| greenfield, feature | start → design (slices + tests) → build → test → sensors → pr → pr-review |
| refactor, migration | start → plan → build → … |
| bugfix, incident | start → diagnose (failing test first; plan gate at L) → test → … |
| chore | start → build → … |
| spike | read-only answer in `notes.md`; no gates |

| Tier | Rule of thumb | Human gates |
|---|---|---|
| S | ≤ 3 files, no contract or data change | none |
| M | ≤ 15 files or touches a contract | design (once, with the intent) |
| L | auth, payments, data, security, public API, > 15 files | spec, plan, design |

Gates are configured in `gates` in `.sdlc/sensors.json`. A `tier` sensor blocks an S or M change whose diff reaches contracts or auth, security, payments, billing or migration paths until it is re-tiered. The recorded tier and type are a floor: `intent.md` is model-writable, so the stricter of the two wins and only `/rig-approve <slug> tier` lowers it. For S and M the PR review runs in CI (`rig-review`) rather than in session.

## 5. Artifacts

```
.sdlc/
├── intent/          <name>.md  ideas before a change exists; status draft|accepted|closed (shipped is derived)
├── changes/<slug>/  intent.md  spec.md  design.md/plan.md (## Files, ## Slices, ## Verification; no code)
│                    verification.md (generated)  review*.md  runs.jsonl  ratchet.json  events.jsonl
│                    pr.md  ship.json  approvals/waivers rows
├── PREFLIGHT.md     advisory readiness report, written only by `sdlc.ts preflight` (per host; consider gitignoring)
├── sensors.json     fast/full commands, tests, gates, levels, quality, limits, layers, contracts, ratchet, value, scopes, points
├── rules.json       regex rules          guides/   bin/ (vendored checker)   STATE.md
└── (gitignored)     .gate  .baseline  usage.jsonl  unresolved.json
```

Evidence files (approvals, waivers, `runs.jsonl`, `verification.md`, `ratchet.json`, `events.jsonl`, `pr.md`, `ship.json`, `.gate`) are written only by sdlc. The template's `permissions` deny rules keep the Edit and Write tools off them and CI recomputes every verdict; a shell script can still write a file locally, so CI plus branch protection is the boundary. Plans must not contain code (this alone would have removed the 880 KB of plan text).

## 6. Token and time policy

| Lever | Mechanism |
|---|---|
| Bounded context | Small fresh contexts per subagent (`omitClaudeMd` on scout; briefs of ≤ 60 lines); `/compact` rather than a handoff skill |
| Sonnet main thread, Opus advisor **off** | Template sets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` (the advisor was a third of each run's cost; a user-level `advisorModel` otherwise still applies) |
| Cheap subagents | routed by role and tier: tier L code on Sonnet, not Opus; Opus only for tier L plans and reviews; Haiku for reading |
| One review per change | Findings below confidence 80 dropped; bounded fix rounds |
| No "continue" prompting | `build` ends with a ready `/goal` line; `/rig-run` drives one node per turn |
| Stamp, don't re-run | `verify` runs the plan's commands and the declared `full` commands once against the current tree and stamps `verification.md` with a tree stamp; ship and pre-push compare the stamp instead of re-running, and a stale stamp re-runs as before. CI reads no stamp |
| Scopes | With `scopes`, a diff runs only the touched scopes and their declared `deps` dependents, each in its root; the same command text in the same resolved directory runs once; shards group by scope; more than `scopeLimit` scopes re-tiers to L |
| Story points | S 5, M 7, L 11 (or an explicit number) kept in `ratchet.json`; `metrics` reports velocity per week and cost per point, unmeasured below five shipped changes |
| Lean plans | No code in plans; `status` warns past 120 lines |
| Plugin diet | Project `enabledPlugins` turns off unrelated plugins |
| Cloud for long builds | A cloud session keeps running while the laptop sleeps |

### Scopes, sparse base and preflight (v0.6)

- **Fail closed.** The optional `affected` command may only add scopes; if it fails or times out every declared scope is treated as affected, with an `unscoped` warning. `verify` with no resolvable base ref runs every scope, so a clean tree cannot stamp `full: pass` with nothing run. Scope roots must be relative and resolve inside the repo, else the scope is `not run`. `weakensConfig` flags removed scopes or `deps`, a raised `scopeLimit`, `ci.scope` moving to `affected`, a changed, removed or emptied scope command, a changed root, and, once the base declared scopes, a new scope glob missing a `fast`, `full` or `quality` command of a kind the base runs (top-level or in any scope).
- **Sparse base is opt-in and trusts `deps`.** The base is measured in a throwaway worktree with a cone sparse checkout of the affected scopes plus their `deps` closure; the patterns go to that worktree's own `info/sparse-checkout` and the user's `.git/config` is never modified; invalid roots or any sparse failure fall back to a full checkout. A scope tool that reads paths outside its declared closure can fail or over-count on the sparse base and hide a regression, so declare `deps` completely or leave `sparseBase` off. The base-count cache is keyed on scope root and sparse or full mode.
- **Preflight is advisory.** `.sdlc/PREFLIGHT.md` is denied to Edit and Write, but a Bash redirect could forge it, so no verdict trusts its `result:` line; only `status` staleness and the start skill read it. It checks the repo root only. Threat model for host probes: `java`, `go` and `python3` version probes run in the project root with `GOTOOLCHAIN=local`, so `go` never downloads a toolchain; a repo's version-manager config (`.tool-versions`, `.python-version`) could still point a shim at a repo-supplied binary, accepted as marginal because the harness already runs the repo's declared commands. SSH reachability reads `core.sshCommand` only from the user's global or system git config and runs `ls-remote` outside the repo, so a clone's own config never runs; the base-state check disables `core.fsmonitor`. A relative-path local origin reports not reachable. A repo set up before 0.6.0 fails the protection check until `init --full` is rerun.
- **Checkpoints.** The script commits a done slice with `commit --only` and literal pathspecs (deletions and renames handled), never pushes, never on the trunk; a failed commit reopens the slice and appends a `reopened` event.
- **Known limits.** `declaredCommandSet` omits scoped commands, so a scoped command is not recognised as declared by that check. When two scope keys dedup to one run, only the first key gets a finding. Scopes' own toolchains are not preflighted, and preflight's `commands` check resolves only the top-level `fast`, `full`, `levels` and `quality` commands, not scoped ones. With scopes declared, a source-less diff (docs or harness only) runs no scoped or top-level commands at edit, commit and CI; `verify`, which gates the ship stamp, runs the top-level commands.

## 7. Measurement

`metrics` reports the playbook's 12 leading and lagging metrics (from git, `gh`, approvals and incidents; `unmeasured` when n < 5) plus cost per change, stage and agent. Dollars come from the delta of the session cost ledger, which includes advisor and classifier calls; the scorecard adds spend against budget and an estimated value (`value` hours × rate). Cost capture needs the mod: headless `-p` runs record usd 0. Evals (`sdlc.ts evals`) are run by a person, never by CI: `eval_pass_rate` is the last run's pass share, and `incident_to_eval_hours` is how long an incident takes to become an eval. `inbox_survival` is the share of decided inbox ideas that were accepted or shipped (beside `intent_survival`, which counts changes past intent), and `intent_churn_after_design` is the median number of intent.md commits after the first design or spec commit. Eval definitions (`.sdlc/evals/*.json`) are protected harness files, since one can grant `claude -p` tools and run shell checks; `--seed` sanctions its own writes, and `/rig:diagnose` writes an incident eval with the person's approval. `repeat_findings` is the share of changes with findings whose category appeared on an earlier change: the "twice" rule's signal.

### Spend governance

Budgets add visibility and a light downshift, never a stop. Each clone publishes one rollup per month to `refs/rig/spend` (`<YYYY-MM>/<id>.json`, a random per-clone id; CI publishes `ci`), counting main rows only, because agent rows are already inside the main row's cost. Status sums every other clone's file plus this clone's fresh ledger; offline it uses the cached copy and under-warns rather than acting on bad data. Levels are notice, tight and over at 50, 80 and 100% (a projection only raises notice). The levers under tight: review roles one effort step lower with models and floors unchanged, and an Opus main loop moved to Sonnet. Opt-outs are human only (`budget.downshift: false`, `/rig-approve <slug> full-route`). There are no hard stops: round caps are untouched (a capped node needs a person) and `ratchet.usd` stays the separate runaway pause.

## 8. What the trials showed

Live, paid, one run per arm: treat as directional.

- **Cost.** About 4-7x plain Claude Code at the start, about 2x on small work after thinning (tier S: $0.31 vs $0.16), $2.50-2.87 vs $0.31-0.41 at tier L.
- **Value is assurance, not correctness.** Plain Claude Code passed most hidden tests but shipped an empty-key auth bypass in three of four tier L runs; the harness's Opus review caught it every time, and left a scoped commit, a gated spec and plan, and an audit trail.
- **Where savings should appear** is the long, large change (context bloat, Opus orchestration, fix waves). That is still unmeasured; the next trial is a Prism-sized milestone.
- **Defects the trials found, all fixed with tests:** verdicts must come from captured exit codes, not model claims; ship done means `ship.json` is committed; a path-scoped write permission must be an `Edit(...)` rule (`rig-review` had never worked before the first live PR); plans must not carry unresolved gating questions; `-p` skill chaining can silently drift, so a hook hands the model `sdlc.ts skill <name>`; headless sessions end while a background scout runs, so subagents run in the foreground.
- **Integration and scenarios.** Onboarding plus one change passes 8/8 and 8/8 ($0.74); greenfield, tier L bugfix and tier M refactor scenarios pass 12/12, 11/11 and 11/11 ($0.43-2.16). Onboarding the real Prism repo cost $1.28 in 233 s.
- **Autonomous ratchet trial (2026-10-04).** 14 headless runs, $3.64. 7 permission denials after plan approval (target 0, missed), then a fix wave; a re-run to confirm is pending.

## 9. Autonomous ratchet (v0.4)

Since v0.5.0 declared commands prompt unless Claude Code runs in auto mode or the user adds their own `permissions.allow` rules; unattended builds depend on that until `init` writes those rules.

`graph.ts` holds the per-type paths, per-tier gates and `step()`, which says continue, stop for a human, or block, and why. State is `ratchet.json` plus `events.jsonl` per change (evidence, sdlc-written). Build runs slice by slice with a bounded review loop; `levels` (unit, integration, acceptance, api) and `quality` commands (lint and similar, run on the branch and a base worktree, only a worsening blocks, else `unmeasured`) feed the test and sensors nodes; `/rig:pr` commits, pushes and opens the PR; `/rig:pr-review` reads it fail-closed. `/rig-approve <slug> budget` is the only way to raise a cap.

**No auto-approval and no Bash hook.** The guard layer (the `PreToolUse` hooks for Bash and Edit, the `SubagentStart` and `SubagentStop` gates, auto-approval and the read-only Bash allowlist) was removed in v0.5.0. `permissions` deny rules in `templates/settings.json` keep the Edit and Write tools off pure evidence; `ask` rules make a person confirm edits to `sensors.json`, `rules.json`, `.claude/settings.json`, `.sdlc/bin`, the git hooks, the mod, the guides, the `rig-check` workflow and CODEOWNERS. `CLAUDE.md` is deliberately not on the list (`init` writes it with the Write tool). Rules are evaluated deny, then ask, then allow, so the template's `allow: Edit(.sdlc/**)` is overridden by the more specific `ask` and `deny` rules; case-folded paths on case-insensitive file systems are not covered. The model can still run `SDLC_HUMAN=1 ... approve` through Bash; CI refuses approval rows a PR adds unless an independent reviewer approves the head commit. **Never self-approved:** approvals, waivers, budget raises.

**Sensors and test are never self-certified.** `ratchet record` refuses those nodes; `quality` and `verify-report` record them because they measure. The ship gate re-measures quality only when the sensors stamp is stale (the tree changed after the sensors node). Tier S and M build slices are script-checked (`ratchet record build --checks`: a green declared run on the current tree, no scope drift, no sensor block); tier L keeps a Sonnet slice review, which is model-self-certified and only paces the build. Test levels, sensors, the ship gate and CI are what a change must pass.

**CI never accepts a harness waiver from the PR**: a `harness-tamper` finding cannot be waived at CI, so a harness change lands on the trunk first as its own reviewed change.

Known limits: quality is compared at ship, not in CI, and reads `unmeasured` with no base (on trunk). Run autonomous builds in Claude Code's sandbox: declared test commands run model-written code. Defaults leave tier S and M ungated, so an autonomous build starts once `plan.md` exists.

## 10. Git hooks (spec 5)

Git is the common layer for every editor, agent and person, so `hooks install` sets `core.hooksPath` to the committed `.sdlc/githooks/` (POSIX `sh`, running the vendored checker). `check --at commit` runs the Stop sensors on the staged diff plus the fast commands; `check --at push` runs the ship checks and the quality ratchet against CI's base (merge-base with the trunk), within `githooks.budgetMs`; for a non-ad-hoc change pushed from a clean checkout whose tree stamp matches `verification.md` and the sensors node, it skips the full commands and the quality comparison (a stale stamp re-runs them). A hook that cannot run warns and lets git continue; a finding that blocks still blocks. Warnings are visible: Stop prints a `systemMessage` and the next prompt carries them over once. `/rig:pr` commits with `--no-verify` because its ship gate has just judged that tree. Opt out with `hooks uninstall` (`rig.githooks = off`).

There is no guard against the model passing `--no-verify` or running `hooks uninstall`: no hook runs on Bash, because a text match over shell commands was too leaky to be worth its size. A person keeps `--no-verify` too, so **CI plus branch protection is the boundary**; the hooks are a fast local signal.

Open: fast and full commands at commit and push see the working tree rather than the index or pushed commits.

## 11. Open items

- The mod's interactive parts (band, `/rig-approve` dialog, impact dialog, `/rig-sensors` pane) have never been checked by a person; `/rig-approve` has not been tried in a cloud session.
- The git hooks have not been trialled live; the live trials predate them.
- Confirm 0 permission prompts after plan approval (§8 trial re-run).
- Usage capture in headless `-p`, so scorecard cost matches run totals.
- Whether `autoCompactWindow` is honoured from project settings.
- Windows is unsupported (the hook scripts are POSIX `sh`).
