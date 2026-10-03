---
name: ship
description: Ship a verified, reviewed change - scope-drift gate against the plan, commit on a branch, and open a PR that links the change's artifacts. Merging stays with humans and branch protection.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git *), Bash(gh pr create*), Bash(gh pr view*), Read, Write, Agent
---
# Ship $0

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. Shipping needs `verification.md` to show `result: pass`, and `review.md` to show `pass` or `accepted` where the path includes review. Otherwise stop and say what is missing.
2. **Tier S review.** Tier S has no separate review stage. Launch the Opus `sdlc:reviewer` agent once on the diff, in the foreground. Fix only the findings it keeps. Then write `review.md` with `result: pass` or `accepted`, `rounds` and `caught`.
3. **Ship it.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ship $0 --message "<type(scope): summary>\n\n<the intent's outcome>"`. The script deterministically:
   - checks readiness and the scope gate
   - runs the ship gate: every sensor over the branch diff, the full commands, traceability (every B-number has a named test) and proof of red (the new tests fail on the base)
   - runs each changed consumer's tests, then commits each consumer on `sdlc/$0`
   - creates `sdlc/$0` here if you are on main, stages the planned code, artifacts, approvals, waivers and STATE.md, and commits

   **If the gate refuses** with traceability or red-proof findings, launch **one** `sdlc:implementer` with only those findings, then run ship again. Anything still failing, or any other finding, goes to the person: they fix it, or waive it with `/sdlc-waive <sensor> <file|*> <reason>`. Never stage or commit by hand.
4. **Never stage** `usage.jsonl`, `.env*` or unrelated files. The script already excludes them.
5. **Confirm before anything leaves the machine.** Show the branch, the commit and the PR title, and ask the person before `git push` and `gh pr create`.
6. **PR body:**
   - a 3-line summary
   - `Artifacts: .sdlc/changes/$0/` (the metrics script matches PRs by this path)
   - the verification commands and results
   - review findings fixed and deferred

End with the PR URL and: `Next: merge via review/branch protection; then /sdlc:start for the next change`.
