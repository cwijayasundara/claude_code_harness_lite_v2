---
name: verify
description: Independent verification of a change by the sdlc:verifier agent - runs the plan's verification commands and writes verification.md with real output. One repair round at most.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Agent
---
# Verify $0

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

- **Tier S and M:** run each of the plan's `## Verification` commands through `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --slug $0 -- "<command>"`, then `... sdlc.ts verify-report $0`. Then skip to step 3.
- **Tier L and greenfield:** independence is worth its cost, so launch `sdlc:verifier`.

1. For tier L or greenfield, launch `sdlc:verifier` with this brief:
   - the change folder `.sdlc/changes/$0/`
   - which tells it to use `plan.md` `## Verification` and the B-numbers in `spec.md`, if any
   - the report path `.sdlc/changes/$0/verification.md`
2. **If `result: fail`:** send only the failing items to **one** `sdlc:implementer` repair run (files from the plan), then verify again once.
3. **If it still fails:** stop, show the failing items, and ask the person. Never edit tests to pass, and never mark a criterion passed without output that proves it.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. End with: `Next: <command from status>`. Then keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it, unless the person asked to stop after this stage.
