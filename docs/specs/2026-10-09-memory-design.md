# rig-util: memory module design (and package restructure)

Date: 2026-10-09. Status: draft for review.

## 1. Purpose

Agents repeat mistakes across sessions: the same failing command, the same ruled-out approach, the same thing the
user already corrected. `memory` is rig-util's second module, a self-improvement loop modeled on Cognition's Agent
Memory Repo (https://cognition.com/agent-memory-repo): a git-tracked folder of markdown notes that Claude reads at
session start and that a background "dream" agent keeps current from what happened while Claude was active.

It complements the `code_wiki` module (what the code is) with lessons (how to work in this repo). Unlike Claude
Code's per-user auto memory, it is repo-scoped and committed, so teammates and CI agents share it.

Success criteria:
- After a session where a command failed and was then fixed, or the user corrected Claude, a one-line lesson appears
  under `.sdlc/memory/` without anyone asking, visible in `git diff`.
- A later session that needs that lesson uses it: fewer failed commands and turns on the recall eval (section 9).
- Hooks never call a model and never block a turn. With the module disabled, hook cost is near zero.
- `npm test` makes no model calls.

## 2. Package restructure (step 0)

rig-util stays one plugin. Code moves from flat `scripts/` into two top-level packages plus a small shared folder.
Claude Code discovers `skills/`, `agents/` and `hooks/hooks.json` at the plugin root, so those stay at the root and
point into the packages.

```
rig-util/
  .claude-plugin/{plugin.json,marketplace.json}
  hooks/hooks.json            # wiki hooks + memory hooks
  skills/  wiki-refresh/ wiki-find/ memory-dream/ memory-find/ memory-forget/
  agents/  wiki-writer.md memory-dreamer.md
  shared/                     # json read/write, sha, ensureIgnore, secret patterns, rigcontract
  code_wiki/                  # everything now in scripts/ except what moves to shared/, with its *.spec.ts
  memory/                     # memory.ts CLI, capture, trigger, dream-input, apply, memorymd, *.spec.ts
  contract/ evals/ templates/ tests/ docs/
```

- The move is behavior-neutral and ships as its own commit before any memory code: update every path reference
  (`hooks/hooks.json`, both wiki skills, `templates/rig-wiki.yml`, `tests/e2e/run.ts`, the `npm test` glob,
  `tsconfig.json` `include`, README). The existing suite must pass unchanged.
- `shared/` holds only what both packages use. `code_wiki/` and `memory/` never import each other.
- Each module has its own on/off config: `.sdlc/wiki.json`, `.sdlc/memory.json`.

## 3. Storage and entry format

Target repo, committed:

```
.sdlc/memory/
  MEMORY.md          # index only, <= 60 lines, rebuilt deterministically; injected at SessionStart
  commands.md        # build/test/run invocations that work
  gotchas.md         # traps, env quirks, flaky things
  dead-ends.md       # approaches tried and ruled out, and why
  conventions.md     # repo norms learned from user corrections
  <topic>.md         # dreamer may add more (cap 12 files total)
  .cache/            # gitignored: signals.jsonl, batch-*.json, candidates/, rejected.jsonl, dream.lock, last-dream, log
.sdlc/memory.json    # optional config (below)
```

Entry: one bullet, one line, metadata in Cognition's form plus a computed id:

```
- Run tests with `npm test`; `npx jest` misses the TS loader. [source: session 4f2a…; added: 2026-10-09; id: m-3c9e1a]
```

- `id` = `m-` + first 6 hex of sha of the normalized text at creation (extended on collision); stable across later edits.
- Links: `[[gotchas]]` resolves from the memory root; `[[wiki:modules/auth]]` points at a code_wiki page.
- One fact in one place: apply rejects near-duplicates (section 6).
- `MEMORY.md`: a fixed header ("Notes from past sessions in this repo. Verify before relying on them."), one line per
  topic file (name, entry count, one-line description), then the 10 most recently added or updated entries.

Config `.sdlc/memory.json` (all optional except `enabled`):
`enabled` (false), `minSignals` (3), `cooldownMin` (30), `maxDreamsPerDay` (6), `model` ("haiku"),
`maxFiles` (12), `maxEntriesPerFile` (80).

## 4. Live capture (hooks, no model)

Every memory hook runs `node memory/memory.ts hook <event>`, exits at once unless `enabled` is true, and is a no-op
when `RIG_UTIL_DREAMING=1`. Budget 5s, never blocks, never prints to the user. Failures go to `.cache/log`.

| Hook | Signal appended to `.cache/signals.jsonl` |
|---|---|
| `PostToolUse` `Bash` | `cmd-fail`: command, exit code, first 300 chars of stderr. A later success of a similar command (same executable and first argument) in the same session records `cmd-fixed` linked to the failure. |
| `PostToolUse` `Write\|Edit\|MultiEdit` | `churn`: same file edited 3 or more times in one session (one signal per file per session). |
| Tool failure event | `tool-error`: tool name, error text. |
| `UserPromptSubmit` | `correction`: prompt matches a small regex set ("no,", "don't", "instead", "that's wrong", "use X not Y", "stop") and the previous transcript entry is an assistant action. First 500 chars. |
| `SessionStart` | No signal. Injects `MEMORY.md`, reports memory changes since the last commit ("memory updated: +3 -1, see git diff .sdlc/memory"), prunes un-dreamed signals older than 7 days. |
| `Stop` | Runs the dream trigger (section 5). |

Each line: `{ ts, session_id, transcript_path, transcript_line, kind, data, dreamed: false }`. Text is redacted with
the shared secret patterns before writing. The file is capped at 500 lines, oldest dropped first.

## 5. Dream trigger

The `Stop` hook decides deterministically. It spawns a dream only if all hold:
- at least `minSignals` un-dreamed signals;
- at least `cooldownMin` minutes since `last-dream`;
- fewer than `maxDreamsPerDay` dreams today;
- no `dream.lock`, or the lock is older than 15 minutes (stale, taken over).

It then writes the lock, snapshots the un-dreamed signals into `.cache/batch-<ts>.json`, and spawns
`claude -p "dream batch-<ts>" --agent rig-util:memory-dreamer --model <model> --max-turns 8` with `detached: true`,
`stdio: 'ignore'`, `unref()`, env `RIG_UTIL_DREAMING=1`, cwd the repo root. It returns immediately. If `claude` is not
on PATH, it logs, releases the lock and leaves the signals queued.

This is the one deliberate exception to "hooks never call a model": the hook still makes no model call itself, but
it starts a detached process that does. Guards: opt-in, daily cap, cooldown, lock, recursion env var, max turns,
restricted tools.

`/rig-util:memory-dream` runs the same pipeline in the foreground and ignores cooldown and the minimum (still honors
the lock).

## 6. Dreamer and apply

**Input (deterministic).** `memory.ts dream-input <batch>` prints one document: each signal with up to 40 transcript
lines around `transcript_line` (tool outputs trimmed to 400 chars, redacted), followed by `MEMORY.md` and all topic
files. Hard cap about 30k tokens, oldest signals dropped first and left un-dreamed. The dreamer never opens transcripts.

**Agent `memory-dreamer`.** Model from config (Haiku by default). Tools: `Read`, `Write` (prompt-restricted to
`.sdlc/memory/.cache/candidates/`), `Bash` (prompt-restricted to `node … memory/memory.ts`). Prompt rules: keep only
repo-specific, durable lessons; skip one-off typos and anything the code wiki already says; phrase as "use X, not Y,
because Z"; prefer update or merge over add; remove entries the batch shows are wrong. It writes
`.cache/candidates/<batch>.json` and finally runs `memory.ts apply <batch>`.

Candidate ops:
```json
[{ "op": "add", "file": "commands.md", "text": "…", "source": "<session_id>" },
 { "op": "update", "id": "m-3c9e1a", "text": "…" },
 { "op": "remove", "id": "m-91aa04", "reason": "…" },
 { "op": "merge", "ids": ["m-1a2b3c", "m-3c4d5e"], "text": "…" }]
```

**Apply (deterministic, the only writer of `.sdlc/memory/*.md`).** Per op:
- `file` matches `^[a-z0-9-]+\.md$`, is not `MEMORY.md`, and resolves inside `.sdlc/memory/`;
- `text` is one line, at most 240 chars, contains no secret-pattern match and no `[source:` metadata of its own;
- `add` is rejected when token Jaccard similarity to an existing entry is 0.8 or more;
- `update`, `remove` and `merge` ids must exist; merge keeps the earliest id and `added`, sources are joined;
- `maxFiles` and `maxEntriesPerFile` hold after the op.

Valid ops are applied to a temp copy; ids and `added` dates are computed; `MEMORY.md` is rebuilt; the copy is swapped
in. Invalid ops go to `rejected.jsonl` with the reason. Then the batch's signals are marked `dreamed`, the batch and
candidates files are deleted, `last-dream` is written and the lock released. Any failure leaves `.sdlc/memory/`
unchanged and releases the lock; the signals stay queued.

Apply never commits. Changes are ordinary working-tree edits reviewed and committed by the user.

## 7. Skills

- `memory-dream`: run a dream now in the foreground.
- `memory-find <terms>`: grep the topic files, print `id file text`.
- `memory-forget <id>`: remove an entry via apply (a single `remove` op).

## 8. Safety

- Off by default; enabled per repo.
- Every write passes through apply, so a misbehaving dreamer cannot write outside `.sdlc/memory/`.
- Every entry has a source session and date; git history is the audit log and git review the human check.
- Memory is injected as context under the "verify before relying" header, never as instructions.
- Secret redaction at capture, in dream input and again in apply.

## 9. Testing and eval

`npm test`, no model calls:
- Capture: hook payload fixtures to expected `signals.jsonl` lines; `cmd-fixed` pairing; correction regex; churn
  threshold; redaction; 500-line cap; disabled and `RIG_UTIL_DREAMING` no-ops.
- Trigger: threshold, cooldown, daily cap, lock, stale lock, missing `claude`. Spawn is injected and its arguments asserted.
- dream-input: windowing over fixture JSONL transcripts; token cap and oldest-first drop.
- apply: one rejection test per rule; dedupe; update, remove, merge; deterministic `MEMORY.md` (golden file); a failed
  apply leaves the tree unchanged.
- Step 0: the existing suite passes unchanged after the move.

Opt-in `npm run test:e2e:memory`: real `claude` on a fixture repo where `npx jest` fails and `npm test` works; assert
a `commands.md` entry appears after the dream.

Eval `evals/memory-recall.json`: 5 tasks that each need a fact learned in an earlier session (a command, a gotcha, a
dead end), run with and without memory, counting failed commands and turns. If memory does not help on at least 4 of
5, drop the `SessionStart` injection and keep memory as a manual tool.

## 10. Out of scope for v1

External or shared memory repos, per-person folders, proposing or applying edits to CLAUDE.md, skills or rig config,
per-prompt injection, embeddings, auto-commit.

## 11. Open decisions for the plan

- Exact hook event name and payload for tool failures in the installed Claude Code version (verify; drop `tool-error`
  if unavailable rather than inferring it from `PostToolUse`).
- Whether `claude -p --agent <plugin>:<agent>` resolves plugin agents in headless mode; fallback is passing the agent
  prompt via `--append-system-prompt` from `agents/memory-dreamer.md`.
- How `SessionStart` reports memory changes when the repo has no commits yet (fall back to "memory present").
