---
name: onboard
description: One-time setup of a repo for the sdlc harness. Brownfield writes a compact CLAUDE.md from a cheap parallel scout sweep; greenfield scaffolds a walking skeleton with test and lint commands. Never rerun per task.
argument-hint: '[greenfield "<stack and goal>"]'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Onboard this repo

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts init` first.

## Brownfield (source code exists)
1. Launch three `sdlc:scout` agents **in one message** so they run in parallel:
   - (a) stack, entry points and a module map;
   - (b) the exact build, test, lint and type-check commands, including a fast targeted test command and how to make output quiet;
   - (c) conventions, gotchas, environment setup and things that must never be done.
2. Verify the fast test command by running it once with quiet output.
3. Write `CLAUDE.md` in **at most 120 lines**. Sections:
   - What this is (3 lines)
   - Map (directories, one line each)
   - Commands
   - Conventions
   - Gotchas
   - `# Compact instructions`: keep the active sdlc change, failing tests and file paths; drop exploration output.

   If a `CLAUDE.md` already exists, propose edits as a diff and do not overwrite it.

## Greenfield
1. Ask up to three questions with AskUserQuestion: stack, deployment target, and test framework (recommend defaults).
2. Scaffold the smallest walking skeleton that builds, plus one passing smoke test, a lint config, and a `Makefile` or package scripts with `test`, `test-fast` and `lint` targets.
3. Write `CLAUDE.md` as above, then `git init` if needed.

## Both
Show the person the project settings this harness expects and offer to merge them into `.claude/settings.json`. Write them only on a yes. The template is `${CLAUDE_PLUGIN_ROOT}/templates/settings.json`, which:
- enables `sdlc` and disables unrelated plugins
- sets `model: sonnet`, `advisorModel: opus` and `autoCompactWindow: 200000`
- adds the `.sdlc/**` edit allow rule

End with: `Next: /sdlc:start "<first task>"`.
