# Design: an automated end-to-end acceptance test for the harness

Status: draft for review, 2026-10-09. Extends `docs/proposals/2026-10-07-release-integration-test.md` (M1 built); it does not replace it.

## 1. Goal

One command, `npm run test:e2e`, proves the whole rig lifecycle on a throwaway project with no human in the loop. Repeatable, automated, and failing with a readable reason. Manual testing is not the verification method.

The test:

1. Scaffolds a new temp project and installs the harness into it (`.claude/skills/rig-*`, `.claude/agents/rig-*`, `.sdlc/bin`, git hooks, settings).
2. Builds a "simple shopping cart app in JS" from a PRD, up to the PR step (greenfield).
3. Makes a small change to that app and runs the full flow to the PR step again (brownfield).
4. Exercises **deploy** and **maintain** locally.
5. Plays the human at every gate **in code** and asserts every artifact.

## 2. Two drivers, one assertion library

| | **Scripted driver (the acceptance test)** | **Live driver (opt-in)** |
|---|---|---|
| Model | A fake: per-phase fixture files plus the `sdlc.ts` calls the skills make, in the skills' order | Real `claude -p` sessions running the vendored skills |
| Cost, time | $0, under 60 s | Roughly $5 to $8, 30 to 60 min; hard spend cap per run |
| Runs | `npm test` and CI, every PR | `npm run test:e2e:live`, before a release tag |
| Proves | Scripts, graph, gates, approvals, stamps, checkpoints, git hooks, `check --at ci`, production gate, watch, incident, metrics, install completeness | Prompt and skill drift, routing, permission prompts, quality of model-written artifacts, cost |
| Does not prove | Anything about the model | Anything deterministic (variance: run twice) |

The scripted driver is the repeatable regression gate. It must not be described as testing the model. The live driver is the only thing that does.

Both drivers call the same `Phase` definitions and the same `assert/*` modules, so the live run cannot be checked by weaker rules than the scripted one.

## 3. Layout

Reuses M1 (`tests/integration/lib`, `assert`, `acceptance`, `selftest.mjs`). New files:

```
tests/e2e/
  run.mjs            entry: node tests/e2e/run.mjs [--driver scripted|live] [--phase P0..P4] [--keep] [--out DIR]
  operator.mjs       the gate driver (§4)
  driver/scripted.mjs   fake model: applies fixture files, makes the skills' sdlc.ts calls
  driver/live.mjs       claude -p sessions, stream-json capture, spend cap, watchdog
  phases/p0-install.mjs p1-greenfield.mjs p2-change.mjs p3-deploy.mjs p4-maintain.mjs
  assert/deploy.mjs  assert/maintain.mjs     new; the rest reused from tests/integration/assert
  prd/cart.md        the PRD fed to /rig-start (a file, so it is versioned and identical per run)
  fixtures/p1/ p2/ p4/   scripted-driver file trees per phase (derived from tests/fixtures/reference/cart)
  report.mjs         report.json and report.md
```

`package.json`: `test:e2e` (scripted), `test:e2e:live`. `npm test` gains the scripted run once it is stable and under 60 s.

## 4. The operator (gates in code)

Between model steps the operator reads `sdlc.ts next --json` (never prose) and `status --json`.

| `verdict` | Operator action |
|---|---|
| `continue` | Run the next step (scripted: apply the next fixture; live: `/rig-next` session) |
| `human`, gate in `design`, `spec`, `plan`, `impact` | Confirm the gate is expected for this change's type and tier (imported from `scripts/graph.ts`, so it cannot drift), then `SDLC_HUMAN=1 node .sdlc/bin/sdlc.ts approve <slug> <gate> --by operator` |
| `human` for budget, tier or waiver | **Fail.** A raise, waiver or re-tier on a clean task means the harness went off track |
| `blocked` | Fail with the recorded reason; never loop |
| `ready` or `done` | Phase ends. Operator plays the merger: pushes to a fresh ref so pre-push runs, fast-forwards `main` |

Guards: same `(node, round)` after two steps fails; at most 10 steps per phase; live driver adds a spend cap (default $6 total), `--max-budget-usd` per call, and an 18-minute watchdog per phase.

## 5. Sandbox

Each run creates `mkdtemp` project: `git init -b main`, local bare repo as `origin`, stub `gh` on `PATH` (reuses `lib/gh-stub.sh`), isolated settings with every installed plugin disabled. Live driver uses `--permission-mode acceptEdits` and no `--allowedTools`, so permission denials are real and counted. Run artifacts go to `--out`, never into the project under test. The scaffolded project lives outside this repo, so CLAUDE.md's rule (rig never runs on its own tree) holds.

Install in P0 uses the harness's own standalone installer (`init --full` / `--stack`), not a hand copy. Every phase after P0 runs **without** `--plugin-dir`, which proves vendoring is complete.

## 6. Phases and assertions

**P0 install.** Asserts (reuses `assert/onboarding.mjs`): `CLAUDE.md` 120 lines or fewer with the `/rig-start` routing line; `.sdlc/sensors.json` parses with no findings and declares levels incl. `api`; 15 `rig-*` skills and 4 `rig-*` agents present; `.sdlc/bin/VERSION` equals `plugin.json` version; settings carry the template deny, ask and recorder-allow rules; `core.hooksPath` is `.sdlc/githooks` and hooks are executable; `PREFLIGHT.md` exists; `npm test` passes in the project.

**P1 greenfield cart.** Input: `prd/cart.md`. Expected route: greenfield, gates from `gates.greenfield`. Asserts (reuses `assert/change.mjs`): `intent.md` valid; design or spec has `## Files`, `## Slices`, `## Verification`, no code fences, every slice names a test; one `approvals.jsonl` row per expected gate, `by: operator`, none stale, none for a gate the path lacks; a red run before the first green; `verification.md` is `generated: sdlc`, `result: pass`, stamp matches tree; one checkpoint commit per slice on `sdlc/<slug>` touching only its files; `pr.md` `state: open`, `ship.json` committed; `git diff main...HEAD` inside `## Files`; clean tree, no `unresolved.json`, no waivers; `check --at ci` yields no block except `human-approval`; hidden acceptance (`acceptance/cart.mjs`) passes. Also once here: pre-commit refuses a runtime-generated fake secret; pre-push passes on a fresh ref.

**P2 small change (brownfield).** After merging P1: `/rig-start "Add Cart.applyCoupon(code) ..."` (tier S or M, recorded tier decides the path). Same assertions as P1 for the new change, plus: hidden acceptance for P1 **and** P2 passes (earlier promises hold); `cart.js` was edited, not rewritten (under 80% of lines deleted); a stale-approval check (edit `design.md` after approval, `next` reports the gate stale).

**P3 deploy (local only).** No model. Asserts:
- `templates/production-gate.sh` installed as a PreToolUse Bash hook: a payload containing `deploy` and `production` with `RELEASE_APPROVAL` unset exits 2 with the route message; with it set, exits 0; a payload naming neither exits 0; each decision for a matching command is appended to `.sdlc/gates.jsonl`, and non-matching commands are not logged.
- The rollback rehearsal command (`RIG_ROLLBACK_COMMAND`, a script in the project that records its run) runs and its result is read by `metrics` as `rollback_rehearsal_success`.
- `templates/rig-rehearse.yml`, `rig-watch.yml`, `rig-review.yml`, `rig-check.yml`, `rig-triage.yml` parse as YAML and every `sdlc.ts` command they call exists and exits 0 or the documented code when run locally.
- Out of scope (documented, not tested): real GitHub environments, reviewers, deployments. Optional later phase against a throwaway repo.

**P4 maintain.** Asserts:
- Declare a band in `.sdlc/sensors.json`. Feed values inside the band, then a breach. `sdlc.ts watch` reports tier 1 in-band, a higher tier on the breach per the Western Electric rules, and writes a draft `.sdlc/intent/breach-<band>-<date>.md` with `status: draft`.
- `/rig-incident "..."`: `.sdlc/incidents/<date>-<kebab>.md` has `class`, `severity`, `escaped`, `detected`, `restored` (blank until set); an `incident` change exists on the bugfix path.
- Run that change to the PR step (operator approves the plan gate at tier L). Red-proof: the regression test fails on base. A regression eval exists under `.sdlc/evals/`.
- After setting `restored`, `metrics` reports time to restore; a second incident of the same `class` raises `repeat_incident_class`.

## 7. Determinism and flake control

- Scripted driver has no clock or network dependence: fixed `GIT_AUTHOR_DATE`, temp dirs, no `gh`, no registry installs (cart is dependency-free, `node --test`).
- Every assertion pairs with a seeded-bad tree in `selftest.mjs` that must fail it. A new assertion without its failing twin is rejected in review.
- Live driver: one run is directional. A release gate is two runs; a failure seen once is a flake to investigate, never a pass.
- Failure output names the phase, the check, the artifact path and the sandbox dir (kept with `--keep`, always on failure).

## 8. Out of scope

The interactive mod (band, panes, dialogs); Windows; real GitHub CI and deployments; the CI-parity gap where a gated change without approvals passes `check --at ci` (open design decision from M1, pinned by the selftest, handled as its own change).

## 9. Milestones (each its own change; CLAUDE.md: one Sonnet implementer per independent group, one review per change)

| # | Deliverable | Cost |
|---|---|---|
| E1 | `operator.mjs`, scripted driver, P0 and P1 fixtures; `test:e2e` runs P0 to P1 green | $0 |
| E2 | P2 small change and stale-approval check | $0 |
| E3 | P3 deploy and P4 maintain assertions and fixtures; wire scripted run into `npm test` and CI | $0 |
| E4 | Live driver, P0 and P1 first (validates stream-json fields, plugin isolation, permission-prompt claim), then P2 and P4 | about $5 to $8 per run |

## 10. Risks

- The scripted driver encodes how skills call `sdlc.ts`; if a skill's steps change, fixtures drift. Mitigation: E4 live runs catch it, and fixtures read the step list from `next --json`, not hard-coded order.
- Tier is model-chosen in the live driver; assertions follow the recorded tier, and prompts that must force a tier say so (payments wording forces L).
- Stream-json field names are unverified against a captured live stream; E4 first step is capturing one.
