---
name: diagnose
description: Bug path - reproduce with a failing regression test, isolate the cause, apply the smallest fix, verify. Use for bugfix and incident changes instead of build.
argument-hint: <slug>
effort: high
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---
# Diagnose $0

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

1. **Reproduce.**
   - Read `intent.md`.
   - Write the smallest failing test that shows the bug, as a regression test in the project's suite. Run it once with `sdlc.ts run --expect-fail -- "<test command>"` so the red run is on record.
   - Run it and confirm it fails for the reported reason.
   - If you cannot reproduce in 3 attempts, stop and ask the person for data.
2. **Isolate.**
   - Use `sdlc:scout` to trace the path.
   - List at most 3 hypotheses, ranked.
   - Test the top one with a probe (a log line, a narrower test). Never use a speculative fix.
3. **Fix** (tier L: only after the plan is approved; see step 4).
   - Apply the smallest change that makes the regression test pass and keeps the rest green.
   - Do not refactor along the way.
   - If the fix touches more than 3 files or a contract, stop: it is a feature or refactor, so tell the person.
4. **Tier L: stop for approval before fixing.** After steps 1–2 (the failing test and the root cause), write `.sdlc/changes/$0/plan.md` (≤ 30 lines, no code): `## Root cause` (`path:line`, one paragraph), `## Fix` (the smallest change, in words), `## Files`, `## Verification`. Then stop and tell the person: review plan.md and run `/sdlc-approve $0 plan`. When run again after approval, go straight to step 3.
5. **Record (tier S and M).** Write `## Files` (touched files) and `## Verification` (test commands) into `.sdlc/changes/$0/plan.md`, using 15 lines or fewer and no code.
6. **Verify.** Launch `sdlc:verifier`, telling it to run the plan's commands with `sdlc.ts run` and generate `.sdlc/changes/$0/verification.md` with `sdlc.ts verify-report $0`.

Three failed hypotheses means consult the advisor or the person. Do not keep guessing.

End with: `Next: <command from status>` if verification passed, otherwise state what failed. If it passed, then keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it, unless the person asked to stop after this stage.
