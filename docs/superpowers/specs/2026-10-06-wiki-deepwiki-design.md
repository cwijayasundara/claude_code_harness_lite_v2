# Spec 6: a DeepWiki-class code wiki (computed diagrams, a "why" layer, search, auto-refresh)

Status: design for review · 2026-10-06 · extends the code wiki of `DESIGN.md` §§ on `/rig:wiki` and spec 5 (`2026-10-06-everywhere-enforcement-design.md`). Builds on `scripts/wiki.ts`, `agents/wiki.md`, `skills/wiki/SKILL.md`.

## 1. Problem

The engineering team reads `docs/wiki/`. Today each page is one model-written block: a paragraph, up to 10 `path:line` bullets, entry points, a data-flow list, contracts, tests, recent changes (`agents/wiki.md`). It is accurate when written and nothing verifies it afterwards beyond a hash of the module's exported lines (`wiki.ts:28-31`). Compared with Devin's DeepWiki (<https://docs.devin.ai/work-with-devin/deepwiki>: architecture diagrams, links to sources, summaries, Ask, steering file, auto-generation) it has four gaps:

| # | Gap | Evidence |
|---|---|---|
| 1 | **No architecture diagram a reader can trust.** The only diagram is a model-drawn Mermaid `flowchart` in `index.md`, with nothing checking its edges. | `skills/wiki/SKILL.md` Build step 4 |
| 2 | **Dense reference, little orientation.** A newcomer gets bullets of `path:line`, not "what is this for, and what happens when a request arrives". | `agents/wiki.md` sections |
| 3 | **No way to ask or search.** A reader greps the repo; an agent re-reads files. | no `wiki search` command |
| 4 | **Refresh is manual.** Pages go stale and `wiki-stale` only warns at ship, commit and CI; nothing rewrites them. | `check.ts:314`, `skills/wiki/SKILL.md` Update |

rig also holds something DeepWiki cannot: the *reason* code changed. Every change keeps its intent, design and plan in `.sdlc/changes/<slug>/`. This spec uses it.

## 2. Decisions already made (with the person)

| Decision | Choice |
|---|---|
| Overall approach | **A: a computed layer plus a prose layer.** Scripts own generated blocks; the model owns only the human-written parts. |
| Diagrams | **Computed from imports** by a zero-token script reading a per-language pattern table (JS/TS and Python first). A language with no table row falls back to a model-drawn diagram marked as such. |
| Refresh | **Zero-token regeneration plus a model-written PR for prose.** Generated blocks are rebuilt by script on every merge; stale prose is rewritten by a workflow that opens one PR and needs a model secret. |
| Ask | **A zero-token `wiki search` CLI plus a `/rig:ask` skill** (a Haiku scout answers from the wiki and the cited lines). No MCP server in this version. |
| Language knowledge | Lives in **data tables**, not code (spec 1: stack-agnostic, no per-language adapters). |
| Page audience | The engineering team: reference quality and orientation both matter. |

## 3. Non-goals

- No MCP server and no static site. GitHub renders Markdown and Mermaid already.
- No import resolution beyond JS/TS and Python in this version. Other languages get the model-drawn fallback and a one-line pointer to add a table row.
- No indexing of other repositories (DeepWiki's public-repo service) and no hosted UI.
- No change to how `stale` is judged for prose pages: the surface hash stays (`wiki.ts:28-31`).
- Not a documentation generator for APIs; contracts stay in `## Contracts` for prose and in the existing `contracts` config.

## 4. Design

### 4.1 Page anatomy

Each module page (`docs/wiki/modules/<name>.md`), in this order. `[gen]` blocks are owned by scripts and sit between `<!-- rig:gen:NAME -->` and `<!-- /rig:gen -->`; `[prose]` is written by the `rig:wiki` agent.

1. `# <module>` and a one-line summary `[prose]`.
2. `## In plain words` `[prose]`: 3-4 sentences, no jargon: what the module is for and what breaks without it.
3. `## Architecture` `[gen:architecture]`: a Mermaid `flowchart LR` with this module centred, the modules it imports on one side, its dependents on the other, edges labelled with the import count. At most 12 neighbours; the rest collapse into one `+N more` node.
4. `## Walk-through` `[prose]`: one concrete request traced through the module, every step cited `path:line`.
5. `## Key files` `[gen:files]`: file, role (the first doc comment line when there is one), line count, link. `## Entry points` `[gen:entrypoints]`: exported symbols from the existing `SURFACE` lines, each linking to `file#Lnn`. `## Depends on / used by` `[gen:deps]`: internal modules and the five most-used external packages. `## Tests` `[gen:tests]`: test files matching the module's globs, with test names where a pattern table row exists.
6. `## Why it looks like this` `[gen:why]`: changes under `.sdlc/changes/` whose plan `## Files` (`planFiles`, `core.ts:282`) match this module's files, newest first, at most 8, each as `slug · type · first line of intent.md` linking to the change folder; commits that touched the module without a change record are listed by subject from `git log`.
7. `## Recent changes` `[gen:recent]`: the last 10 commits touching the module's files.

Links are `https://github.com/<owner>/<repo>/blob/<default branch>/<path>#L<n>` when an `origin` remote is a GitHub URL, else repo-relative paths. Citations written by the agent in prose stay `path:line` text so the existing `CITATION` check (`wiki.ts:10`) still works; generated rows carry both.

`docs/wiki/index.md` is generated, with two model-written parts. `[gen]`: a whole-system `flowchart` of every module and its edges (above 30 modules, clustered by top-level directory), a "Start here" reading order (most-depended-on modules first), and a module table whose summary column is each page's one-line summary. `[prose]`: a short "I want to… → read this page" table.

### 4.2 The module graph (`scripts/wikigraph.ts`, new)

- **Module** = a manifest page; a file belongs to the first page (sorted) whose globs match it.
- **Import table** (`IMPORT_TABLE`, data): rows of `{ exts, patterns, resolve }`. JS/TS: `.ts .tsx .js .jsx .mjs .cjs`, patterns for `import … from 'x'`, `import 'x'`, `require('x')`, `import('x')`; resolver `relative` (resolve against the file's directory with extension candidates, a `.js` to `.ts` swap, and `/index.*`). Python: `.py`, patterns for `from .a import b`, `from pkg.mod import x`, `import pkg.mod`; resolver `dotted` (relative by leading dots; absolute by trying the repo root and `src/` for `pkg/mod.py` or `pkg/mod/__init__.py`).
- **Output**: `edges: Map<from module, Map<to module, count>>`, `external: Map<module, Map<package, count>>`, and `unresolved: string[]` (internal-looking specifiers that matched no file). Self-edges are dropped. Comment-only lines are ignored with the same guard `layering` uses (`sensors.ts:111`).
- **A language with no row** yields no edges for its files; the `architecture` block then says "edges not computed for <ext>: add a row to `IMPORT_TABLE`", and the page uses a model-drawn diagram marked `<!-- rig:drawn -->`.

### 4.3 Generation (`scripts/wikigen.ts`, new) and the commands

- `wikigen.ts` renders each block from the graph, the manifest, `git ls-files` and `.sdlc/changes/`, and splices it between its markers, creating a missing block at its place in the template. Prose outside markers is never touched, byte for byte.
- `sdlc.ts wiki build` regenerates every generated block and `index.md` for every page in the manifest (no model, no tokens). `wiki build --check` regenerates in memory and exits 1 with a unified-diff summary if any committed generated block differs, like a formatter check.
- `--check` and `status.generated` compare only the **structural** blocks (`architecture`, `files`, `entrypoints`, `deps`, `tests`, and the three index blocks). The `why` and `recent` blocks derive from git history and `.sdlc/changes/`; `build` refreshes them but nothing enforces them, because every code PR would otherwise fail the check.
- `sdlc.ts wiki status` gains two finding kinds beside `stale`, `missing`, `uncovered`: `generated` (blocks differ from a rebuild) and `prose` (a required prose heading is missing or empty). `wikiFindings()` maps both to `warn`, as today.
- `sdlc.ts wiki stamp` keeps its citation check and also requires the prose headings (`In plain words`, `Walk-through`); a page that lacks them stays unstamped, so it reads as stale.
- **Steering** (`docs/wiki/manifest.json`, spec 5 style): new optional keys `notes: string[]` (free-text repo notes handed to the wiki agent, at most 10,000 characters each) and `order: string[]` (page order for "Start here"). Unknown keys are an error, as in `sensors.json`.
- `agents/wiki.md` is rewritten to write the prose sections only and to read, never edit, the generated blocks; `skills/wiki/SKILL.md` runs `wiki build` first, then launches the agent only for pages whose prose is stale or missing.

### 4.4 Search and ask

- `sdlc.ts wiki search "<terms>" [--json] [--limit n]`: builds an in-memory index on each call from the page text, the generated entry-point rows and the manifest file lists, scores each page by weighted term hits (title 3, headings 2, symbols 2, body 1), breaks ties alphabetically, and prints `page · path:line` hits. Deterministic, zero tokens, no persistent index.
- `skills/ask/SKILL.md` (`/rig:ask "<question>"`): runs `wiki search`, reads the top pages and the cited lines with the `rig:scout` agent (Haiku, read-only), and answers in at most 15 lines. Every claim carries a `path:line` citation and anything not found is stated as "not found".

### 4.5 Refresh (`templates/rig-wiki.yml`)

On every push to the default branch:
1. **Zero-token step:** `wiki build`. If the tree changed, the job commits the result to a `rig/wiki-refresh` branch.
2. **Model step (only when `wiki status --json` lists stale or prose-missing pages and a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret exists):** the job runs the `rig:wiki` agent for those pages, then `wiki stamp`.
3. **One PR** from `rig/wiki-refresh` is opened or updated with a summary of what was regenerated and which pages were rewritten. Without the secret, the PR contains step 1 only and the summary says which pages need a rewrite.

Nothing is pushed to the default branch directly. `rig-check` still judges the PR with the base branch's checker. `/rig:init` offers the workflow beside `rig-check.yml` and `rig-review.yml`.

## 5. Components and sizes

| File | Change |
|---|---|
| `scripts/wikigraph.ts` (new) | `IMPORT_TABLE`, `buildGraph`, resolvers (about 170 lines) |
| `scripts/wikigen.ts` (new) | block renderers, marker splice, link builder, Mermaid emit (about 220 lines) |
| `scripts/wikisearch.ts` (new) | the pure ranking function (about 60 lines), kept apart so `wiki.ts` stays under the 500-line script cap |
| `scripts/wiki.ts` | `build`, `build --check`, `search`, new status kinds, steering keys (about 140 lines added) |
| `scripts/vendor.ts`, `scripts/sdlc.ts` | vendor the two modules; no new top-level command |
| `agents/wiki.md`, `skills/wiki/SKILL.md`, `skills/ask/SKILL.md` (new) | prose-only agent; build-first skill; the ask skill |
| `templates/rig-wiki.yml` (new), `skills/init/SKILL.md` | the refresh workflow and its offer |
| `README.md`, `DESIGN.md`, `CHANGELOG.md` | what fires when, commands atlas, §17 |

About 550 added lines. `scripts/size.spec.ts` caps the harness (6450 after the guard fix), so the cap rises to the measured total rounded up to the next 50, as in specs 5 and the 0.4.1 release; this is stated in DESIGN.

## 6. Testing (test first)

Each is a `scripts/wiki*.spec.ts` case using `testkit.ts` temp repos; each fails before the code exists.

1. **Graph, JS/TS**: relative imports, `index`, `.js` to `.ts` swap, dynamic `import()`, `require`, a comment-only import ignored, an external package counted, an unresolved internal specifier reported.
2. **Graph, Python**: relative dots, absolute dotted under repo root and `src/`, `__init__.py` packages.
3. **Language fallback**: a `.go` module gets no edges, the block carries the "edges not computed" line, and `<!-- rig:drawn -->` is honoured by `build --check`.
4. **Build is idempotent**: two builds produce identical bytes; prose is preserved byte for byte, including when a generated block is deleted and recreated.
5. **`build --check`** exits 0 on a fresh build, exits 1 after a source file's imports change, and prints which page and block differ.
6. **Mermaid**: golden output for a 3-module repo; node IDs are sanitised; more than 12 neighbours collapses into `+N more`; the index clusters above 30 modules.
7. **Why block**: a change whose plan `## Files` matches lists with slug, type and intent line; an ad-hoc commit lists by subject; at most 8 rows.
8. **Links**: a GitHub `origin` yields blob URLs with `#L`; no remote yields relative paths.
9. **Status and stamp**: a missing `In plain words` heading yields a `prose` finding and an unstamped page; a changed import yields a `generated` finding; `stale` behaves as before.
10. **Steering**: `notes` and `order` parse; an unknown key is an error; an over-long note is an error.
11. **Search**: ranking is deterministic; title beats body; ties break alphabetically; `--json` and `--limit` work; no match prints a clear message and exits 0.
12. **Workflow template**: a lint test asserts `rig-wiki.yml` has no secret in the zero-token step and opens a PR instead of pushing to the default branch.

## 7. Risks

- **Heuristic import extraction misses dynamic or generated imports** (computed specifiers, aliases, path mappings, monorepo package names). Mitigation: `unresolved` is reported in the block, and an alias-map entry in the manifest (`aliases: { "@app/*": "src/*" }`) is a follow-up if real repos need it.
- **A rebuild changes many generated blocks at once** (a rename, a large refactor), producing a noisy PR. Mitigation: blocks are deterministic and sorted, so a diff shows only real changes.
- **The "why" layer depends on plan `## Files` being filled in.** Chores and ad-hoc changes have none, so they fall back to commit subjects.
- **The model step can drift the prose.** It only runs for pages whose surface changed, and the PR is reviewed by a person.
- **Cost of the scheduled model step** is bounded by the number of stale pages; it never runs without the secret.

## 8. Open points for the reviewer

1. **Generated-link base.** GitHub blob URLs make pages readable in the browser but pin the default branch; repo-relative links work offline and in forks but break in some renderers. Proposed: GitHub URLs when `origin` is GitHub, else relative.
2. **Alias maps** for TS path mappings and monorepo package names are left out of v1 (§7). Say if they should be in.
