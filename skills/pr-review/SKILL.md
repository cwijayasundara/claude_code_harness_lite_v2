---
name: pr-review
description: Review the open PR (or the local branch) against REVIEW.md with /code-review and, for risky changes, /security-review; post the findings; one fix round; then wait for green checks.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git diff*), Bash(git log*), Bash(gh pr view*), Bash(gh pr comment*), Read, Write, Edit, Agent, Skill, Workflow
---
# PR review $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Models:** pass `model` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` on every `rig:architect`, `rig:implementer` and `rig:reviewer` launch.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

1. Read `intent.md` (tier, risks), `REVIEW.md` at the repo root if present, and the deferred findings in `ratchet.json`'s build rounds.
2. **Review once.** Tier S and M: one `rig:reviewer` on the branch diff, applying `REVIEW.md` (the built-in `code-review` cannot take a model). Tier L: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts shards $0 --json`. One shard: one `code-review` at `high`. Several: tell the person the shard count, ask first when it is more than 8, then run the `rig-review` workflow (the plugin registers it by name; if the tool does not know the name pass `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/review.js"`) with args `{slug: "$0", base, shards, reviewer: "rig:reviewer"}` from that output, and use its `lines` as the findings. Step 4 says what to do with its `verdict`. Without the Workflow tool, run one `rig:reviewer` per shard in batches of 8. Also check that each `## Contracts` line of plan.md matches the diff. Run `security-review` only when `intent.md` risks name auth, payments, data, secrets or a public API.
3. **Post.** Write the findings, each with its severity, to `.sdlc/changes/$0/pr-comment.md` with the Write tool, then run `gh pr comment sdlc/$0 --body-file .sdlc/changes/$0/pr-comment.md` (skip without a remote). Use exactly that body file.
4. **Record.** Take `verdict:` from the workflow's `verdict`; on `incomplete` rerun the workflow once for the failed shards only, combine both runs' `lines` and take it from the combined result. `incomplete`, `disputed` and any non-empty `unreviewed` are never recorded as `pass`: show the person `unreviewed`, `disputed` and `lines` and let them decide; still incomplete, record nothing and stop. Write the findings in the reviewer's line format, with a `verdict:` line, to `.sdlc/changes/$0/review-pr.md`, then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ratchet record $0 pr-review --from .sdlc/changes/$0/review-pr.md`. It refuses a reply without an explicit verdict; `changes-needed` needs a critical or high finding. On `continue`: fix once (one `rig:implementer` run), rerun the plan's verification through `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --slug $0 -- "<command>"`, then `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts pr $0 --followup --message "fix: review findings"`, and record again. A model re-review after a fix runs at most once, on the fix diff only, never on the whole branch. On `blocked`: stop.
5. Write `review.md` (frontmatter `result: pass|accepted|blocked`, `rounds`, `caught`; body: findings with severity, category and disposition, then deferred items).
6. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts pr-checks $0`. It also commits this change's review evidence on `sdlc/$0`; do not commit it yourself. `pass`, `no-ci` or `local-only`: done. `fail`: show the failing checks and stop. `pending` or `unknown`: tell the person the checks are not finished and ask them to rerun this step later; never sleep-poll.

End with: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>` (`ready` means a person merges). Optionally show `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts scorecard $0`.
