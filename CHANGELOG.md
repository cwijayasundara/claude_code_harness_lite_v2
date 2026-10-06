# Changelog

## Unreleased

- Removed: the code wiki (`wiki*` scripts, `/rig:wiki`, `/rig:ask`, the wiki agent, `rig-wiki.yml`) and `rig learn` (`/rig:learn`, `learn.yml`, the mod's auto-run). The harness line cap is now 6450. Both remain in git history before this commit.
- Git hooks: `sdlc.ts hooks install` wires `pre-commit` (the staged diff through the Stop sensors and the fast commands) and `pre-push` (what the remote lacks through the ship checks and the quality ratchet), so edits made outside a Claude turn are judged too. A fresh clone is wired at session start. A hook that cannot run warns and lets git continue; `--no-verify` stays a person's option and the model is denied it, along with `core.hooksPath`. New config `githooks: { prePush, budgetMs }`.
- Git hooks, hardening: `/rig:pr` commits and pushes with `--no-verify` (its ship gate just judged the tree; a slow suite re-run through pre-push used to time out silently), and a follow-up shows the hooks' reasons. Push judges a branch against its merge-base with the trunk, as CI does, so merging or rebasing on main no longer counts main's work. `hooks uninstall` is a lasting opt-out (`rig.githooks = off`) that session start respects. A checker crash at commit or push warns and allows; stop, ship and CI still fail closed. A merge or rebase is read from git state, not `GIT_REFLOG_ACTION`, and skips only the fast commands. Warnings at commit and push print with their fix text. The bypass guard now reads commands with the shell tokenizer (including `sh -c` and `eval` payloads) and also denies the model `hooks uninstall` and `hooks install --force`. It matches `git` and the shells case-insensitively, finds a shell `-c` or `eval` payload behind wrappers such as `env`, `sudo`, `xargs` and `timeout`, and reads commands with `$(...)`, redirects or comments through the tokenizer, not only the regex. It is best effort; CI is the floor.
- Stop now tells the person about non-blocking warnings, and the next prompt hands them to the agent once (a 90-line file over a 60-line limit used to pass in silence).
- Tests no longer inherit the runner's `GITHUB_EVENT_PATH`/`GITHUB_STEP_SUMMARY`, which made the reviewer-lookup test fail on GitHub Actions; the new reliability tests import by file URL so they run on Windows.

## 0.4.1

- CI: a PR that adds approval or waiver rows now fails unless a person with write access other than the author approved the current head commit (looked up before any PR test command runs, and bound to the commit actually checked out, so a stale workflow re-run cannot reuse an old approval) (`human-approval` finding). Needs `pull-requests: read` and `GH_TOKEN` in `rig-check.yml`.
- Secrets: an in-line `rig:allow-secret` no longer exempts a line at CI; use `fixtures`. Added Google, Stripe, JWT, Azure and unquoted env-file patterns.
- Hooks: `usage.jsonl` (the spend cap's input) is protected evidence; shell-expansion spellings of `SDLC_HUMAN` and `approve`/`waive` are refused.
- Read-only agents can no longer read credential files, including through globs, `grep -r` or `rg --hidden`.
- `rig-review.yml` passes `base_ref` through `env` (script injection); `ci.yml` has least-privilege permissions; `git` and `gh` calls time out; `GH_TOKEN` is not passed to a PR's own test commands.
- Docs: SECURITY.md (trust model).
- Reliability: hook state (`.gate`, `.baseline`) is written under a lock and by rename, so parallel subagents no longer lose edits or baselines (10 parallel edits recorded 1 before, 10 now); the Stop hook writes back only what it owns.
- Reliability: untracked files are fingerprinted by size, mtime and ctime (ctime cannot be forged, so a same-size edit with a restored mtime is still seen) instead of being read on every hook (an untracked file over 20 MB is not read at all: the `unscanned` sensor blocks it, and a `size` waiver does not cover it, so a hook never runs out of memory or time and silently turns the gate off), so a repo with tens of thousands of untracked files no longer blows the hook timeouts.
- `STATE.md` no longer carries an `updated:` timestamp (fewer merge conflicts). If two branches both start a change, take either side of `.sdlc/STATE.md`: it is only the active-change pointer and `sdlc status` rebuilds it.
- `vendor` refuses Node older than 22.18, refuses to downgrade a newer vendored copy (`--force` overrides) and checks `.claude/settings.json` parses before writing anything. The Windows vendored-mod check normalises path separators.
- The harness line cap is now 6100 (was 6000) to make room for this.

## 0.4.0

The autonomous ratchet. See DESIGN.md section 9.
