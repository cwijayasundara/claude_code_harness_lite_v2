---
name: next
description: Do the next step of the active sdlc change, whatever it is - the one command to remember. Stops only at human gates.
effort: medium
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---
# Next step

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status --json`.
2. **No active change:** ask the person in one question what they want to build, then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill start "<their answer>"` and follow the printed steps.
3. **Human gate** (the active change's `command` starts with `human gate`): show it word for word and stop. Never approve for the person.
4. **Done:** say so and suggest `/sdlc:start "<next task>"`.
5. **Otherwise** the command is `/sdlc:<stage> <slug>`: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill <stage> <slug>` and follow the printed steps exactly, as if that skill had loaded. Never chain stages through the Skill tool.

End with: `Next: /sdlc:next`.
