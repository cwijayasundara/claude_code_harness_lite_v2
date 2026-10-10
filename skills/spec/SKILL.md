---
name: spec
description: Write spec.md for a tier L or greenfield change - numbered testable behaviours, interfaces and open questions - via the Opus architect agent.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Spec for $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Models:** read `routes` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` and pass that role's `model` and `effort` on every launch: `rig:architect` (architect), `rig:implementer` (implementer), `rig:reviewer` (`slice-review` in build, `reviewer` elsewhere). A `main` route means draft it in this thread. After a failed round, run that command again before the fix launch: the implementer route can rise.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

1. **Find the relevant code** with one or two `rig:scout` agents (existing code and contracts the change touches). For a question about an external library, API or tool, launch one `rig:researcher` instead of reading docs yourself.
2. **Draft.** Launch `rig:architect` (Opus) with a brief of at most 40 lines: the change folder `.rig/changes/$0/`, "write spec.md", the format file `${CLAUDE_PLUGIN_ROOT}/templates/design-format.md` and the scout findings as `path:line` entries. Do not draft the spec yourself. Apply every policy skill (`.claude/skills/policy-*/SKILL.md`; list them with Glob and give the architect their paths): each conflict or gap is a `## Concerns` bullet `- [policy-<area>] <concern> → owner: <its owner:>`. Approval is refused until each carries ` → resolved: <decision> (<owner>)`; tell the person which owner to ask.
3. **Resolve questions** the architect raised (at most 4). Record each answer as `- Q<n>: <question> → <answer> (person|default)` under `## Decisions` and leave `## Open questions` as `none`: approval is refused while one is open. Ask with AskUserQuestion only when the answer changes behaviour; with no answer (headless, or the person defers) take your recommended option.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. For tier L and greenfield this stage is gated: ask the person to review `spec.md` and run `/rig:approve $0 spec`.

End with: `Next: <command from status>`.
