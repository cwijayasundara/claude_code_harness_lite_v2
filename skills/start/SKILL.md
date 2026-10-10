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

If the request ends with `--plan-only` (the rig-spec workflow passes it), drop it from the request and stop after intent.md, and design.md for a feature or greenfield change: never build in that run, whatever the tier, and end with `Next: review the pull request`.

## Resume
If the request is empty or names an existing folder under `.rig/changes/`: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts activate <slug>` (when named), then `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`, read that change's artifacts and `.rig/STATE.md`, and continue with the printed next command. If that change's intent.md has `source:` and it has a design.md or plan.md, run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts check --at plan --slug <slug>` once before continuing, so impact is re-derived (it was not published). Stop here. With `--plan-only`, do not resume a build: report the change's status and stop.
If the slug starts with `adhoc-`, this is adoption of work done without /rig:start: fill intent.md from the diff (`node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts diff --trunk`), confirm type and tier with the person, then continue with the printed next command (the plan and gates apply).

## New change
1. **Context hygiene.** If this conversation already carries unrelated work, tell the person to `/clear` and rerun this command, and stop.
2. **Repo readiness.** If the repo has source code but no `.rig/sensors.json`, the next command is `/rig:init` first. If only CLAUDE.md is missing, say once that `/rig:init` would add it, then continue with this change. If the repo is empty, the type is `greenfield`. If `.rig/PREFLIGHT.md` is missing, say once that `/rig:init` (which runs the preflight) has not been completed, then continue.
3. **Classify.**
   - If the request is an issue reference (`#123` or a GitHub issue URL), run `gh issue view <ref> --json title,body,labels` and use it as the request; record the reference in intent.md.
   - If the request is a file under `.rig/intent/`, read it: its body is the request, and its `type:` and `tier:` frontmatter, when present, are the classification. Pass `--source <that path>` to `new` in step 4 and carry its sections into intent.md.
   - Type: greenfield, feature, bugfix, refactor, migration, chore, spike or incident.
   - Tier:
     - **S**: at most 3 files, and no public contract, data or security impact.
     - **M**: at most 15 files, and no public contract, data or security impact.
     - **L**: auth, payments, data migration, security, a public API or contract change, or more than 15 files.

   Delegate any code lookup to the `rig:scout` agent. Do not read files yourself. Ask at most two questions with AskUserQuestion, and only when the type, tier or outcome is genuinely ambiguous.
4. **Record.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts new <kebab-slug> --type <type> --tier <S|M|L> --title "<title>"`. Then fill in `intent.md` in at most 40 lines covering problem, outcome (how we will check it), non-goals and risks.
   - Spike: also answer the question in `notes.md` in at most one page, then stop.
   - **Explicit defaults.** For each optional input you did not get (non-goals, risks, rollout), ask once with AskUserQuestion if it changes the tier or the gates; otherwise record the default you took in `## Decisions`. Never leave a guess unrecorded.
5. **Tier S fast path** (not with `--plan-only`; any type except spike and greenfield). Ceremony must cost less than the change: write a minimal `plan.md` of 15 lines or fewer (`## Files` and `## Verification` only), then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill build <slug>` and follow it in this turn. Tier S builds through one Haiku implementer subagent (the build skill passes the model).
6. **Path.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status` and show the person the path for this type and tier. Gates come from .rig/sensors.json "gates" (default: one `design` gate for tier M, L and greenfield that approves intent.md and design.md together, none for S; features go intent → design → autonomous build).

7. **Feature and greenfield go straight to design.** Do not stop after intent.md: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill design <slug>` and follow it in this turn. The person is asked once, for intent.md and design.md together. With `--plan-only`, tell the design skill so, and stop when it has written design.md.

Otherwise end with exactly one line: `Next: <command from status>`.
