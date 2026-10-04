---
name: sensors
description: The sensors node - lint, types, dependency audit, coupling, complexity, security and performance compared with the base branch, plus the built-in sensors; one fix round.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Agent
---
# Sensors $0

**Subagents:** run every subagent in the foreground and wait for its result.

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts quality $0`. It runs each declared category on the branch and on the base, the built-in sensors and the test-count invariant, and records the round.
2. **Exit 0:** the node is done. **Exit 2:** read the findings.
   - `regressed` or a built-in block: send only those findings to one `sdlc:implementer` run (plan files only), then run step 1 again.
   - `fail` (a tool missing or broken): stop; the person installs the tool or fixes the command in `sensors.json`.
   - `blocked`: stop and show the reason.
3. `unmeasured` categories are reported, never passed: mention them once in your summary.

End with: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/sdlc-run`, stop here; otherwise run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
