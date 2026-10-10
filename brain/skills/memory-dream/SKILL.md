---
name: memory-dream
description: Distill lessons from recent sessions into .rig/memory/ now. Normally this runs by itself when Claude goes idle; use it to test or to flush pending signals.
allowed-tools: Bash(node:*), Bash(git diff:*)
---
Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/memory/memory.ts dream --now` from the repo root with a Bash timeout of 600000 ms (the dream can take minutes) and report its one-line result. Then run `git diff --stat .rig/memory` and show it. Never edit `.rig/memory/` files yourself; only the dream pipeline writes them. If the result is "nothing to dream", say no signals are pending.
