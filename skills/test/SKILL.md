---
name: test
description: The test node - run every required test level (unit, integration, acceptance, api) and the plan's verification through the recorder; fix failing items within the ratchet's cap.
argument-hint: <slug>
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Agent
---
# Test $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Models:** read `routes` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` and pass that role's `model` and `effort` on every launch: `rig:researcher` (researcher), `rig:architect` (architect), `rig:implementer` (implementer), `rig:reviewer` (`slice-review` in build, `reviewer` elsewhere). A `main` route means draft it in this thread.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json`. Continue only if `node` is `test` and `verdict` is `continue`.
2. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts verify $0` (Bash timeout 600000). It runs the plan's `## Verification` commands and each required level's declared command through the recorder, then writes `verification.md`. A command it lists as not run is not declared in `sensors.json` and the plan is not approved: run each with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --slug $0 -- "<command>"`, then `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts verify-report $0`.
3. Read `verification.md`'s `## Test levels`. A level marked `undeclared` cannot be fixed by code: stop and tell the person to declare it in `sensors.json` `levels` (or to change the plan).
4. **If `result: fail`:** send only the failing items to one `rig:implementer` run (plan files only), then repeat step 2. `verify` counts the round; when `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` says `blocked`, stop and show the reason (`/rig-approve $0 budget` is the person's way past a cap). Never edit tests to pass.

End with: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/rig-run`, stop here; otherwise run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
