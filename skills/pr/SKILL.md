---
name: pr
description: The PR node - scope gate, ship gate, commit on sdlc/<slug>, pr.md scorecard, push and open the PR (or local-only without a remote). No confirmation needed inside an approved plan.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read
---
# PR $0

1. **Wiki.** If `docs/wiki/manifest.json` exists, run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki status`. If it lists anything, run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill wiki update $0` and follow it.
2. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts pr $0 --message "<type(scope): summary>\n\n<the intent's outcome>"`. The script checks readiness, scope and the ship gate, writes `pr.md`, commits, pushes and runs `gh pr create`. After a failed `gh` or push, run the same command again: it resumes.
3. **If the gate refuses** with traceability or red-proof findings, launch one `sdlc:implementer` with only those findings, then run step 2 again. Anything else goes to the person.
4. Never stage, commit, push or open the PR by hand.

End with the PR URL (or `local-only`) and: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/sdlc-run`, stop here; otherwise run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
