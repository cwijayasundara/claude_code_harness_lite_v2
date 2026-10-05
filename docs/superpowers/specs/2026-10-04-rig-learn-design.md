# rig learn: harness self-improvement from stored evidence (v0.5 design)

Status: draft for review. Date: 2026-10-04.

## 1. Goal

`rig` keeps the model frozen and improves the harness: rules, sensors and (later) skills and templates. Every change `rig` carries out already leaves evidence behind. `rig learn` reads that evidence, finds what keeps going wrong, and proposes harness edits that a person approves. It follows the loop in the RSI article: signal, diagnose, propose, evaluate, gate, promote.

**Success for v1.** After a number of shipped changes, `rig learn` prints a ranked list of proposed harness edits. Each has its evidence and a replay verdict. A person promotes or rejects each one. Running it costs zero tokens and gives the same result locally and in CI.

**Assumptions** (the person confirmed the design in chat on 2026-10-04):

- v1 reads and proposes. It never edits a protected file and never promotes by itself.
- v1 improves two surfaces only: `rules.json` entries and `sensors.json` severity and path settings.
- The minimum holdout is 10 shipped changes (`learn.minChanges`, configurable).

## 2. Non-goals

- A model proposer, and edits to skill text or templates (v2, once the gate exists).
- Clock-based schedules in the mod (it is event-driven). Running `learn` on its own when a change ships is in scope: see §4.8.
- Improving `rig learn` itself (the article's level 2). That needs a metaproductivity metric and explicit human approval, and has neither yet.
- Replacing `/rig:rule`. A person can still write a rule by hand. `learn` feeds the same path.

## 3. Approach

Three approaches were considered.

1. **Pure script, no model.** Deterministic clustering and rule-shaped proposals. Zero tokens, reproducible, and the proposer cannot grade itself. *Chosen.*
2. **Script plus a model proposer.** Better proposals for prose surfaces, but it needs the gate first. A candidate for v2.
3. **Fully automatic loop.** Rejected: there is no holdout data yet, and approvals stay human-only.

## 4. Design

### 4.1 Components

| Unit | Purpose | Depends on |
|---|---|---|
| `scripts/learn.ts` | Pure: types, cluster, propose, replay. No fs, git or process access. | `model`, `sensors` |
| `scripts/learncli.ts` | I/O: load evidence and the diff corpus, write `proposals.json`, the `learn` command. | `learn`, `core`, `ratchet` |
| `scripts/learn.spec.ts` | Seeded-fixture tests. | `testkit` |
| `sdlc.ts learn ...` | CLI entry: `learn` and `learn show`. | `learncli.ts` |
| `skills/learn/SKILL.md` | `/rig:learn`: runs the CLI and walks the person through the proposals. | CLI |
| `/rig-approve <id> learn` | Human-only promotion. | `approve` path |

`sdlc.ts` and the `.sdlc/` directory keep their names; only the user-facing prefix is `rig`.

### 4.2 Signals (collect)

Read only. The set of changes is every folder in `.sdlc/changes/` that has a `ship.json`.

| Source | What it gives |
|---|---|
| `review.md`, `review-slice-*.md` and `review-pr.md` per change | review findings `- [severity: X] [category: Y] text`, concatenated and de-duplicated per change on (category, text). The reviewer writes the slice and PR files and they are committed with the change; `review.md` is written after the ship commit and may be missing. `ratchet.json` keeps only hashes. |
| `events.jsonl` | blocked events with `reason`, used for stall and cap notes |
| `waivers.jsonl` | which sensor findings a person waived, on which files, with the reason |
| `ship.json` | the diff `base`; the head is the commit that added `ship.json` (found with `git log`), so past diffs can be rebuilt for replay |

The trial-notes listing (`tests/trials/live-*/notes.md`) is not implemented in v1; see Later.

### 4.3 Diagnosis (cluster)

A cluster needs at least 2 distinct changes to count. One change repeating itself is a bug, not a pattern. In v1, review findings cluster by category and token, and waivers by sensor and path. Clustering sensor findings from usage is not in v1.

- **Recurring finding.** The same sensor or review category appears in at least 2 changes. Produces a rule proposal.
- **Waiver churn.** The same sensor is waived at least 2 times on a similar path. Produces a sensor-tuning proposal (narrow the paths, or lower severity).
- **Stall or cap.** The same node is blocked by a `cap:` or `stall:` reason in at least 2 changes. Reported as a note for the person; no edit in v1.

Dead-rule pruning is not repeated here: `/rig:metrics` already reports prune candidates. Gate friction (gates approved without edits) is not derivable from `approvals.jsonl`, which stores a digest only, so it is deferred.

### 4.4 Proposals

`learn` writes `.sdlc/learn/proposals.json`. It is gitignored evidence: only `rig` writes it, and the model cannot (it joins the evidence-file list in `core.ts`).

```
{ id, kind: "rule-add" | "sensor-tune",
  surface: ".sdlc/rules.json" | ".sdlc/sensors.json",
  edit: <the exact JSON entry or patch>,
  evidence: [ <change slug> ... ],   // v1: a list of change slugs, not objects
  expectedEffect: "<what should stop recurring>",
  risk: "low" | "medium" | "high",
  replay: { status, firedOn[], falsePositives[], reason? } }
```

A `rule-add` proposal needs a review category that recurs in at least 2 shipped changes *and* a backticked token (for example `` `eval(` ``) that appears in findings of that category in at least 2 of them. The candidate pattern is that token, regex-escaped (exact-token matching only). Every rule in v1 starts as `warn`. A `sensor-tune` proposal comes from waiver churn and is advisory: a person edits `sensors.json` by hand.

### 4.5 Replay gate (evaluate and gate)

Zero tokens. The corpus is the stored diffs of past shipped changes, rebuilt from `ship.json`.

A proposal is **promotable** only when all of these hold:

1. **Fires on its evidence.** The proposed rule fires on the stored diff of at least one change whose findings it was built from.
2. **No false positives.** It does not fire on the stored diff of any shipped change that has no finding in that category.
3. **Budget parity.** It adds no model calls or extra tokens.
4. **Enough data.** At least `learn.minChanges` shipped changes. Fewer than that, proposals are listed with `replay.status: "insufficient-holdout"` and cannot be promoted.

Dominance and `risk: high` for loosening edits are not needed in v1: `sensor-tune` is advisory and never applied, and the only applied edit adds a `warn` rule.

The replay runs again at promotion time, so a proposal made against old data cannot be promoted after the corpus has moved on.

### 4.6 Promotion (human only)

`/rig-approve <id> learn` appends a promotable `rule-add` entry to `.sdlc/rules.json` (a human-only script action, like approvals). After promotion the person edits the pattern in `.sdlc/rules.json` if it needs generalising; there is no pre-promotion edit step. `rules.json` stays a protected file for the model, and the edit ships through PR review like any harness change. `sensor-tune` proposals are never applied by a command. The model cannot invoke the command or set `SDLC_HUMAN`.

### 4.7 The verifier is not writable by the improver

`learn.ts`, its spec and the replay logic live under `scripts/**`, which is already protected in a standalone repo (`.sdlc/bin/**`). The improver proposes edits only to `rules.json` and `sensors.json`. It has no path to change the gate that judges it, the corpus, or `proposals.json`.

### 4.8 Running on its own

The mod runs `sdlc.ts learn --auto` at session start and after each finished main turn. `--auto` fingerprints the shipped changes, `waivers.jsonl` and `rules.json`; if the fingerprint matches `.sdlc/learn/auto.json` it prints nothing and does no work. Otherwise it writes `proposals.json` and prints one line, which the mod shows as a toast, for example `learn: 1 proposal(s), promotable: learned-security`. It never promotes: `/rig-approve <id> learn` stays human-only, and promoting changes `rules.json`, so the next run re-checks. `auto.json` is protected evidence like `proposals.json`. Mods do not run in `claude -p` or CI, so `.github/workflows/learn.yml` runs `learn` weekly and on demand and prints the report to the job summary.

## 5. Data flow

```
changes/*/{events,runs,ratchet,ship}.jsonl, approvals, waivers, usage
        -> collect -> cluster -> propose -> replay vs past diffs
        -> .sdlc/learn/proposals.json  (rig-written evidence)
        -> person: /rig:learn review -> /rig-approve <id> learn
        -> rules.json / sensors.json edit -> PR review -> ship
```

## 6. Error handling

- Malformed evidence is tolerated: that change contributes nothing from the bad file and the run never fails.
- Fewer than `minChanges`: print the proposals marked unpromotable, exit 0.
- A pattern that fails to compile: drop the proposal with a reason.
- A diff that cannot be rebuilt (commit gone): that change is skipped and listed.
- `learn` writes `.sdlc/learn/` and, via `ensureGitignore`, `.sdlc/.gitignore`. It writes nowhere else.

## 7. Testing

Seeded fixtures in `scripts/learn.spec.ts`:

- Three changes with the same finding yield exactly one `rule-add` proposal that fires on all three.
- A candidate rule that also fires on a clean past change fails the replay and is not promotable.
- Fewer than `minChanges` shipped changes marks every proposal `insufficient-holdout`.
- Two waivers of the same sensor and path yield a `sensor-tune`.
- A change with a malformed `events.jsonl` or review file contributes nothing from it, and a change whose diff cannot be rebuilt is skipped and listed; the run still succeeds.
- A model-style Bash write to `.sdlc/learn/proposals.json` is denied (evidence protection).
- `/rig-approve <id> learn` refuses a model call and refuses a proposal whose replay is stale.
- Idempotence: running `learn` twice on the same evidence gives byte-identical `proposals.json`.

## 8. Open items for the plan

- Thresholds (2 changes per cluster, `minChanges` 10) are constants in `learn.ts`, with a `--min-changes` flag. A `learn` key in `sensors.json` is deferred: `parseConfig` rejects unknown keys, so adding one is its own change.
- How to derive a good candidate regex from several diffs is the hardest part. The plan should start with exact-token matching and a person-edited pattern before any generalisation.
- The `/rig-learn` pane is not in v1.

## 9. Later

Listing `tests/trials/live-*/notes.md` for the person to read (free text, not parsed).

Level-1 expansion to skill text and templates with a model proposer behind the same gate. Level 2 (improving `learn` itself) only after a metaproductivity metric exists and with explicit human approval.

## 10. Known limitations (v1)

- **Squash and rebase merges.** The replay diff is `base..head-of-ship-commit`. A squash or rebase merge can pull other changes into it and cause a false `fail`. Restricting the diff to the files the ship commit touches is a follow-up.
- **Rule ids.** Ids are `learned-<slug of category>`. Categories that slugify alike collide, and once a learned rule exists for a category no other is proposed for it.
- **Not a defence against a hostile model.** The false-positive check matches the finding category, not the token, and review files are working-tree files a model could edit. The gate is bounded by warn-only rules, the 10-change minimum, human-only promotion and PR review.
- **Surface.** `learn show` reprints the last report, and `--min-changes N` overrides the minimum.
