# Spec 5: enforcement everywhere (git hooks, visible warnings)

Status: design for review · 2026-10-06 · extends `DESIGN.md` and spec 1 (quality sensors). Spec 6, the DeepWiki-class code wiki, follows this one.

## 1. Problem

The goal is a clean, tidy codebase even when work does not go through `/rig:start`. A spike on 2026-10-06 ran the real hooks (`.sdlc/bin/sdlc.ts hook …`) in a throwaway repo with no active change. It found that the Stop gate already does most of the job, and where it stops.

**Already enforced with no active change** (Stop gate, zero tokens): a hardcoded secret, deleted test assertions, failing fast tests, a file written through Bash, and a bad change the agent commits itself mid-turn. Each blocked the turn and recorded an `adhoc-…` change. An edit to `.claude/settings.json` asks first.

**Not enforced:**

| # | Gap | Evidence |
|---|---|---|
| 1 | **Nothing runs outside a Claude turn.** A hand edit in an IDE, another agent, or a manual `git commit` reaches the branch unchecked until CI. | Spike: `.git/hooks` held only samples; the harness has no git-hook support. |
| 2 | **Warnings are invisible.** A 90-line file against a 60-line limit passed silently; the `size` warning lands only in `.sdlc/.gate` (`last`). The agent never sees it. | Spike scenario K. |
| 3 | **The wiki drifts during vibe coding.** `wiki-stale` runs only at ship and CI (`scripts/check.ts:310`). | Code read. |
| 4 | **The Stop cap is soft.** After 2 blocks the agent finishes; only ship and CI enforce `unresolved.json`. A vibe coder who commits and pushes directly meets no refusal until CI, and only if `rig-check` is a required check. | Spike scenario H2. |
| 5 | **The quality ratchet (lint, coupling versus base) runs only at `/rig:sensors`.** CI does not run it either (`cmdCheck` calls `runChecks` only). | `scripts/quality.ts:83`, `scripts/check.ts:403`. |

This spec closes all five. Gap 5 is closed at push, not at commit (§4.2).

## 2. Decisions

| Decision | Choice |
|---|---|
| Common layer | **Git hooks.** Every editor, agent and human ends in `git commit` and `git push`, so one mechanism covers them all. |
| Same checker | The hooks call `sdlc.ts check`, as Stop, ship and CI do. Local equals CI (principle 6). No second rule set. |
| Install | `sdlc.ts hooks install`, which sets `core.hooksPath` to a committed `.sdlc/githooks/`. |
| Failure mode | A hook that cannot run (old Node, missing `.sdlc/bin`) **warns loudly and lets the commit through**. CI is the floor, and a broken hook must not wedge a repo. A finding that blocks still blocks. |
| Bypass | `--no-verify` stays available to people. The model is denied it (§4.5). CI catches anything pushed past the hooks. |
| Warnings | Shown, never blocking: to the agent on the next turn, and to the person at commit. |

## 3. Non-goals

- **Quality ratchet at commit.** It needs a base worktree and a `ratchet.json` under a change slug, so it runs at push only (§4.2), never on every commit.
- No new sensors. This spec changes where and when the existing ones run, and who sees their warnings.
- No server-side enforcement. Branch protection and the required `rig-check` remain the real boundary (SECURITY.md).
- No Windows support (already documented). The hook scripts are POSIX `sh`.

## 4. Design

### 4.1 `check --at commit`

A new `Point` value in `scripts/check.ts`. It judges what is about to be committed:

- **Diff:** `git diff --cached` (staged), parsed by the existing `parseUnifiedDiff`. Add `stagedDiff()` to `scripts/diffs.ts` beside `turnDiff` and `branchDiff`. `before(f)` is `showAt('HEAD', f)`. Added-file text and line counts for `size` and the pattern sensors come from the index (`git show :<path>`), not the working tree, so unstaged edits cannot hide or cause findings.
- **Sensors:** the same set Stop runs (test-tamper, suppression, layering, size, secrets, rules, contract-impact, harness-tamper). Everywhere a `Point` is compared, `commit` follows `stop`, because both judge a partial diff.
- **Commands:** the `fast` commands, with Stop's 60 s budget. They run against the working tree, so they can see unstaged edits. This is stated in the hook's output when the tree differs from the index.
- **Wiki:** `wikiFindings()` as warnings (they are already `warn`).
- **Slugs:** the active change if any, else none. The hook **writes nothing**: it does not create an `adhoc-…` change (Stop does that, and CI's `unrecorded` check covers the rest).
- **Exit:** 1 when any finding blocks, else 0. Warnings print, with the `fix` text.

### 4.2 `check --at push`

For `pre-push`, `check --at ship --base <default base>` on the pushed branch. It reuses the ship path without a new point: traceability, red-proof where the change type requires it, tier and `adhoc` findings, and the full commands. Hence an unplanned tier M or L ad-hoc change is refused at push as it is at CI, and the person gets the CI answer before CI. `sensors.json` gains `githooks: { "prePush": "ship" | "off", "budgetMs": 300000 }` (default `"ship"`). Past the budget the hook warns and lets the push through; CI still runs.

**Quality ratchet at push.** When `sensors.json` declares `quality` commands, pre-push also runs `runQuality(slug)` (`scripts/quality.ts:83`): each category's count on the branch against the base, plus the test-case count that never drops. The slug is the active change; else the newest `adhoc-*` change; else a new `adhoc-…` change that the hook creates from the branch diff (the one place a git hook writes a record, because the ratchet stores its baseline under a change folder). Regressions block the push; a category that cannot run blocks with its `fix`. With no `quality` declared the step is skipped and says so. It shares the push budget.

### 4.3 Install and lifecycle (`scripts/githooks.ts`, new)

- `sdlc.ts hooks install | uninstall | status`.
- Writes `.sdlc/githooks/pre-commit` and `pre-push`: a `sh` script that checks `node` is at least 22.18 and `.sdlc/bin/sdlc.ts` exists (otherwise warn and exit 0), then runs `node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts check --at commit` (or `--at push`).
- `install` runs `git config core.hooksPath .sdlc/githooks`. If `core.hooksPath` already points elsewhere (husky and the like), it changes nothing, prints the two lines to call from the existing hook, and exits 1. `--force` overrides.
- `core.hooksPath` is local git config, so a fresh clone has no hooks. **The `session-start` hook (committed in `.claude/settings.json`) installs them idempotently** when missing and says so in its context, and `/rig:init` and `vendor` write `.sdlc/githooks/` and install. A person working outside Claude Code runs `node .sdlc/bin/sdlc.ts hooks install` once; the README says so.
- `vendor` adds `githooks` to `VENDORED` and copies the two scripts, so standalone repos carry them.

### 4.4 Warnings the agent can see

- **Stop** keeps blocking only on `block` findings, but on a pass with warnings it prints one `systemMessage` for the person: `sdlc: 1 warning (size src/big.js: grew to 90 lines)`.
- **prompt-submit** reads `gate.last` before it resets the turn and, when `last.warns > 0`, injects `additionalContext` of at most 5 lines: the previous turn's warnings with their `fix`. The agent sees them once, at the start of the next turn.
- `GateSummary` gains `warnRows: string[]` (at most 5, truncated) so the carry-over has text, not just counts.

### 4.5 Protecting the hooks from the model

- `isProtected` (`scripts/sensors.ts`) covers `.sdlc/githooks/**`, so an edit asks the person like any harness file.
- `pre-bash` denies, for the model only, `git commit|push … --no-verify` (and `-n` on commit), and `git config … core.hooksPath` (any form, including `-c core.hooksPath=`). People in a terminal are unaffected.

## 5. Components and sizes

| File | Change |
|---|---|
| `scripts/githooks.ts` (new) | install, uninstall, status, hook script text (about 70 lines) |
| `scripts/check.ts` | `commit` point, `--at commit` wiring, `push` alias to ship (about 25 lines) |
| `scripts/diffs.ts` | `stagedDiff`, `stagedText` (about 15 lines) |
| `scripts/githooks.ts` | push path: resolve or create the ad-hoc slug, call `runQuality` (about 25 lines more) |
| `scripts/hooks.ts` | session-start install and notice, warn carry-over in prompt-submit, Stop `systemMessage`, pre-bash denials (about 35 lines) |
| `scripts/sensors.ts`, `scripts/model.ts` | `isProtected` glob, `githooks` config keys and parsing (about 15 lines) |
| `scripts/vendor.ts`, `scripts/sdlc.ts` | vendor the scripts; register `hooks` command (about 6 lines) |

About 195 added lines. `scripts/size.spec.ts` caps the harness at 6100 lines, so the cap rises with this change, as it did for 0.4.1.

## 6. Testing (test first)

Each is a `scripts/*.spec.ts` using the existing `testkit.ts` temp-repo helpers, and each fails before the code exists.

1. **Staged secret** is blocked at commit; the same secret **unstaged** is not reported; a clean staged file passes.
2. **Test-tamper at commit**: staged assertion deletions block.
3. **Real git**: with hooks installed, `git commit` of a secret fails and `git commit` of clean code succeeds. A sibling case runs with Node unavailable on `PATH` and asserts warn-and-allow.
4. **`hooks install`** sets `core.hooksPath`; refuses when it points elsewhere; `--force` overrides; `uninstall` restores; `status` reports each state; `vendor --standalone` writes the scripts.
5. **session-start** installs when missing and stays quiet when present.
6. **Warn carry-over**: a Stop that passes with a `size` warning, then prompt-submit, yields context naming the file once and not again on the following turn.
7. **pre-bash** denies `git commit --no-verify` and `git config core.hooksPath x` for the model.
8. **Regression for the spike:** the A, B, D and E scenarios (secret, tamper, mid-turn commit, Bash write) still block at Stop, and now also at commit.
9. **Push**: an unplanned tier M ad-hoc change is refused by `check --at ship`; `prePush: "off"` skips it; a budget overrun warns and allows.
10. **Quality at push**: a branch that raises a declared category's count above the base's is blocked; equal passes; a dropped test count blocks; no `quality` declared skips with a note; with no active change the hook reuses or creates one `adhoc-…` change and a second push reuses it.

## 7. Risks

- **Slow commits.** The fast commands can take up to 60 s. Mitigation: the same `fast` set the project already declares; the person can trim it in `sensors.json`.
- **False positives on fixtures.** The secrets sensor blocks a commit that adds a test fixture. The existing `fixtures` list handles it, and a person approves that change.
- **Hooks only exist where installed.** A clone that never ran Claude Code or `hooks install` has none. CI remains the floor, which is why `rig-check` should be a required check.
- **Commands see the working tree, not the index.** Documented in the hook's output; staging with `git add -p` can yield a green run on code that is not what gets committed.

## 8. Decisions taken at review

1. `prePush` defaults to `"ship"`.
2. The quality ratchet is in this spec, at push (§4.2).
