---
name: pr
description: The PR node - scope gate, ship gate, commit on sdlc/<slug>, pr.md scorecard, push and open the PR (or local-only without a remote). No confirmation needed inside an approved plan.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Agent
---
# PR $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Models:** read `routes` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` and pass that role's `model` and `effort` on every launch: `rig:architect` (architect), `rig:implementer` (implementer), `rig:reviewer` (`slice-review` in build, `reviewer` elsewhere). A `main` route means draft it in this thread. After a failed round, run that command again before the fix launch: the implementer route can rise.

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts pr $0 --message "<type(scope): summary>"`. The script checks readiness, scope and the ship gate, writes `pr.md`, commits, pushes and runs `gh pr create`. After a failed `gh` or push, run the same command again: it resumes.
2. **If the gate refuses**, `next` still says `continue` at pr and its reason names the pending block. First try to fix it without a person: send the findings once to one `rig:implementer` run (plan files only; never edit sensors.json, tests to pass, or add a waiver), run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts quality $0`, then run step 1 again. Only if the gate refuses a second time, show the reason and stop: the person fixes the findings or waives them (`/rig:waive ...`); then `/rig:next` resumes, this step re-runs the gate and clears the block. `/rig:approve $0 budget` is the manual unblock only for a cap, stall or budget block.
3. Never stage, commit, push or open the PR by hand.

End with the PR URL (or `local-only`) and: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/rig-run`, stop here; otherwise run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
