---
name: build
description: Execute an approved plan slice by slice through sdlc:implementer subagents (Sonnet), then hand off to verification. Use after plan approval, or directly for tier S chores.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git status*), Bash(git diff*), Read, Write, Edit, Glob, Grep, Agent
---
# Build $0

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status` first. If the plan needs approval, stop and say so.

## Small builds: do it here
Use this section for tier S, and for tier M when the plan has 3 or fewer slices and touches 8 or fewer files. At that size, subagent start-up and orchestration turns cost more than the context they protect. Work directly in this conversation:
1. Write the failing test, implement, and run the targeted tests quietly. Stay inside the plan's `## Files`.
2. Run the plan's `## Verification` commands.
3. Write `verification.md` with `result: pass` only if every command exited 0. Paste the command and the last lines of its real output.

Next:
- Tier S: `/sdlc:ship <slug>`, which includes the review pass.
- Tier M: `/sdlc:review <slug>`, because verification is already written.

## Large builds: orchestrate
Use this for tier L, greenfield, or plans with more than 3 slices or more than 8 files. Here, keeping the main context small is what saves money.

You are the orchestrator. **Do not write production code in this conversation**; subagents do. That keeps this context small and cheap.

1. Read `plan.md`, or `intent.md` for a chore. In `.sdlc/STATE.md`, list the slices and mark the ones already done. Do not edit `plan.md` to track progress, because that would make its approval stale.
2. For each remaining slice, in order, launch one `sdlc:implementer` with a brief of **60 lines or fewer**:
   - the slice goal
   - the files it owns, copied from the plan
   - the interface sketch
   - the acceptance tests and the B-numbers they prove
   - the fast test command
   - relevant conventions from CLAUDE.md

   Never paste whole files. The implementer reads what it needs.
   - Run independent slices in parallel (at most 3, in one message) **only** when their file sets do not overlap.
   - Wait for results. Background agents notify you, so never `sleep` or poll.
3. After each report:
   - **Done:** update STATE.md (slice done, test command and result).
   - **Blocked:** decide once. Either clarify and relaunch, or, if the blocker changes scope, stop and ask the person.
   - **Blocked twice on the same slice:** consult the advisor, or ask the person. Do not loop.
4. Glance at `git diff --stat` against the plan's `## Files`. Anything outside the plan gets added to the plan with the person's agreement, or reverted.
5. When all slices are done, continue with `/sdlc:verify $0`.

For a long unattended run, suggest that the person start it with:
`/goal every slice of .sdlc/changes/$0/plan.md is done and $0/verification.md says result: pass, or stop after 40 turns`

End with: `Next: /sdlc:verify $0`.
