---
name: wiki-refresh
description: Refresh the repo's code wiki (.sdlc/wiki): rewrite prose only for modules whose code changed, then rebuild deterministic sections and INDEX.md.
allowed-tools: Bash(node:*), Read, Agent
---
Run from the repo root. `W="node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/wiki.ts"`.

1. `$W index`, then `$W plan --json`. If `prose` is empty and `architecture` is false, run `$W apply` and stop.
2. For each task in `prose`, launch the `wiki-writer` agent (model `haiku`, foreground) with the module name only. Launch in one message so they run together. If `architecture` is true, launch it once more for `_architecture` after the others finish.
3. Run `$W apply` and report its counts and any `problem` lines verbatim. Modules in `pending` keep their old page and are marked stale.
4. Do not edit pages by hand except inside `<!-- keep -->` blocks.
