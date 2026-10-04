---
name: design
description: Write design.md for a feature or greenfield change - approach, owned files, thin vertical slices with acceptance tests, verification commands, no implementation code. One human approval covers intent.md and design.md together; the build then runs without a person.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Design for $0

Run each sdlc.ts command as its own Bash call: no `cd`, pipes, redirects, `&&` or shell variables; use the Read and Grep tools to read files; commit messages are one line.

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

`intent.md` is already written (problem, outcome, non-goals, risks). This stage writes `design.md` and ends at the **one** human gate of a feature: the person approves intent.md and design.md together, and everything after it (build, test, sensors, PR) runs on its own.

1. **Find the files.** Launch one or two `rig:scout` agents to find the files and conventions the change touches. Do not read the codebase yourself.
2. **Draft.** **Tier S and M (not greenfield):** write `design.md` yourself in the format `agents/architect.md` gives for the design document. **Tier L or greenfield:** launch `rig:architect`, which runs on Opus, with a brief of 40 lines or fewer: the change folder `.sdlc/changes/$0/`, "write design.md", the change type, and the scout findings as `path:line` entries with one line each. For tier L, do not draft it yourself.
3. **Check.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. If it warns about size, code blocks or a missing `## Files`, fix it (tier S/M) or send it back to the architect once (tier L).
4. **Impact.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts check --at plan --slug $0`. If it reports consumer references, the change is now tier L: tell the person which repos are affected and make sure `## Files` lists the consumer files and `## Verification` lists each consumer's test.
5. **Decide, do not stall.** Take the recommended answer for every open question. Ask the person only when it changes behaviour, with AskUserQuestion (at most 3); with no answer, take your recommended option. Record each as `- Q<n>: <question> → <answer> (person|default)` under `## Decisions`, and leave `## Open questions` as `none`: approval is refused while any question is open.

Then ask for the single approval. The sdlc mod shows an Approve / Not yet dialog when this turn ends; approving it also starts the autonomous build. Without the mod, tell the person to run `/rig-approve $0 design`.

End with: `Next: <command from status>`.
