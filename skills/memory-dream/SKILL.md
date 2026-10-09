---
name: memory-dream
description: Distill lessons from recent sessions into .sdlc/memory/ now. Normally this runs by itself when Claude goes idle; use it to test or to flush pending signals.
allowed-tools: Bash(node:*), Bash(git diff:*)
---
Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/memory/memory.ts dream --now` from the repo root and report its one-line result. Then run `git diff --stat .sdlc/memory` and show it. Never edit `.sdlc/memory/` files yourself; only the dream pipeline writes them. If the result is "nothing to dream", say no signals are pending.
