---
name: wiki
description: Build or update the code wiki in docs/wiki/: scripts generate the diagrams, tables and links; a small agent writes only the plain-words prose. Run once after init; ship runs the update when pages are stale.
argument-hint: '[update [<slug>]]'
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git diff*), Read, Write, Edit, Glob, Grep, Agent
---
# Code wiki $ARGUMENTS

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running.

## Update (when the first argument is `update` or `docs/wiki/manifest.json` exists)
1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki build`: it regenerates every generated block (zero tokens).
2. Run `... sdlc.ts wiki status --json`. If `stale`, `prose`, `missing` and `uncovered` are all empty, say "wiki up to date" and stop. If `invalid` is non-empty, run `wiki build` for the reasons and fix the manifest first.
3. For each page in `stale` or `prose`, launch one `rig:wiki` agent (at most 3 per message) with the page path, its globs, the manifest `notes`, the change slug (the second argument, or `unreleased`), and the changed files under those globs (`... sdlc.ts diff --trunk`).
4. For each `missing` page, fix its globs in the manifest or delete the page. For each `uncovered` directory, add a manifest entry (then run `wiki build`, which creates its page skeleton) and launch an agent for it, or list it under `skip`.
5. Run `... sdlc.ts wiki build` again (it refreshes the index summaries), then `... sdlc.ts wiki stamp <page> ...`, naming only the pages an agent wrote. If it reports uncited pages or missing prose sections, have that page's agent fix them, then stamp again.

## Build (no manifest yet)
1. Module map: reuse init's scout (a) map if this conversation has it; otherwise launch one `rig:scout`: "list the top-level modules (at most 12), each with its directory globs and one line on what it does".
2. Write `docs/wiki/manifest.json`: `{ "pages": { "modules/<name>.md": { "globs": ["<dir>/**"] } }, "notes": [], "skip": ["<top-level dirs that need no page>"] }`. Put anything an engineer should know first (entry points, conventions) in `notes`.
3. Run `... sdlc.ts wiki build`: it writes a skeleton page per module with every generated block, and `index.md`.
4. Launch one `rig:wiki` agent per page, at most 3 per message, each with its page path, globs, the manifest `notes` and the scout's line for it.
5. Write the two prose parts of `docs/wiki/index.md` yourself (`## What this is`, 3 lines; `## I want to…`, a short table `| I want to | Read |`), at most 15 lines.
6. Run `... sdlc.ts wiki build`, then `... sdlc.ts wiki stamp`. If it reports uncited pages or missing prose, relaunch their agents, then stamp again.

End with the pages written, then `Next: commit docs/wiki/, then /rig:start "<first task>"`.
