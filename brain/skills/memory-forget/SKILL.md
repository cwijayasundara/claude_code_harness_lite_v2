---
name: memory-forget
description: Remove one memory entry by id (m-...) when it is wrong or outdated.
allowed-tools: Bash(node:*)
---
Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/memory/memory.ts forget <id>` and report the result. If you do not know the id, run `memory.ts find <terms>` first and confirm the entry with the user before removing it.
