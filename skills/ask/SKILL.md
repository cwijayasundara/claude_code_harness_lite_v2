---
name: ask
description: Answer a question about this codebase from the code wiki and the lines it cites. Always cites path:line; says "not found" instead of guessing. Use for "how does X work", "where is Y", "what calls Z".
argument-hint: '"<question>"'
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki search *), Read, Grep, Glob, Agent
---
# Ask the wiki: $ARGUMENTS

**Subagents:** run the scout in the foreground and wait for its result. Never end your turn while it is running.

1. If `docs/wiki/manifest.json` does not exist, say "no code wiki here: run /rig:wiki" and stop.
2. Pick 2 to 5 distinctive words from the question (names, nouns; no filler) and run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts wiki search "<words>" --limit 5`.
3. If it prints `no wiki hits`, try once with different words. Still nothing: answer "not found in the wiki" and suggest `/rig:wiki update`.
4. Launch one `rig:scout` with the question, the top two page paths and their cited `path:line` refs from the search: "answer only from these pages and the lines they cite; cite every claim as path:line; say not found rather than guess".
5. Reply in at most 15 lines: the answer, then the `path:line` citations it rests on, then the wiki pages read. If the scout found nothing, say so plainly.

Never edit anything. Never answer from memory: if the pages and lines do not support a claim, leave it out.
