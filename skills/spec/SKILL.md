---
name: spec
description: Write spec.md for a tier L or greenfield change - numbered testable behaviours, interfaces and open questions - via the Opus architect agent.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Spec for $0

Run each sdlc.ts command as its own Bash call: no `cd`, pipes, redirects, `&&` or shell variables; use the Read and Grep tools to read files; commit messages are one line.

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

1. **Find the relevant code.** Launch one or two `sdlc:scout` agents to find the existing code and contracts the change touches.
2. **Draft.** Launch `sdlc:architect`, which runs on Opus, with a brief of 40 lines or fewer:
   - the change folder `.sdlc/changes/$0/`
   - "write spec.md"
   - the scout findings, as `path:line` entries with one line each

   Do not draft the spec yourself.
3. **Resolve questions.** Put the architect's open questions to the person with AskUserQuestion, at most 4 and only ones that change behaviour. Fold the answers into `spec.md` with small edits. Ask with AskUserQuestion. If you get no answer (a headless run, or the person defers), take your recommended option. Either way, record each as `- Q<n>: <question> → <answer> (person|default)` under `## Decisions`, and leave `## Open questions` as `none`: approval is refused while any question is open, so a build never stalls on one.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. For tier L and greenfield this stage is gated: ask the person to review `spec.md` and run `/sdlc-approve $0 spec`.

End with: `Next: <command from status>`.
