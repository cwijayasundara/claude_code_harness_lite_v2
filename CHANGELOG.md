# Changelog

## Unreleased (hardening/pre-team-rollout)

- CI: a PR that adds approval or waiver rows now fails unless a person with write access other than the author approved the current head commit (looked up before any PR test command runs, and bound to the commit actually checked out, so a stale workflow re-run cannot reuse an old approval) (`human-approval` finding). Needs `pull-requests: read` and `GH_TOKEN` in `rig-check.yml`.
- Secrets: an in-line `rig:allow-secret` no longer exempts a line at CI; use `fixtures`. Added Google, Stripe, JWT, Azure and unquoted env-file patterns.
- Hooks: `usage.jsonl` (the spend cap's input) is protected evidence; shell-expansion spellings of `SDLC_HUMAN` and `approve`/`waive` are refused.
- Read-only agents can no longer read credential files, including through globs, `grep -r` or `rg --hidden`.
- `rig-review.yml` passes `base_ref` through `env` (script injection); `ci.yml` has least-privilege permissions; `git` and `gh` calls time out; `GH_TOKEN` is not passed to a PR's own test commands.
- Docs: SECURITY.md (trust model).
- Reliability: hook state (`.gate`, `.baseline`) is written under a lock and by rename, so parallel subagents no longer lose edits or baselines (10 parallel edits recorded 1 before, 10 now); the Stop hook writes back only what it owns.
- Reliability: untracked files are fingerprinted by size and mtime, not contents, and a turn reads at most 2000 new files, so a repo with tens of thousands of untracked files no longer blows the hook timeouts.
- `STATE.md` no longer carries an `updated:` timestamp (fewer merge conflicts). If two branches both start a change, take either side of `.sdlc/STATE.md`: it is only the active-change pointer and `sdlc status` rebuilds it.
- `vendor` refuses Node older than 22.18, refuses to downgrade a newer vendored copy (`--force` overrides) and checks `.claude/settings.json` parses before writing anything. The Windows vendored-mod check normalises path separators.
- The harness line cap is now 6100 (was 6000) to make room for this.

## 0.4.0

The autonomous ratchet. See DESIGN.md section 14.
