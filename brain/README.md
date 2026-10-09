# rig-brain

Optional add-on for the [rig](../README.md) harness, shipped from the same repo and marketplace (`rig`) as a second plugin.
rig core does not depend on it and it does not import rig: it reads `.sdlc/` files only, and `scripts/brainboundary.spec.ts` in the
repo root fails if either side imports the other.
Two modules: **code_wiki**, a self-updating, DeepWiki-style code wiki, and **memory**, a self-improving memory of
lessons from past sessions (after Cognition's agent memory repo). Each is optional and configured on its own.

## Install (per project, never global)
The easy way is `/rig:init`: answer yes to the rig-brain step. It edits only the project's `.claude/settings.json`
(`extraKnownMarketplaces.rig` plus `enabledPlugins["rig-brain@rig"]`), seeds `.sdlc/memory/` and builds the first wiki.
By hand, at project scope, from the project root:
```
claude plugin marketplace add <path-or-owner/repo> --scope project
claude plugin install rig-brain@rig --scope project
```
Always pass `--scope project`: the default is user scope, which would enable the plugin in every repo and session.
To try it for one session without installing, `claude --plugin-dir <rig-checkout>/brain`.

## Use
1. `/rig:init` builds the first wiki (or a placeholder one for an empty repo). After that, `/rig-brain:wiki-refresh` rewrites prose only for modules whose code changed.
2. Commit `.sdlc/wiki/` (not `.sdlc/wiki/.cache/`).
3. Hooks mark pages stale as code changes (no model calls). Claude gets `INDEX.md` once per session; `/rig-brain:wiki-find <terms>` locates files.
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

## Memory
Off by default. Turn it on per repo with `.sdlc/memory.json`: `{ "enabled": true }`.
- While Claude works, hooks note failed commands and what fixed them, files edited over and over, tool errors and
  your corrections (`.sdlc/memory/.cache/`, gitignored; secrets redacted). No model calls.
- When Claude stops and at least `minSignals` (3) are pending, at most every `cooldownMin` (30) minutes and
  `maxDreamsPerDay` (6) times a day, a background process makes one tool-less `claude -p` call (model `haiku`) that
  proposes one-line lessons. A deterministic step validates them and writes `.sdlc/memory/*.md` and `MEMORY.md`.
  The dream call runs with `--tools ""`, `--strict-mcp-config`, `--disable-slash-commands` and `--safe-mode`: the
  model gets no built-in tools, no MCP servers, no skills, and no CLAUDE.md, plugins or hooks either. Everything sent to it is redacted.
- Nothing is committed for you: review with `git diff .sdlc/memory` and commit with your work. Session start says
  when memory changed.
- The committed `MEMORY.md` (`git show HEAD`) is injected at session start as context; unreviewed working-tree
  changes are not loaded until committed (outside git, the working-tree file is used). `/rig-brain:memory-find <terms>`, `/rig-brain:memory-forget <id>`,
  `/rig-brain:memory-dream` (run now). `node memory/memory.ts status` shows pending signals and the last dream; the
  dream log is `.sdlc/memory/.cache/log`, rejected proposals `.cache/rejected.jsonl`.
- Config keys: `enabled`, `minSignals`, `cooldownMin`, `maxDreamsPerDay`, `model`, `maxFiles` (12),
  `maxEntriesPerFile` (80).
- Eval: `evals/memory-recall.json`. If memory does not help on at least 4 of 5 tasks, drop its SessionStart hook.

- `node memory/memory.ts seed [--placeholders] [ops.json]` is the one-time setup `/rig:init` runs: it writes `.sdlc/memory.json`
  `{ "enabled": true }` (never over a repo that set `enabled: false`), adds the `add` ops from the file with `source: init`, and with
  `--placeholders` creates the four topic files with fill-in lines. Existing topic files are never overwritten.

## Known limits (v1)
- Import edges: relative TS/JS imports, Python/Java by path suffix, Go partly. Path aliases (`tsconfig` paths), workspace
  package imports (`@org/pkg`), dynamic `import()`/`require` and Python relative imports are not resolved, so a
  monorepo may show fewer dependencies than it has. Pages are never wrong because of this, only less linked.
- The `wiki-writer` agent has the `Read`/`Write` tools and cannot be path-scoped by the plugin; its prompt restricts it
  and `apply` only ever reads `<module>.json` files, validates their shape and deletes them after use.
- TypeScript is loaded from the target repo's `node_modules` (its own dev dependency) when available.

## Develop
`npm test` (no model calls). `npm run test:e2e` (wiki) and `npm run test:e2e:memory` run real pipelines and need `claude` and a key.
Layout: code_wiki/ (wiki), memory/ (lessons), shared/ (helpers both use).
