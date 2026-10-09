# Working on rig (this repo)

rig is **not** enabled on its own repo: there is no `.sdlc/` here and `/rig:*` skills, `sdlc.ts check` and change records are
never run against this tree. superpowers routes the work. These rules replace what rig would otherwise enforce, and they
exist because one week of building this repo cost $1k and 3 hours per change (`docs/proposals/2026-10-08-why-slow-and-the-fix.md`).

## Models, pinned by role

Same table as `scripts/routing.ts` uses for target repos. Set `model` on every `Agent` launch.

| Role | Model | Notes |
|---|---|---|
| Coordinator (main thread) | the session's model, never switched mid-session | keep it under 100k context; `/compact` before it passes that |
| Reads: code search, docs lookup, Explore | `haiku` | read-only |
| Writes: implementer, test writer | `sonnet` | one fresh context per independent group of tasks |
| Final review of a change's diff | `sonnet` (tier S, M) / `opus` (tier L only) | one review per change, at the end |
| Design of a tier L change | `opus` | only when the person asks for it |

Never run Opus as the coordinator. Never use `SendMessage` to hand a subagent's result back as a new user turn (each one
re-fires every Stop hook); launch agents in the foreground and let the tool result return.

## One review per change

Do not run implement-then-review pairs per task. Implement all tasks of a plan inline (`superpowers:executing-plans`) or
with at most one Sonnet implementer per independent group of files, run `npm test` once, then one review of
`git diff main...HEAD` (`/code-review` or a single reviewer agent). Fix findings in one wave. Target per Spec-2-sized
change: at most 4 subagent launches, under 45 minutes, under $8.

## Briefs, not transcripts

A subagent brief is at most 60 lines: file paths, the interface, the acceptance test, the verification command.
Never paste the plan or the conversation into it.

## Verification

`npm test` runs the spec files, the mod typecheck and the plugin tests. `npm run typecheck` is incremental
(`node_modules/.cache/rig-scripts.tsbuildinfo`). Run them yourself and quote the output; never report a pass you did not see.

## Two plugins in this repo

`brain/` is the optional `rig-brain` plugin (wiki + memory). It has its own `package.json`, tests (`npm run test:brain`) and
manifest. Core must not import it and it must not import core (`scripts/brainboundary.spec.ts`). Never register either plugin
at user scope: always `--scope project`.
