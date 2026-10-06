---
name: pr-review
description: Review the open PR (or the local branch) against REVIEW.md with /code-review and, for risky changes, /security-review; post the findings; one fix round; then wait for green checks.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git diff*), Bash(git log*), Bash(gh pr view*), Bash(gh pr comment*), Read, Write, Edit, Agent, Skill
---
# PR review $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

1. Read `intent.md` (tier, risks), `REVIEW.md` at the repo root if present, and the deferred findings in `ratchet.json`'s build rounds.
2. **Review** the branch diff against the trunk: the built-in `code-review` skill at `high`, applying `REVIEW.md`. Also check that each `## Contracts` line of plan.md matches the diff. If the tier is L or the risks name auth, payments, data, secrets or a public API, also run `security-review`.
3. **Post.** Write the findings, each with its severity, to `.sdlc/changes/$0/pr-comment.md` with the Write tool, then run `gh pr comment sdlc/$0 --body-file .sdlc/changes/$0/pr-comment.md` (skip without a remote). Use exactly that body file; it is the only form auto-approved.
4. **Record.** Write the findings in the reviewer's line format, with a `verdict:` line, to `.sdlc/changes/$0/review-pr.md`, then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ratchet record $0 pr-review --from .sdlc/changes/$0/review-pr.md`. It refuses a reply without an explicit verdict; `changes-needed` needs a critical or high finding. On `continue`: fix once (one `rig:implementer` run for tier L), rerun the plan's verification through `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --slug $0 -- "<command>"`, then `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts pr $0 --followup --message "fix: review findings"`, and record again. On `blocked`: stop.
5. Write `review.md` (frontmatter `result: pass|accepted|blocked`, `rounds`, `caught`; body: findings with severity, category and disposition, then deferred items).
6. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts pr-checks $0`. It also commits this change's review evidence on `sdlc/$0`; do not commit it yourself. `pass`, `no-ci` or `local-only`: done. `fail`: show the failing checks and stop. `pending` or `unknown`: tell the person the checks are not finished and ask them to rerun this step later; never sleep-poll.

End with: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>` (`ready` means a person merges). Optionally show `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts scorecard $0`.
