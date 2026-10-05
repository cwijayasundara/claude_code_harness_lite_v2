# Changelog

## Unreleased (hardening/pre-team-rollout)

- CI: a PR that adds approval or waiver rows now fails unless a person with write access other than the author approved the current head commit (looked up before any PR test command runs, and bound to the commit actually checked out, so a stale workflow re-run cannot reuse an old approval) (`human-approval` finding). Needs `pull-requests: read` and `GH_TOKEN` in `rig-check.yml`.
- Secrets: an in-line `rig:allow-secret` no longer exempts a line at CI; use `fixtures`. Added Google, Stripe, JWT, Azure and unquoted env-file patterns.
- Hooks: `usage.jsonl` (the spend cap's input) is protected evidence; shell-expansion spellings of `SDLC_HUMAN` and `approve`/`waive` are refused.
- Read-only agents can no longer read credential files, including through globs, `grep -r` or `rg --hidden`.
- `rig-review.yml` passes `base_ref` through `env` (script injection); `ci.yml` has least-privilege permissions; `git` and `gh` calls time out; `GH_TOKEN` is not passed to a PR's own test commands.
- Docs: SECURITY.md (trust model).

## 0.4.0

The autonomous ratchet. See DESIGN.md section 14.
