# Proposal: a release integration test (greenfield cart, brownfield shop)

Status: M1 built (2026-10-07, branch `fix/api-level-default`); M2–M5 not started. Goal: before rig goes to the team, one command builds a shopping cart from an empty directory and changes an existing shop app. The **operator** plays the person and approves every human gate. Every artifact the harness leaves behind is asserted.

## 1. What "pass" means

A run passes when, for both lanes:

1. Every change reaches `done` through the route its type and tier say it should take, with no human help other than the gates the operator is allowed to approve (§4).
2. Every artifact the harness promises exists, was written by the right party (sdlc or the model), and agrees with the others (§6).
3. The code works. Hidden acceptance checks live outside the repo, so the model never sees them. Earlier promises still hold after later changes.
4. The process was clean. There were 0 permission denials, no `unresolved.json`, no waivers or budget raises, and no skill other than rig's was invoked.
5. A teammate gets exactly this. After onboarding, every session runs the **vendored** harness (`/rig-start`, `.sdlc/bin`) with no `--plugin-dir`.

## 2. What already exists

We do not start from zero. Commit `43f42bb` removed a live trial harness that already did most of this:

| Removed file | What it did | Reuse |
|---|---|---|
| `tests/trials/run-trials.sh` mode `C` | Greenfield cart in one repo, then three changes in sequence: Cart, coupon, bulk discount. The operator approved gates and fast-forwarded main between them. | Becomes the greenfield lane |
| `assert-cart.mjs` | Per-phase artifact checks and hidden acceptance. Each later phase re-runs the earlier promises. | Keep the promises; rewrite the artifact checks |
| mode `I`/`S`, `shop-app/`, `assert-integration.mjs`, `assert-scenarios.mjs` | Onboarded the brownfield 4-module shop, then ran a tier L bugfix (SAVE20 at 2%) and a tier M refactor (move discounts out) | Becomes the brownfield lane |
| `split.mjs` | Cost split per agent from the run JSONs | Keep |

**Stale since then (56 commits):**

- `sdlc wiki` is gone, and both old assert files call it.
- `drive()` runs a `sed` over the prose `human gate: … /rig-approve X Y` string. `graph.ts:124` now appends a reason to that string, so the `sed` breaks.
- The old harness ran the plugin path (`--plugin-dir`, `/rig:*`) for every session, so it never tested the standalone path teammates will use.
- `--allowedTools "Bash(node *)" "Bash(npm *)"` hid the permission prompts teammates will hit.

**Never exercised live:**

- Git hooks (DESIGN §10, §11).
- Slice checkpoint commits on `sdlc/<slug>`.
- Story points.
- `PREFLIGHT.md`.
- Scopes.
- The vendored-recorder allow rules (`17d4320`).
- "0 permission prompts after plan approval" (DESIGN §11 open item).

## 3. Shape: two lanes

| | **Lane A: scripted** | **Lane B: live** |
|---|---|---|
| What drives it | A fake model: fixture files plus `sdlc.ts` calls in the order the skills make them | `claude -p` sessions running the real skills and agents |
| Cost and time | $0, about 30 s | About $10–15, 30–60 min |
| Where it runs | `npm test` and CI on every PR | Locally or in a cloud session before a release tag |
| What it catches | Regressions in the scripts: graph, gates, approvals, stamps, ship, checkpoints, hooks, CI check | Prompt and skill drift, permission prompts, routing, model-written artifact quality, cost |
| Assertions | The same assertion library (§6) | The same assertion library |

Lane A is cheap insurance that Lane B's assertions are themselves correct: one shared library, two drivers. Lane B is the release gate this proposal is mainly about.

Layout (in the plugin repo, outside the repo under test, so hidden checks never leak):

```
tests/integration/
  run.mjs            entry: node tests/integration/run.mjs [--lane greenfield|brownfield|all] [--scripted] [--out DIR]
  operator.mjs       the gate driver (§4)
  sandbox.mjs        temp repo, bare origin, isolated settings (§5)
  assert/            artifacts.mjs  process.mjs  harness.mjs  onboarding.mjs   (shared by both lanes)
  acceptance/        cart.mjs  shop.mjs      hidden promises, per phase
  scripted/          per-phase fixture files for Lane A
  report.mjs         report.json + report.md (per phase: checks, cost, turns, time, denials)
tests/fixtures/shop-app/   restored from 43f42bb~1
tests/fixtures/reference/  known-good code for every phase; used only by selftest.mjs
                           (under tests/fixtures/, which the plugin's own sensors already ignore)
```

## 4. The operator

The operator drives `claude -p` one session at a time. Between sessions it reads two JSON outputs and never parses the prose:

- **`node .sdlc/bin/sdlc.ts next --json`** returns the verdict: `{slug, node, verdict, reason, command, round}`.
- **`status --json`** returns the gate, in `changes[].next` as `{kind: 'approve', gate}`.

`next` has no gate field, and `node` is not always the gate: `gateOf` maps design to plan, and `impact` sits on the plan or design node.

| `verdict` | What the operator does |
|---|---|
| `continue` | Starts another session: `/rig-next — continue through ship; commit on the branch` |
| `human`, gate in `design`, `spec`, `plan` or `impact` | Checks the gate is one this change should meet (§6.2). Then approves it: `SDLC_HUMAN=1 node .sdlc/bin/sdlc.ts approve <slug> <gate> --by operator`. An unexpected gate fails the run. |
| `human` for `budget` or `tier`, or anything that needs `/rig-waive` | **Fails the run.** A budget raise, waiver or re-tier on a clean task means the harness went off track. The one exception is the seeded waiver scenario B3. |
| `blocked` | Fails the run and records the reason. It does not loop. |
| `ready` or `done` | The phase ends. The operator plays the merger: it fast-forwards `main` and starts the next phase. Before that, it pushes the branch to a **fresh ref** (`HEAD:refs/heads/prepush-<slug>`) so that pre-push actually runs. `pr` already pushed `sdlc/<slug>` with `--no-verify`, and re-pushing an up-to-date ref never invokes the hook. |

**Guards:**

- No progress: the same `(node, round)` after two sessions fails the run.
- At most 10 sessions per phase.
- Per-call `--max-budget-usd 6`.
- A total cap on the run's spend, checked after each session.
- An 18-minute watchdog per phase.
- Fail fast: if a lane's onboarding phase fails, no money is spent on its changes.

## 5. Sandbox: test what the team gets

- **Fresh repos.** Each lane gets a fresh repo in a temp directory with `git init -b main` and a **local bare repo as `origin`**. Push, pre-push and `pr.md state: open` then run for real. `gh pr create` fails without GitHub, so `pr` records a block. To avoid that, the sandbox puts a stub `gh` on `PATH` that prints a fake PR URL, and `pr-checks` reads its JSON.
- **Plugin path only for onboarding.** Only the onboarding session uses `--plugin-dir <plugin>` (`/rig:init --defaults …`). Every later session runs **without** it, through the vendored `/rig-*` skills and `.sdlc/bin`. That proves vendoring is complete.
- **Plugin isolation.** The sandbox writes project `.claude/settings.local.json` with `enabledPlugins: false` for every plugin `claude plugin list` reports (on this machine: superpowers, harness, financial-analysis, …). It uses the template model (Sonnet main thread, advisor off).
- **Real permissions.** Use `--permission-mode acceptEdits`, and add **no** `--allowedTools`. The template's `allow` holds only `Edit(.sdlc/**)` and the vendored recorder, so `default` mode would deny every `src/` edit headless. That measures the wrong thing. `acceptEdits` leaves exactly the Bash and Agent prompts open: the "0 prompts after plan approval" question in DESIGN §11. The team guide should then recommend the same mode. Tally `permission_denials` from every session.
- **One event source.** Every session runs with `--output-format stream-json --verbose` and is saved to `--out`. From the stream, the test reads:
  - skill invocations and agent spawns (`Skill` and `Agent` tool_use);
  - `permission_denials`, `is_error` and `total_cost_usd` from the final `result` event.

  The repo's async lane events (`subagent-start`, `subagent-stop`) cross-check agent spawns.
- **No stray files.** Run JSONs and logs go to `--out`, never into the repo under test. Stray files in the repo blocked ship in the 2026-10-04 trial.

## 6. What is asserted

### 6.1 Onboarding (both lanes, after `/rig:init --defaults`)

- `CLAUDE.md`: 120 lines or fewer, and carries the routing line verbatim.
- `.sdlc/sensors.json`:
  - parses with no `config` findings;
  - `fast` and `full` run the tests;
  - `gates` holds the defaults;
  - `levels` came from `init --stack`.
- Standalone install:
  - `.claude/skills/rig-*` (15) and `.claude/agents/rig-*` (4) exist;
  - `.sdlc/bin/sdlc.ts` exists;
  - `.sdlc/bin/VERSION` equals `.claude-plugin/plugin.json` `version`;
  - `.claude/settings.json` has the template's deny and ask rules plus the vendored-recorder allow rule.
- Git hooks: `git config core.hooksPath` equals `.sdlc/githooks`, and both hook files are executable.
- `.sdlc/PREFLIGHT.md` exists and was written by `preflight`.
- The onboarding is committed on `main`, and `npm test` passes.
- Greenfield only: `package.json` is ESM and has `test`, `test-fast` and `lint` scripts, plus one smoke test.
- Brownfield only:
  - the three scouts ran (three `Agent` tool_use events with `rig-scout` in the onboarding stream);
  - `CLAUDE.md` names the four modules.

### 6.2 Every change (both lanes, at `done`)

Expected gates and stages are **imported from `scripts/graph.ts`** (`gatesFor`, the stage paths) with the repo's own `sensors.json`. The assertions therefore follow the harness and cannot drift from it. The model chooses the tier, so the path is checked against the **recorded** tier. A fixed tier is required only where the task wording or a sensor forces it.

| Artifact | Assertion |
|---|---|
| `intent.md` | Frontmatter `type` and `tier` are valid. No open questions. `created:` is set. |
| `design.md`, `plan.md` or `spec.md` (per path) | Has `## Files`, `## Slices` and `## Verification`. **No code fences.** 120 lines or fewer, or a `status` warning is recorded. Every slice names a test. |
| `approvals.jsonl` | One row per expected gate, `by: operator`, **not stale** against the current artifact hash, and **no row for a gate the path does not have**. |
| `runs.jsonl` | At least one `expectFail` red run before the first green run (test first), for every type where red-proof requires it. |
| `verification.md` | `generated: sdlc`, `result: pass`, a tree stamp that matches the shipped tree, and every required level present (none `unmeasured` unless declined). |
| `ratchet.json`, `events.jsonl` | Points are set (S5, M7 or L11). Every node on the path has a `done` event. No round cap is hit. No `blocked` event is left open. |
| Slice checkpoints | One commit per slice on `sdlc/<slug>` (`git log main..sdlc/<slug>`), each touching only that slice's `## Files` plus tests. |
| `review*.md` | Present at tier L, with no high-severity finding left open. At S and M, its absence is expected. |
| `pr.md`, `ship.json` | `state: open` (bare origin and stub `gh`), `branch: sdlc/<slug>`, and both are **committed** on the branch. |
| Scope | `git diff --name-only main...HEAD` stays within `## Files`, tests and `.sdlc/changes/<slug>/`. There is no `harness-tamper` finding. |
| Clean | `git status --porcelain` is empty apart from gitignored files. There is no `.sdlc/unresolved.json` and nothing in `waivers.jsonl`. |
| CI parity | `node .sdlc/bin/sdlc.ts check --at ci --base main --json` produces **no blocks other than `human-approval`**, and its `humanRows` match the approvals for this change. Offline, `human-approval` must fire, because there is no GitHub event to prove an independent reviewer. That is the correct behaviour. |
| Process | Over the phase's sessions, from the stream: `permission_denials` sum to 0, `is_error` is false in every session, no `skill-load-failed` fallbacks, and no `Skill` call outside `rig-*`. |
| Code | `npm test` passes on the branch. Hidden acceptance passes for this phase **and every earlier phase**. |

### 6.3 Harness features (asserted once, where the lane exercises them)

| Feature | How it is exercised and asserted |
|---|---|
| pre-commit | After G1, the operator stages a file containing a fake secret and runs `git commit`. The secret is generated at runtime and never committed to the plugin repo. Assert a non-zero exit with a `secrets` finding, then reset. |
| pre-push | The operator pushes to a fresh ref (§4). Assert exit 0, plus the stamp-skip line, because `verification.md` matches. |
| Stop cap | Read `.sdlc/.gate`. More than 2 blocks for one sensor in a turn is a failure. |
| Stale approval | Lane A only: edit `design.md` after approval, then assert that `next` reports the gate as stale. |
| Waiver | B3 only (§7). |

## 7. Scenarios

### Greenfield lane: one repo, four phases, run in sequence

| Phase | Prompt (abridged; full text from mode `C`) | Expected route | Hidden acceptance |
|---|---|---|---|
| **G0 scaffold** | `/rig:init --defaults greenfield "Node.js 22 ESM library, no dependencies, node --test: an in-memory shopping cart"` | onboarding | §6.1 |
| **G1 cart** | `/rig-start "Add a Cart class … add/remove/lines/totalCents … RangeError … first public API"` | greenfield: gates come from `gates.greenfield` | lines sorted, repeat-add sums, totals, error types |
| **G2 coupon** | `/rig-start "Add Cart.applyCoupon(code) … SAVE10 … floor … no stacking"` | feature, M: design gate | 1999 → 1799, no stacking, `unknown coupon`; G1 still holds |
| **G3 bulk** | `/rig-start "Behaviour change: qty ≥ 10 gets 5% off the line … update the tests that pinned the old totals"` | feature. Changed expectations are allowed. `test-tamper` blocks only on deleted tests, lowered thresholds, skips or a net loss of assertions, so the expected outcome is **no tamper finding**. A tamper block here is a real finding: either the model weakened a test or the sensor is too strict for intended behaviour changes. | 950/900/3263, coupon applied after bulk; G1 and G2 promises updated as stated. Assert `cart.js` was modified, not rewritten (fewer than 80% of its lines deleted). |

### Brownfield lane: the 4-module shop-app, three changes in sequence

| Phase | Setup or prompt | Expected route | Hidden acceptance |
|---|---|---|---|
| **B0 onboard** | Restored `shop-app`. `/rig:init --defaults` (brownfield) | onboarding: scouts, CLAUDE.md | §6.1 brownfield |
| **B1 bugfix, L** | Seed `SAVE20: 0.02`. `/rig-start "Bug in payments: SAVE20 takes only 2% …"` | bugfix, L (the wording names payments; no path sensor forces it): diagnose, plan gate, red-proof must fail on base | SAVE20 gives 800 and SAVE10 gives 900 |
| **B2 refactor, M** | `/rig-start "Refactor: move the discount codes into src/orders/discounts.js … behaviour must not change"` | refactor: plan, red-proof must **pass** on base | `rateFor`, codes gone from `orders.js`, checkout unchanged; B1 holds |
| **B3 feature, endpoint** | `/rig-start "Add GET /orders/report/bestsellers?n= … returns the top-n SKUs"` (crosses `http/` and `orders/`) | feature, M or L. The design gate applies. The `api` level is required when the plan names the endpoint as a contract (`levels.ts:15`) | `bestSellers` ordering, ties by SKU, `[]` for no orders; HTTP 200 and 400 for a bad `n` |

B3 also tests the `api` level. Whether it is satisfied depends on the levels decision in §9.

## 8. Report

`report.md` and `report.json` in `--out`. For each phase:

- PASS or FAIL for each check, with the reason;
- type and tier, the gates approved, sessions and turns;
- cost from the run JSONs (`usage.jsonl` is empty in `-p`, DESIGN §11);
- wall time and permission denials;
- the cost split per agent (`split.mjs`).

Exit code 0 only if every check passes. The sandbox directory is kept for inspection.

## 9. Risks and known unknowns

- **Model variance.** One live run is directional (DESIGN §8). For a release gate, run Lane B twice, and treat a failure that happens once as a flake to investigate, not a pass.
- **Tier is model-chosen.** The `tier` sensor forces L only on `contracts` globs or auth, payments, security, billing or migration *paths*. `--defaults` declares no `contracts`, and `src/orders/` is not a payments path. So tier depends on the prompt wording: payments means L; an internal pure function means S or M. Assertions follow the recorded tier.
- **Levels under `--defaults` (resolved).** I first misread this. `init --stack` already declared `acceptance` (as the unit command). The real gap was `api`: an endpoint change requires it, `--defaults` could not declare it, and declaring it mid-change trips `harness-tamper`. Fixed in `29607d3`: `init --stack` now declares `api` too.
- **Stub `gh`.** It must answer every call the harness makes: `pr create` (prints a URL), `pr checks --json` (prints `[]`, which reads as `no-ci`, as for a repo with no workflows), `api …/reviews`, and `pr list --json` for metrics. With `--workflows` skipped, `pr-review` runs in session at every tier, so the stub's `pr checks` reply decides when pr-review finishes.
- **Offline CI.** `human-approval` cannot be satisfied without GitHub. The assertion expects exactly that block. A full CI-to-merge check needs a throwaway GitHub repo, which is optional (§10, M5).
- **The mod is not covered.** The band, panes and dialogs are interactive and outside `-p` (DESIGN §11). They stay a manual checklist.

## 10. Milestones

| # | Deliverable | Cost |
|---|---|---|
| M1 ✓ | Levels gap fixed; `shop-app` restored; sandbox, stub `gh`, oracle, assertion library, hidden acceptance and reference solutions written. `npm run test:integration:self` proves every assertion passes on good trees and fails on seeded-bad ones (about 13 s) | $0 |
| M2 | Lane A, scripted: fixture files per phase, wired into `npm test` and CI. Proves the assertions against known-good and seeded-bad trees, so a broken assertion cannot pass silently. | $0 |
| M3 | `operator.mjs` and Lane B, greenfield (G0–G3) | about $5–8 per run |
| M4 | Lane B, brownfield (B0–B3) | about $5–8 per run |
| M5 | Optional: the same run against a throwaway GitHub repo, with `rig-check` and `rig-review` workflows and a second account approving | about $2 plus setup |

Each milestone ships as its own rig change, through rig.

## 11. What M1 found

The selftest drives a scripted tier M feature through the whole route in the sandbox. It found:

| Finding | Status |
|---|---|
| `init --stack` never declared the `api` level, so an endpoint change in a repo onboarded with `--defaults` blocked at test | **Fixed** (`29607d3`) |
| Pushing a finished change's branch (the push `pr-checks` asks the person for) made pre-push mint an `adhoc-*` change, repoint `STATE.md`, and refuse the push as unplanned tier M work past three files | **Fixed** (`86d984d`) |
| The guard-layer removal left 11 unused imports | **Fixed** (`964f7e6`); `noUnusedLocals` now stops new ones |
| `rig-check` checks the approval rows a PR *adds*, but never that a gated change *has* its approvals. Reproduced the way CI sees it: a tier M feature branch with its design approval removed in a commit passes `check --at ci`. `/rig-pr` refuses to ship past an open gate, but a plain commit and push is not caught by the CI boundary SECURITY.md relies on | **Open: design decision.** The selftest pins today's behaviour, so a fix flips it |
| `status` and `next` clear `STATE.md` once a change finishes, leaving it modified in the tree after every shipped change | Open, minor. The assertions accept a cleared `STATE.md` and nothing else |
| `init --full` warns on the vendored `.claude/workflows/review.js` (8 lines over 160 characters): the harness flags its own file in a consumer repo | Open, minor |
| The CLAUDE.md routing line says `/rig:start`, but a standalone repo's command is `/rig-start` | Open, minor |
| An old `sdlc` 0.3.0 plugin is still installed on this machine | Isolated: the sandbox disables every installed plugin and runs with `--setting-sources project,local` |

Not proven yet, because M3 needs them:
- Plugin isolation. `--setting-sources project,local` has not run, and the selftest switches off an empty plugin list.
- The stream-json field names (`permission_denials`, `tool_use` inputs). They come from the tool schema, not a captured live stream; the selftest uses synthetic transcripts.
- The operator. It is unwritten.

Changed from the plan above: the brownfield lane no longer seeds a known-red test. With one `npm test` command, a red test would make every level red. The CI-parity check runs in a throwaway worktree, because its command runs append to `runs.jsonl`.
