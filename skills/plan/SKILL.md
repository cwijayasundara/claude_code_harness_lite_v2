---
name: plan
description: Write plan.md for a change - owned files, thin vertical slices with acceptance tests, verification commands, no implementation code - via the Opus architect agent.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Plan for $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Models:** pass `model` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` on every `rig:architect`, `rig:implementer` and `rig:reviewer` launch.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

1. **Find the files.** Launch one or two `rig:scout` agents for the files and conventions the change touches. Do not read the codebase yourself.
2. **Draft.** Tier S and M (not greenfield): write `plan.md` yourself in the format of `${CLAUDE_PLUGIN_ROOT}/templates/design-format.md`; an Opus subagent costs more than it saves. Tier L or greenfield: launch `rig:architect` (Opus) with a brief of at most 40 lines: the change folder `.sdlc/changes/$0/`, "write plan.md", the format file `${CLAUDE_PLUGIN_ROOT}/templates/design-format.md`, the change type and the scout findings as `path:line` entries. For tier L, do not draft it yourself. Apply every policy skill (`.claude/skills/policy-*/SKILL.md`; list them with Glob and give the architect their paths): each conflict or gap is a `## Concerns` bullet `- [policy-<area>] <concern> → owner: <its owner:>`. Approval is refused until each carries ` → resolved: <decision> (<owner>)`; tell the person which owner to ask.
3. **Check.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. If it warns about size, code blocks or a missing `## Files`, fix it (tier S/M) or send it back to the architect once (tier L).
4. **Impact.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts check --at plan --slug $0`. If it reports consumer references the change is now tier L: tell the person which repos are affected, make sure `## Files` lists the consumer files and `## Verification` each consumer's test, and say `/rig-approve $0 impact` is required before build.
5. **Resolve questions** the architect raised (at most 3). Record each answer as `- Q<n>: <question> → <answer> (person|default)` under `## Decisions` and leave `## Open questions` as `none`: approval is refused while one is open. Ask with AskUserQuestion only when the answer changes behaviour; with no answer (headless, or the person defers) take your recommended option.

Then: tier L or greenfield, ask the person to review plan.md (and impact.json when present) and run `/rig-approve $0 plan` (and `impact`). Tier S and M: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it in this turn.

End with: `Next: <command from status>`.
