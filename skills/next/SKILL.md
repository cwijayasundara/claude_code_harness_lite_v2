---
name: next
description: Do the next step of the active sdlc change, whatever it is - the one command to remember. Stops only at human gates.
effort: medium
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---
# Next step

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next --json`. `verdict` decides:
   - `continue`: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill <node> <slug>` and follow it exactly, then return to step 1 in this turn.
   - `human`: show `command` word for word and stop. Never approve for the person.
   - `blocked`: show `reason` and stop.
   - `ready`: say a person merges the PR, and suggest `/sdlc:start "<next task>"`.
2. **No active change** (or `initialised` false in `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status --json`): if not initialised, follow `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill onboard`. Otherwise ask the person in one question what they want to build, run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill start "<their answer>"` and follow the printed steps.

Never chain stages through the Skill tool. Every extra session re-reads the whole system prompt, so finishing in one turn is cheaper. Stop only at `human`, `blocked`, `ready`, a failed stage, or when the person's answer is needed.

End with the last stage's `Next:` line.
