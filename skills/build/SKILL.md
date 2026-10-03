---
name: build
description: Execute an approved plan, then hand off to verification. Small builds run inline; tier L and greenfield run through superpowers subagent-driven development when it is installed, otherwise through sdlc:implementer subagents.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git checkout*), Bash(git status*), Bash(git diff*), Bash(git log*), Bash(git rev-parse*), Bash(bash *subagent-driven-development/scripts/*), Read, Write, Edit, Glob, Grep, Agent, Skill
---
# Build $0

**Subagents:** run every subagent in the foreground and wait for its result. Never end your turn while one is still running.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status` first. If the plan needs approval, stop and say so.

## Small builds: do it here
Tier S, and tier M with 3 or fewer slices and 8 or fewer files. Subagent start-up costs more than it saves at this size.
1. Write the failing test and run it once with `sdlc.ts run --expect-fail -- "<test command>"`. Implement; run targeted tests quietly. Stay inside `## Files`.
2. Run each `## Verification` command through `sdlc.ts run -- "<command>"`, then `sdlc.ts verify-report $0`. Never write verification.md by hand.

Next: tier S `/sdlc:ship $0` (includes review); tier M `/sdlc:review $0`. Then keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it, unless the person asked to stop after this stage.

## Tier L and greenfield: superpowers SDD
Use this when `superpowers:subagent-driven-development` is in your available skills; otherwise use the next section.
1. If on main or master: `git checkout -b sdlc/$0`.
2. Invoke `superpowers:subagent-driven-development` on `.sdlc/changes/$0/plan.md` (spec: `.sdlc/changes/$0/spec.md`). These caller instructions override the skill:
   - Work in this tree on `sdlc/$0`. Do not use `using-git-worktrees`.
   - Dispatch implementers and task reviewers with `model: sonnet`. Never escalate to rounds 4–5.
   - **At most one fix round per task.** Record still-open findings in the ledger and move on; sdlc's review sees them.
   - Tell each implementer: red runs go through `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --expect-fail -- "<cmd>"`, and only the task's files may change.
   - **Skip** the final whole-branch review and `finishing-a-development-branch`. When every task is complete, stop the skill and continue here.
3. Next: `/sdlc:verify $0`. Then keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it, unless the person asked to stop after this stage.

## Large builds: orchestrate
Tier M with more than 3 slices or 8 files, or tier L without superpowers. You orchestrate; subagents write the code.
1. Read `plan.md` (or `intent.md` for a chore). Track slices in `.sdlc/STATE.md`, never in `plan.md` (that makes its approval stale).
2. For each remaining slice, launch one `sdlc:implementer` with a brief of 60 lines or fewer: slice goal, owned files, interface sketch, acceptance tests with B-numbers, the fast test command, relevant CLAUDE.md conventions and `.sdlc/guides/` names, and the rule that red runs go through `sdlc.ts run --expect-fail`. Never paste whole files. Parallel (at most 3, one message) only when file sets do not overlap. Never `sleep` or poll.
3. After each report: **done**, update STATE.md; **blocked** (or the end-of-turn gate listed unfixed findings), clarify once and relaunch, or ask the person if scope changes. **Blocked twice** on one slice: consult the advisor or the person.
4. Compare `git diff --stat` with `## Files`. Out-of-plan files are added to the plan with the person's agreement, or reverted.

For a long unattended run, suggest: `/goal every slice of .sdlc/changes/$0/plan.md is done and $0/verification.md says result: pass, or stop after 40 turns`

End with: `Next: /sdlc:verify $0`. Then keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it, unless the person asked to stop after this stage.
