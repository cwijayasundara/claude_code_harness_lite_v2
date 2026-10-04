---
name: test
description: The test node - run every required test level (unit, integration, acceptance, api) and the plan's verification through the recorder; fix failing items within the ratchet's cap.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Agent
---
# Test $0

Run each sdlc.ts command as its own Bash call: no `cd`, pipes, redirects, `&&` or shell variables; use the Read and Grep tools to read files; commit messages are one line.

**Subagents:** run every subagent in the foreground and wait for its result.

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json`. Continue only if `node` is `test` and `verdict` is `continue`.
2. **Tier S and M:** run each `## Verification` command and each declared level command from `.sdlc/sensors.json` `levels` through `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --slug $0 -- "<command>"`, then `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts verify-report $0`.
   **Tier L and greenfield:** launch `sdlc:verifier` with the change folder; it does the same and reports.
3. Read `verification.md`'s `## Test levels`. A level marked `undeclared` cannot be fixed by code: stop and tell the person to declare it in `sensors.json` `levels` (or to change the plan).
4. **If `result: fail`:** send only the failing items to one `sdlc:implementer` run (plan files only), then repeat step 2. `verify-report` counts the round; when `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` says `blocked`, stop and show the reason (`/sdlc-approve $0 budget` is the person's way past a cap). Never edit tests to pass.

End with: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/sdlc-run`, stop here; otherwise run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
