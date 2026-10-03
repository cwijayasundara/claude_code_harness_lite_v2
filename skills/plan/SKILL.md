---
name: plan
description: Write plan.md for a change - owned files, thin vertical slices with acceptance tests, verification commands, no implementation code - via the Opus architect agent.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Plan for $0

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

1. **Find the files.** Launch one or two `sdlc:scout` agents to find the files and conventions the change touches. Do not read the codebase yourself.
2. **Draft.** Launch `sdlc:architect`, which runs on Opus, with a brief of 40 lines or fewer:
   - the change folder `.sdlc/changes/$0/`
   - "write plan.md"
   - the change type
   - the scout findings, as `path:line` entries with one line each

   Do not draft the plan yourself.
3. **Check.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. If it warns about the plan's size, its code blocks or a missing `## Files`, send the warning back to the architect once.
4. **Resolve questions.** If the architect raised open questions, ask the person with AskUserQuestion (at most 3) and apply the answers with small edits.

Then:
- **Tier M/L:** ask the person to review `plan.md` and run `/sdlc-approve $0 plan`.
- **Tier S:** continue.

End with: `Next: <command from status>`.
