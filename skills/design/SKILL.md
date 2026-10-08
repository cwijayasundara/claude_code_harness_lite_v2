---
name: design
description: Write design.md for a feature or greenfield change - approach, owned files, thin vertical slices with acceptance tests, verification commands, no implementation code. One human approval covers intent.md and design.md together; the build then runs without a person.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Design for $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Models:** pass `model` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` on every `rig:architect`, `rig:implementer` and `rig:reviewer` launch.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

`intent.md` is written. This stage writes `design.md` and ends at the **one** human gate of a feature: the person approves intent.md and design.md together, and everything after (build, test, sensors, PR) runs on its own.

1. **Find the files** with one or two `rig:scout` agents; do not read the codebase yourself.
2. **Draft.** Tier S and M (not greenfield): write `design.md` yourself in the format of `${CLAUDE_PLUGIN_ROOT}/templates/design-format.md`. Tier L or greenfield: launch `rig:architect` (Opus) with a brief of at most 40 lines: the change folder `.sdlc/changes/$0/`, "write design.md", the format file `${CLAUDE_PLUGIN_ROOT}/templates/design-format.md`, the change type and the scout findings as `path:line` entries. Apply every policy skill (`.claude/skills/policy-*/SKILL.md`; list them with Glob and give the architect their paths): each conflict or gap is a `## Concerns` bullet `- [policy-<area>] <concern> → owner: <its owner:>`.
3. **Check** with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`; fix size, code-block or `## Files` warnings (tier L: send back once).
4. **Impact.** `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts check --at plan --slug $0`. Consumer references make the change tier L: name the repos, and put the consumer files in `## Files` and each consumer's test in `## Verification`.
5. **Decide, do not stall.** Take the recommended answer for every open question; ask (at most 3, only when it changes behaviour). Record each answer as `- Q<n>: <question> → <answer> (person|default)` under `## Decisions` and leave `## Open questions` as `none`: approval is refused while one is open. Ask with AskUserQuestion only when the answer changes behaviour; with no answer (headless, or the person defers) take your recommended option. A `## Concerns` bullet blocks approval until it carries `resolved:`; tell the person which owner to ask.

If the run is `--plan-only` (the rig-spec workflow), stop after design.md and its checks: do not ask for approval and do not build; end with `Next: review the pull request`.

Otherwise ask for the single approval. The sdlc mod shows an Approve / Not yet dialog when this turn ends, and approving it starts the build. Without the mod, tell the person to run `/rig-approve $0 design`.

Otherwise end with: `Next: <command from status>`.
