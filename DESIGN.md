# rig: design

Why the harness is shaped the way it is, and what each part costs. Per-release changes are in [CHANGELOG.md](CHANGELOG.md); trial transcripts, plans and specs are in git history (before the commit that trimmed this file). Code is the reference for behaviour.

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
7. **Right model for the job, pinned.** Sonnet main thread and implementer, Opus architect and reviewer, Haiku scout. No skill sets `model:` (a switch re-reads the context uncached).
8. **Bounded loops.** Review rounds, Stop blocks and spend are capped; past a cap the finding goes to `unresolved.json` and ship refuses it.
9. **Every step ends with the next command.**

## 3. Architecture

```
skills/      the stages, /rig:* (start design spec plan diagnose build test sensors pr pr-review
             incident next init rule metrics learn wiki ask), prompts only
agents/      scout (haiku, read-only) · architect (opus) · implementer (sonnet) · reviewer (opus)
             · verifier (sonnet) · wiki
hooks/       hooks.json = settings hooks (work in -p and CI) · register.ts = the optional mod
scripts/     zero-dependency Node, no build step; sdlc.ts is the CLI; check.ts is the one checker
templates/   CI workflows (rig-check, rig-review, rig-wiki), settings.json, stacks.json, REVIEW.md
guides/      contracts, engineering, testing: injected on first touch of a matching path
.sdlc/       the consumer repo's committed evidence (see §5)
```

- **Skills, not commands; agents for model routing.** Plugin agents ignore `hooks`, `mcpServers` and `permissionMode`, so per-agent guards live in plugin-level hooks.
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
├── changes/<slug>/  intent.md  spec.md  design.md/plan.md (## Files, ## Slices, ## Verification; no code)
│                    verification.md (generated)  review*.md  runs.jsonl  ratchet.json  events.jsonl
│                    pr.md  ship.json  approvals/waivers rows
├── sensors.json     fast/full commands, tests, gates, levels, quality, limits, layers, contracts, ratchet, value
├── rules.json       regex rules          guides/   bin/ (vendored checker)   STATE.md
└── (gitignored)     .gate  .baseline  usage.jsonl  unresolved.json
```

Evidence files (approvals, waivers, `runs.jsonl`, `verification.md`, `ratchet.json`, `events.jsonl`, `pr.md`, `ship.json`, `.gate`) are written only by sdlc, enforced by the pre-bash and pre-edit guards. Plans must not contain code (this alone would have removed the 880 KB of plan text).

## 6. Token and time policy

| Lever | Mechanism |
|---|---|
| Bounded context | Small fresh contexts per subagent (`omitClaudeMd` on scout; briefs of ≤ 60 lines); `/compact` rather than a handoff skill |
| Sonnet main thread, Opus advisor **off** | Template sets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` (the advisor was a third of each run's cost; a user-level `advisorModel` otherwise still applies) |
| Cheap subagents | implementer and verifier on Sonnet, scout on Haiku; Opus only for architect and reviewer |
| One review per change | Findings below confidence 80 dropped; bounded fix rounds |
| No "continue" prompting | `build` ends with a ready `/goal` line; `/rig-run` drives one node per turn |
| Lean plans | No code in plans; `status` warns past 120 lines |
| Plugin diet | Project `enabledPlugins` turns off unrelated plugins |
| Cloud for long builds | A cloud session keeps running while the laptop sleeps |

## 7. Measurement

`metrics` reports the playbook's 12 leading and lagging metrics (from git, `gh`, approvals and incidents; `unmeasured` when n < 5) plus cost per change, stage and agent. Dollars come from the delta of the session cost ledger, which includes advisor and classifier calls; the scorecard adds spend against budget and an estimated value (`value` hours × rate). Cost capture needs the mod: headless `-p` runs record usd 0.

## 8. What the trials showed

Live, paid, one run per arm: treat as directional.

- **Cost.** About 4-7x plain Claude Code at the start, about 2x on small work after thinning (tier S: $0.31 vs $0.16), $2.50-2.87 vs $0.31-0.41 at tier L.
- **Value is assurance, not correctness.** Plain Claude Code passed most hidden tests but shipped an empty-key auth bypass in three of four tier L runs; the harness's Opus review caught it every time, and left a scoped commit, a gated spec and plan, and an audit trail.
- **Where savings should appear** is the long, large change (context bloat, Opus orchestration, fix waves). That is still unmeasured; the next trial is a Prism-sized milestone.
- **Defects the trials found, all fixed with tests:** verdicts must come from captured exit codes, not model claims; ship done means `ship.json` is committed; a path-scoped write permission must be an `Edit(...)` rule (`rig-review` had never worked before the first live PR); plans must not carry unresolved gating questions; `-p` skill chaining can silently drift, so a hook hands the model `sdlc.ts skill <name>`; headless sessions end while a background scout runs, so subagents run in the foreground.
- **Integration and scenarios.** Onboarding plus one change passes 8/8 and 8/8 ($0.74); greenfield, tier L bugfix and tier M refactor scenarios pass 12/12, 11/11 and 11/11 ($0.43-2.16). Onboarding the real Prism repo cost $1.28 in 233 s.
- **Autonomous ratchet trial (2026-10-04).** 14 headless runs, $3.64. 7 permission denials after plan approval (target 0, missed), then a fix wave; a re-run to confirm is pending.

## 9. Autonomous ratchet (v0.4)

`graph.ts` holds the per-type paths, per-tier gates and `step()`, which says continue, stop for a human, or block, and why. State is `ratchet.json` plus `events.jsonl` per change (evidence, sdlc-written). Build runs slice by slice with a bounded review loop; `levels` (unit, integration, acceptance, api) and `quality` commands (lint and similar, run on the branch and a base worktree, only a worsening blocks, else `unmeasured`) feed the test and sensors nodes; `/rig:pr` commits, pushes and opens the PR; `/rig:pr-review` reads it fail-closed. `/rig-approve <slug> budget` is the only way to raise a cap.

**Auto-approval** (only when `step()` says continue at an autonomous node, and the plan is approved for gated tiers): commands declared in `sensors.json` (exact match, never a prefix), the pinned harness script's deterministic subcommands, read-only git, `git checkout -b sdlc/<slug>`, `gh pr view|checks|comment` for the change's own branch, and edits inside the plan's `## Files` (no dot-segment paths). **Never auto-approved:** approvals, waivers, budget raises, edits to `sensors.json`, `.claude/settings.json` and other protected files.

**Sensors and test are never self-certified.** `ratchet record` refuses those nodes; `quality` and `verify-report` record them because they measure. The ship gate re-runs the quality comparison. A slice review is model-self-certified and only paces the build; test levels, sensors, the ship gate and CI are what a change must pass.

**CI never accepts a harness waiver from the PR**: a `harness-tamper` finding cannot be waived at CI, so a harness change lands on the trunk first as its own reviewed change.

Known limits: quality is compared at ship, not in CI, and reads `unmeasured` with no base (on trunk). Run autonomous builds in Claude Code's sandbox: declared test commands run model-written code. Defaults leave tier S and M ungated, so auto-approval starts once `plan.md` exists.

## 10. `rig learn` (v0.5)

Zero-token. From every change with a `ship.json` (review findings, blocked events, waivers, the diff rebuilt from git) it clusters patterns seen in at least 2 changes: a recurring review category with a recurring token becomes a `rule-add` proposal; repeated waivers of one sensor become an advisory `sensor-tune`. A rule is promotable only if replay fires on the stored diff of a change it came from and on no shipped change without that finding, with at least 10 changes shipped. Promotion is human-only (`/rig-approve <id> learn` appends to `rules.json`) and the learner lives in protected `scripts/**`, so the improver cannot change the gate that judges it. It runs from the mod after a ship, or weekly from `.github/workflows/learn.yml`. Deferred: a model proposer, edits to skill text or templates.

## 11. Git hooks and the bypass guard (spec 5)

Git is the common layer for every editor, agent and person, so `hooks install` sets `core.hooksPath` to the committed `.sdlc/githooks/` (POSIX `sh`, running the vendored checker). `check --at commit` runs the Stop sensors on the staged diff plus the fast commands; `check --at push` runs the ship checks and the quality ratchet against CI's base (merge-base with the trunk), within `githooks.budgetMs`. A hook that cannot run warns and lets git continue; a finding that blocks still blocks. Warnings are visible: Stop prints a `systemMessage` and the next prompt carries them over once. `/rig:pr` commits with `--no-verify` because its ship gate has just judged that tree. Opt out with `hooks uninstall` (`rig.githooks = off`).

The model is denied the bypasses it can be seen to make (`--no-verify`, `core.hooksPath` overrides, `hooks uninstall`) by `bypass.ts`, reading dequoted words from the `shell.ts` tokenizer through wrappers, shell `-c` payloads, substitutions and here-docs, nested to three layers, failing closed past size, time or depth limits. **It is a best-effort text match.** It cannot see a flag produced by a substitution or variable, interpreters (`python3 -c`, `node -e`), pipes into a shell, scripts written then run, `.git/config` edits or `rm -rf .sdlc/githooks`. A person keeps `--no-verify`. CI plus branch protection is the boundary.

Open: fast and full commands at commit and push see the working tree rather than the index or pushed commits.

## 12. Code wiki (spec 6)

`docs/wiki/` in the consumer repo is a computed layer plus a prose layer. `wiki build` regenerates, at zero tokens, blocks between `<!-- rig:gen:NAME -->` markers (architecture diagram, files, entry points, deps, tests, why, recent) from real imports (JS/TS and Python only; other languages get no computed edges). A Sonnet agent writes only the prose (summary, *In plain words*, *Walk-through*), treating wiki text and source as untrusted data. `wiki build --check` fails on drift of the structural blocks; `wiki status` lists `stale`, `missing`, `uncovered`, `generated`, `prose`, `invalid`; `wiki stamp` requires `path:line` citations and the two sections; `wiki search` is zero-token ranking; `/rig:ask` has a Haiku scout answer from the wiki. The manifest (`docs/wiki/manifest.json`: `pages`, `skip`, `notes`, `order`) is validated, and every read and write goes through symlink-safe paths.

`templates/rig-wiki.yml` refreshes it through one PR in two jobs: `generate` (read-only token; the only job that runs a model, configured with no shell or network and edit rights only on `docs/wiki`) and `publish` (write token, no model; refuses symlinks, re-runs `build --check`, scans for credentials, rejects a manifest changed beyond `surface` stamps, pushes only `rig/wiki-refresh`). **Nothing in the workflow has run on GitHub**; its first-run checklist (the action's agent mode on `push`, whether `--allowedTools` confines the model headless, artifact semantics, token and PR-check behaviour) is open. Other open items: aliases and monorepo package names are not resolved; `wikiStatus()` costs about 1.3 s on 5,000 files at every commit and push; a decoy generated block planted in prose defeats `--check`.

## 13. Open items

- The mod's interactive parts (band, `/rig-approve` dialog, impact dialog, `/rig-sensors` pane) have never been checked by a person; `/rig-approve` has not been tried in a cloud session.
- The git hooks and the wiki have not been trialled live; the live trials predate both.
- Confirm 0 permission prompts after plan approval (§8 trial re-run).
- Usage capture in headless `-p`, so scorecard cost matches run totals.
- Whether `autoCompactWindow` is honoured from project settings.
- Windows is unsupported (the hook scripts are POSIX `sh`).
