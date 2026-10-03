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
   - a first line under the title, verbatim: `sdlc routes all work in this repo: start with /sdlc:start; use superpowers skills only when an sdlc skill names one.`
   - What this is (3 lines)
   - Map (directories, one line each)
   - Commands
   - Conventions
   - Gotchas
   - `# Compact instructions`: keep the active sdlc change, failing tests and file paths; drop exploration output.

   If a `CLAUDE.md` already exists, propose edits as a diff and do not overwrite it.
4. **Code wiki.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill wiki` and follow it, reusing scout (a)'s module map.

## Greenfield
1. Ask up to three questions with AskUserQuestion: stack, deployment target, and test framework (recommend defaults).
2. Scaffold the smallest walking skeleton that builds, plus one passing smoke test, a lint config, and a `Makefile` or package scripts with `test`, `test-fast` and `lint` targets.
3. Write `CLAUDE.md` as above, then `git init` if needed.

## Both
1. **Sensors.** From scout (b), write `.sdlc/sensors.json`: `fast` (lint, typecheck, targeted test; under 60 s together), `full` (full test, coverage, arch if any), `tests` and `contracts` globs if the defaults miss the repo's layout, and `limits`. Also look for an e2e suite (a Playwright config), a way to start the app with a health check, and a benchmark script. Add each found one to `full` as `e2e`, `smoke` or `bench`, and say what each proves. Ask once if none is found and the project has a UI or a service. Ask with AskUserQuestion whether other repos consume this one's API or schema. Each one becomes a `consumers` entry with `name`, `path` (sibling checkout), `repo` (owner/name) and `test`.
2. **Ratchet.** Run each `fast` command once through `sdlc.ts run`. Any that already fail go into `knownRed`, so the gate never blocks on debt it did not create. Tell the person which.
3. **CI.** Offer to run `sdlc.ts vendor` and copy `${CLAUDE_PLUGIN_ROOT}/templates/sdlc-check.yml` to `.github/workflows/`. Say they must make `sdlc-check` a required check, add CODEOWNERS entries for `.sdlc/**` and the workflow, and add an `SDLC_CONSUMERS_TOKEN` secret if any consumer repo is private. Also offer `${CLAUDE_PLUGIN_ROOT}/templates/sdlc-review.yml`: one Claude review per PR, run in the background, failing only on a high-severity finding (needs an `ANTHROPIC_API_KEY` secret). Write the files only on a yes.
4. **Settings.** Show the project settings this harness expects and offer to merge `${CLAUDE_PLUGIN_ROOT}/templates/settings.json` into `.claude/settings.json`. Write them only on a yes.

End with: `Next: /sdlc:start "<first task>"`.
