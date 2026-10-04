---
name: pr
description: The PR node - scope gate, ship gate, commit on sdlc/<slug>, pr.md scorecard, push and open the PR (or local-only without a remote). No confirmation needed inside an approved plan.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read
---
# PR $0

Run each sdlc.ts command as its own Bash call: no `cd`, pipes, redirects, `&&` or shell variables; use the Read and Grep tools to read files; commit messages are one line.

1. **Wiki.** If `docs/wiki/manifest.json` exists, run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki status`. If it lists anything, run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill wiki update $0` and follow it.
2. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts pr $0 --message "<type(scope): summary>"`. The script checks readiness, scope and the ship gate, writes `pr.md`, commits, pushes and runs `gh pr create`. After a failed `gh` or push, run the same command again: it resumes.
3. **If the gate refuses**, `next` still says `continue` at pr and its reason names the pending block. Show the reason and stop. The person fixes the findings or waives them (`/sdlc-waive ...`); then `/sdlc-next` resumes, this step re-runs the gate and clears the block. `/sdlc-approve $0 budget` is the manual unblock only for a cap, stall or budget block.
4. Never stage, commit, push or open the PR by hand.

End with the PR URL (or `local-only`) and: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/sdlc-run`, stop here; otherwise run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
