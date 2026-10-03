---
name: handoff
description: Write a short STATE.md so the person can /clear and resume cheaply. Use when context passes ~150k tokens, at natural breaks, or before stepping away.
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Write, Edit
---
# Hand off

Long contexts are the single biggest cost: every turn re-reads the whole conversation.

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status` to find the active change. Then rewrite `.sdlc/STATE.md` in **at most 40 lines**, keeping the frontmatter `change:` line:
   - **Where we are:** stage, and slices done or remaining
   - **Next step:** the exact command
   - **Decisions made** this session that are not yet in an artifact (one line each)
   - **Open questions or blockers**
   - **Key files:** `path:line`, at most 8

   Write facts only, no narrative. Anything durable belongs in the change's artifacts, not here.
2. Tell the person, word for word: `Run /clear, then /sdlc:start <slug> to resume from STATE.md.`
