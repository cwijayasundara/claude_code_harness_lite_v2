# Spend Governance Design

**Date:** 2026-10-08
**Status:** draft, awaiting review
**Follows:** Spec 1, role by tier routing (`docs/superpowers/specs/2026-10-08-role-by-tier-routing-design.md`, merged as 31b5641).

## 1. Why

Organisations track tokens and dollars against budgets. Rig records every turn's cost in `.sdlc/usage.jsonl` (`hooks/register.ts`), but that ledger is gitignored (`scripts/core.ts:376`) and lives on one machine. Nobody can see what the team spent this month, whether it is on pace to exceed a budget, or what a change cost across the people who worked on it. Near a budget, rig does nothing to spend less.

The Spec 1 build session (about $17.70) shows where the money goes: the Opus coordinator was about 70% of spend, mostly cache re-reads of its long context. Haiku implementers took 17 to 34 tool calls where Sonnet took 7 to 9, so they cost more per task. Coordinator overhead is logged with `change: null`, which the per-change sums in `scripts/ratchet.ts` and `scripts/scorecard.ts` drop.

## 2. Decisions taken

| Decision | Choice |
|---|---|
| Hard or soft | **Soft only.** Engineers must be able to finish work. Nothing in this spec pauses, blocks or kills a change |
| Budget scope | **Team per calendar month, and per change.** Not per person |
| What the team budget counts | **One repo, rig spend only.** The org's whole bill and other repos are out of scope |
| Where the team total comes from | **A spend ref in the repo, `refs/rig/spend`, updated at push** (approach 1). Rejected: summing PR scorecards (misses `change: null` overhead and unpushed work, so it runs low exactly when warnings matter); a committed file on `main` (lags until merge, adds churn to every PR) |
| Near a budget | Warnings at 50, 80 and 100%; downshift through cheap levers only, never below the routing floors in `scripts/routing.ts` |
| Existing `ratchet.usd` caps | Unchanged. They stay a per-node pause against runaway loops, raised only by `/rig-approve <slug> budget` |

## 3. Goals and non-goals

**Goals**
- `sdlc.ts spend status` shows team spend this month, the projected month total, the budget and the percentage, from every machine that has pushed plus this machine's unpushed turns.
- Per-change spend counts every machine that worked on the change.
- Warnings at 50, 80 and 100% in the band and as toasts; a projection that will cross 50% warns early.
- At 80% spent, rig spends less without lowering quality floors or stopping work.

**Non-goals**
- Hard caps of any kind.
- Budgets per person. Rollups are keyed by a hash, not a name.
- Spend across repos, spend outside rig, or reconciling with Console billing.
- Changing the per-node `ratchet.usd` pause.

## 4. Data: the spend ref

### 4.1 Rollup file

One file per machine per month, at `<YYYY-MM>/<id>.json` in the tree of `refs/rig/spend`:

```json
{
  "id": "a3f9c2e01b7d",
  "month": "2026-10",
  "through": "2026-10-08T17:02:11Z",
  "usd": 41.20,
  "byDay": { "2026-10-08": 17.70 },
  "byChange": { "spend-gov": 12.10, "(none)": 29.10 },
  "byRole": { "coordinator": 28.90, "implementer": 6.40 }
}
```

- **Rows counted:** `kind: "main"` rows only. A main row's `usd` is the session ledger delta, which already includes subagents, advisor calls and classifiers (`hooks/register.ts`). Adding `agent` rows would double count.
- **`change: null` rows count**, under the key `(none)`.
- **Rows without a finite, non-negative `usd`** count as $0, as in the scorecard.
- **`id`** is the first 12 hex characters of the SHA-256 of `git config user.email`. CI uses the literal id `ci`.
- **`byDay`** keys are UTC dates. `month` is the UTC month.
- **`byRole`** uses `roleOf` from `scripts/routing.ts`, as `metrics` does. A main row's dollars are attributed to `coordinator` unless the row's stage maps to a role that drafts in the main thread (`architect` at S and M).
- The file is cumulative for the month, so rewriting it is idempotent.

### 4.2 Publishing

`sdlc.ts spend publish` builds this machine's file for the current month and commits it to `refs/rig/spend` using git plumbing only (`hash-object`, `mktree`, `commit-tree`, `update-ref`). It never touches the working tree or the index. Then:

1. `git push origin refs/rig/spend` with a 10 second timeout.
2. On a non-fast-forward rejection: fetch the ref, rebuild the commit on the fetched tip (each machine owns its own file, so the rebuild has no conflicts), push once more.
3. Any other failure prints one warning line and exits 0.

The pre-push hook (`sdlc.ts check push`, `scripts/githooks.ts`) calls `spend publish` after its checks pass. Publishing never fails the push. A missed publish is caught up by the next one.

The first time it runs in a month, publish also writes the previous month's file one last time. This means spend from late on the last day of a month is not lost.

### 4.3 CI spend

`rig-review.yml`, `rig-triage.yml` and `rig-watch.yml` run Claude in CI. After their Claude step, each runs `spend publish --ci --usd <n>`, which adds `<n>` to the `ci` file under today's date and the change slug (when the job knows it). The amount comes from the Claude action's output. If the action does not expose a cost, the step skips with a notice and the job does not fail. Planning confirms what the action exposes (§9).

### 4.4 Reading

`sdlc.ts spend status [--json] [--change <slug>]`:

1. Fetches `refs/rig/spend` with a 10 second timeout into `refs/rig/spend` locally. On failure, it uses the last fetched copy and reports its age. If there is no copy, it uses the local ledger only and says `team total: this machine only`.
2. Team spend this month = the sum of `usd` over every file under the month directory **except this machine's id**, plus this machine's rollup built fresh from the local ledger. This counts local turns that have not been pushed yet, and counts them once.
3. Change spend = this machine's ledger rows for the slug, plus `byChange[slug]` from every other file in every month directory.
4. Projection = `spent / elapsedDays × daysInMonth`, where `elapsedDays` is fractional UTC days since the month began, with a minimum of 1.

The `--json` output is `{ month, spentUsd, projectedUsd, budgetUsd, pct, level, asOf, sources, change?: { slug, spentUsd, budgetUsd, pct, level } }`. `asOf` is the fetch time, and `sources` is the number of files counted.

## 5. Configuration

A new optional section in `.sdlc/sensors.json`, parsed in `scripts/configparse.ts`:

```json
"budget": {
  "teamMonthlyUsd": 500,
  "changeUsd": { "S": 5, "M": 20, "L": 60 },
  "warnAt": [50, 80, 100],
  "downshift": true
}
```

- Every field is optional. With no `budget` section, rig still shows spend and the projection, but has no levels, no warnings and no downshift.
- `warnAt` must be three ascending positive numbers. They name the `notice`, `tight` and `over` thresholds.
- `changeUsd` is keyed by tier. Greenfield changes use `L`, as routing does.
- Raising `teamMonthlyUsd` or any `changeUsd`, removing a budget, raising a `warnAt` threshold, or setting `downshift: false` is listed as a weakening in `scripts/sensors.ts`, beside `ratchet.usd`. That makes it a reviewed harness edit, so a model cannot quietly give itself more room. Lowering a budget or turning downshift back on is not flagged.

## 6. Levels and warnings

Each budget gets a level from its percentage. The thresholds come from `warnAt`, by default 50, 80 and 100:

| Level | Team budget | Change budget |
|---|---|---|
| `ok` | below `notice` | below `notice` |
| `notice` | spent ≥ 50%, or **projected** ≥ 50% | spent ≥ 50% |
| `tight` | spent ≥ 80% | spent ≥ 80% |
| `over` | spent ≥ 100% | spent ≥ 100% |

Projection only ever raises a team `notice`. Downshift needs actual spend, so a noisy projection early in the month cannot degrade work.

**Pressure** is `tight` when either the team level or the active change's level is `tight` or `over`, and `normal` otherwise.

**What people see:**
- **Band** (`hooks/band.tsx`): a segment `team $212/$500 · proj $470 · change $9/$20`. It is yellow at `tight` and red at `over`. It is missing when no budget is set.
- **Toast:** one when a level is first crossed, at most once per level per month for the team and once per level per change. Shown levels are recorded in `.sdlc/budget-seen.json`, which is gitignored and local.
- **Mission pane** (`/rig-map`): team and change gauges beside the existing per-node budget lines.
- **PR scorecard** (`scripts/scorecard.ts`): a `Change budget` row, `$9.10 of $20 (46%)`, with `over by $X` at `over`.
- **`sdlc.ts metrics`:** a `budget` block with the month's spent, projected and budget figures, and change budget hits in the window.

The band refreshes team spend from the cached ref on every main turn. It fetches at most once every 15 minutes, in the background, so turns are never slowed.

## 7. Downshift

Downshift applies only when pressure is `tight` and `budget.downshift` is not `false`. Floors in `scripts/routing.ts` still clamp last.

| Lever | Under pressure | Where |
|---|---|---|
| Coordinator model | If the main loop's model is Opus, main-loop requests are resent with `model: sonnet`. If the main loop is already Sonnet (the default in `templates/settings.json`), nothing changes | `turn.step` hook in `hooks/register.ts` |
| Review effort | `reviewer`, `referee` and `slice-review` drop one effort step (high → medium, medium → low). Models do not change, so a tier L review stays on Opus | `route()` in `scripts/routing.ts` |
| Re-review rounds | The round caps for `pr-review` and slice review drop by 1, to a minimum of 1. Reaching a cap escalates to a person, as today | cap lookup in `scripts/ratchet.ts` |
| Scout, researcher, triage | Unchanged. They already run at `haiku/low`, and skipping them causes more expensive rework | none |
| Implementer, retries, floors, gates | Unchanged. Spec 1 showed that downgrading implementers costs more, not less | none |

**Coordinator switch and DESIGN.md principle 7.** Principle 7 avoids switching models mid-session because each model has its own prompt cache, so the first turn after a switch re-reads the whole context uncached. The switch therefore happens at most once per session and is sticky until the session ends: it never flips back, even if pressure drops. A toast says `rig: budget tight, coordinator moved to Sonnet for this session`. When the session is already on Sonnet the lever is a no-op, which is the common case.

**Interface changes:**
- `route(role, type, tier, round, override, pressure = 'normal')`. With `pressure: 'tight'`, it lowers effort for the three review roles before the floor clamp. Model choice is untouched.
- `sdlc.ts next --json` adds `pressure: 'normal' | 'tight'` and a `budget` object from `spend status --json`. Its `routes` already reflect pressure, so skills pick it up without prompt edits.
- `ratchet.ts` cap lookup takes pressure and subtracts 1 for `pr-review` and slice review, to a minimum of 1.

**Opt-outs**, both human only:
- `budget.downshift: false` in `sensors.json` keeps warnings and turns downshift off for everyone (a reviewed edit, §5).
- `/rig-approve <slug> full-route` turns downshift off for one change. It is recorded in the change's approvals like other approvals. It does not change any budget or any ratchet credit.

**Relation to `ratchet.usd`.** The per-node `ratchet.usd` caps keep their current meaning: a node that passes its cap pauses, and `/rig-approve <slug> budget` credits it. The budgets in this spec never pause anything, and `/rig-approve <slug> budget` does not change them. The two mechanisms share no state.

## 8. Error handling

| Case | Behaviour |
|---|---|
| `refs/rig/spend` missing (first use, fresh clone) | Status uses the local ledger only and says so. The first publish creates the ref |
| Fetch fails or times out | Use the last fetched copy, with its age. No copy: local ledger only. Pressure is computed from what is known, so being offline under-warns rather than downshifting on bad data |
| Publish fails (offline, no push rights, protected ref) | One warning line. The user's push succeeds. The next push retries |
| Malformed file on the ref | Skipped, with a warning naming the path. The other files still count. A negative or non-finite `usd` is malformed |
| Ledger row without a valid `usd` | Counts as $0 |
| Month boundary | UTC throughout. The previous month gets one last publish (§4.2). Seen levels reset per month |
| `turn.step` resend fails | The request goes on the original model. Logged in the mod log |
| Bad `budget` config | Parser errors as for other sections. The defaults (no budget) apply |

## 9. Checks before planning

1. What the Claude CI action exposes about a run's cost (output name and units). If nothing, §4.3 ships with the skip path only, and the spec gets an amendment.
2. That `turn.step` can resend a main-loop request with a different `model` from a plugin hook, and what `$.session.model()` returns for an Opus session (alias or full id).
3. That pushing a non-branch ref under `refs/rig/` works against GitHub with the default token, both locally and from Actions (`contents: write`).
4. That `roleOf` can attribute main rows to `coordinator` versus `architect` (S/M) from the stage alone.

## 10. Testing

Never run rig on this repo. Verify with typecheck, `scripts/*.spec.ts`, `claude plugin test .` and `npm run test:integration:self`.

- **`scripts/spend.spec.ts`:**
  - rollup from fixture ledgers: main rows only, the `(none)` bucket, invalid `usd` as $0, UTC day keys;
  - projection on day 1 (minimum 1), mid-month and the last day;
  - level thresholds, custom `warnAt`, and pressure as the worse of team and change;
  - this machine's pushed file replaced by its local rollup.
- **Ref tests** in a temp repo with a bare remote:
  - first publish;
  - a second machine publishes;
  - a non-fast-forward rejection followed by rebuild and push;
  - offline publish warns and exits 0;
  - working tree and index unchanged;
  - previous-month final publish.
- **`scripts/routing.spec.ts`:** pressure lowers effort for the review roles only. It never changes a model, never goes below a floor, and never touches the implementer.
- **`scripts/ratchet.spec.ts`:** caps drop by 1 under pressure, never below 1, and only for `pr-review` and slice review.
- **Config and sensors specs:** `budget` parsing and errors; raising or removing a budget, raising `warnAt` and `downshift: false` are flagged as harness edits, and lowering is not.
- **Hook test:** the coordinator override applies only on Opus and only under pressure, is sticky for the session, and is a no-op on Sonnet. `full-route` disables it.
- **Integration sandbox:** two machine identities publish to one bare remote. The team total crosses 80%, and `next --json` reports `pressure: tight` with lowered review effort.

## 11. Docs to update

- `README.md`: a short budgets section with the config, `spend status` and the opt-outs.
- `DESIGN.md`: principle 7 notes the budget switch as the one sanctioned mid-session model change. A section on spend governance.
- `CHANGELOG.md`.
- `skills/metrics/SKILL.md`: the `budget` block.
