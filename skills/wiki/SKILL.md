---
name: wiki
description: Build or update the code wiki in docs/wiki/ - a map of modules, entry points, data flow and contracts that engineers can browse on GitHub. Run once after init; ship runs the update when pages are stale.
argument-hint: '[update [<slug>]]'
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git diff*), Read, Write, Edit, Glob, Grep, Agent
---
# Code wiki $ARGUMENTS

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running.

## Update (when the first argument is `update` or `docs/wiki/manifest.json` exists)
1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki status --json`. If every list is empty, say "wiki up to date" and stop.
2. For each `stale` page, launch one `rig:wiki` agent (at most 3 per message) with the page path, its globs from the manifest, the change slug (the second argument, or `unreleased` if absent), and the changed files under those globs (`node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts diff --trunk`, which includes the working tree).
3. For each `missing` page, fix its globs in the manifest or delete the page. For each `uncovered` directory, add a manifest entry and launch an agent for it as in Build step 3, or list it under `skip` if it needs no page.
4. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki stamp <page> ...`, naming only the pages you actually wrote. If it reports uncited pages, have their agent add `path:line` citations, then stamp again.

## Build (no manifest yet)
1. Module map: reuse init's scout (a) map if this conversation has it; otherwise launch one `rig:scout`: "list the top-level modules (at most 12), each with its directory globs and one line on what it does".
2. Write `docs/wiki/manifest.json`: `{ "pages": { "modules/<name>.md": { "globs": ["<dir>/**"] } }, "skip": ["<top-level dirs that need no page, e.g. docs, tooling scripts>"] }`.
3. Launch one `rig:wiki` agent per page, at most 3 per message, each with its page path, globs and the scout's line for it.
4. Write `docs/wiki/index.md` yourself, at most 60 lines: what the system is (3 lines), a Mermaid `flowchart LR` of the modules and their main dependencies, and a table `| Module | What it does | Page |`.
5. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki stamp`. If it reports uncited pages, relaunch their agents to add `path:line` citations, then stamp again.

End with the pages written, then `Next: commit docs/wiki/, then /rig:start "<first task>"`.
