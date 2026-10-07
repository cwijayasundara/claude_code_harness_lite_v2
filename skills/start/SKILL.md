---
name: start
description: Front door of the sdlc harness. Use for any new software task (feature, bug, refactor, migration, chore, spike, greenfield app) or to resume one. Classifies type and tier, records intent.md, and prints the shortest safe path and the next command.
argument-hint: '"<what you want>" | <existing-slug>'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(gh issue view*), Skill
---
# Start or resume a change

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

Request: $ARGUMENTS

## Resume
If the request is empty or names an existing folder under `.sdlc/changes/`: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts activate <slug>` (when named), then `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`, read that change's artifacts and `.sdlc/STATE.md`, and continue with the printed next command. Stop here.
If the slug starts with `adhoc-`, this is adoption of work done without /rig:start: fill intent.md from the diff (`node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts diff --trunk`), confirm type and tier with the person, then continue with the printed next command (the plan and gates apply).

## New change
1. **Context hygiene.** If this conversation already carries unrelated work, tell the person to `/clear` and rerun this command, and stop.
2. **Repo readiness.** If the repo has source code but no `.sdlc/sensors.json`, the next command is `/rig:init` first. If only CLAUDE.md is missing, say once that `/rig:init` would add it, then continue with this change. If the repo is empty, the type is `greenfield`. If `.sdlc/PREFLIGHT.md` is missing, say once that `/rig:init` (which runs the preflight) has not been completed, then continue.
3. **Classify.**
   - If the request is an issue reference (`#123` or a GitHub issue URL), run `gh issue view <ref> --json title,body,labels` and use it as the request; record the reference in intent.md.
   - Type: greenfield, feature, bugfix, refactor, migration, chore, spike or incident.
   - Tier:
     - **S**: at most 3 files, and no public contract, data or security impact.
     - **M**: at most 15 files, and no public contract, data or security impact.
     - **L**: auth, payments, data migration, security, a public API or contract change, or more than 15 files.

   Delegate any code lookup to the `rig:scout` agent. Do not read files yourself. Ask at most two questions with AskUserQuestion, and only when the type, tier or outcome is genuinely ambiguous.
4. **Record.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts new <kebab-slug> --type <type> --tier <S|M|L> --title "<title>"`. Then fill in `intent.md` in at most 40 lines covering problem, outcome (how we will check it), non-goals and risks.
   - Spike: also answer the question in `notes.md` in at most one page, then stop.
   - **Explicit defaults.** For each optional input you did not get (non-goals, risks, rollout), ask once with AskUserQuestion if it changes the tier or the gates; otherwise record the default you took in `## Decisions`. Never leave a guess unrecorded.
5. **Tier S fast path** (any type except spike and greenfield). Ceremony must cost less than the change: write a minimal `plan.md` of 15 lines or fewer (`## Files` and `## Verification` only), then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill build <slug>` and follow it in this turn. Tier S builds inline with no subagents.
6. **Path.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status` and show the person the path for this type and tier. Gates come from .sdlc/sensors.json "gates" (default: one `design` gate for tier M, L and greenfield that approves intent.md and design.md together, none for S; features go intent → design → autonomous build).

7. **Feature and greenfield go straight to design.** Do not stop after intent.md: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill design <slug>` and follow it in this turn. The person is asked once, for intent.md and design.md together.

End with exactly one line: `Next: <command from status>`.
