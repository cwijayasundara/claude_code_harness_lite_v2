# rig-util

Optional add-ons for the [rig](../claude_code_harness_lite_v2) harness. rig core does not depend on it.
Module 1: **wiki**, a self-updating, DeepWiki-style code wiki for people and agents. (Module 2, an RSI loop, is planned.)

## Install
```
/plugin marketplace add <path-or-github>/rig-util
/plugin install rig-util@rig-util
```

## Use
1. `/rig-util:wiki-refresh` in a repo. Prose is written only for modules whose code changed.
2. Commit `.sdlc/wiki/` (not `.sdlc/wiki/.cache/`).
3. Hooks mark pages stale as code changes (no model calls). Claude gets `INDEX.md` once per session; `/rig-util:wiki-find <terms>` locates files.
4. Optional CI: copy `templates/rig-wiki.yml` for a stale-page warning.

## Read it
Open `.sdlc/wiki/` as an Obsidian vault for the graph view, or browse it on GitHub (Mermaid renders). No server needed.

## Config `.sdlc/wiki.json` (all optional)
`moduleRoots` (default `src, scripts, packages/*, lib, app`), `modules` (glob to module name), `maxPages` (25), `ignore` (globs).
rig's `.sdlc/sensors.json` `ignore` is honored too.

## Relationship to rig
Reads `.sdlc/changes/*`, `.sdlc/sensors.json` and `.sdlc/bin/VERSION` only (rig >= 0.6.0); works without rig.

## Search-cost eval
`evals/wiki-search.json` pairs five code-location questions run with and without the index. If the index does not cut
Glob/Grep calls on at least 4 of 5 without lowering correctness, remove the `UserPromptSubmit` hook and keep the wiki for humans.

## Known limits (v1)
- Import edges: relative TS/JS imports, Python/Java by path suffix, Go partly. Path aliases (`tsconfig` paths), workspace
  package imports (`@org/pkg`), dynamic `import()`/`require` and Python relative imports are not resolved, so a
  monorepo may show fewer dependencies than it has. Pages are never wrong because of this, only less linked.
- The `wiki-writer` agent has the `Read`/`Write` tools and cannot be path-scoped by the plugin; its prompt restricts it
  and `apply` only ever reads `<module>.json` files, validates their shape and deletes them after use.
- TypeScript is loaded from the target repo's `node_modules` (its own dev dependency) when available.

## Develop
`npm test` (no model calls). `npm run test:e2e` runs the real pipeline and needs `claude` and a key.
