# Role by Tier Routing Design

**Date:** 2026-10-08
**Status:** draft, awaiting review
**Follow-up:** Spec 2, spend governance (per person, team and period caps, downshift near a cap, spend by role). Out of scope here.

## 1. Why

Organisations track tokens and dollars against caps, so every model call in the harness should run on the cheapest model that is still good enough for its job. Today one input picks the model: the change's tier (`scripts/graph.ts:147`, `modelFor`: greenfield or L → Opus, M → Sonnet, S → Haiku), and that one model goes to every architect, implementer and reviewer launch. The rule this spec adopts adds a second input, the role:

> Opus plans, Sonnet edits, Haiku reads, Opus reviews at decision points.

Tier-only routing gets three things wrong against that rule:

1. **Tier L code is written by Opus.** DESIGN.md §1 measured an Opus subagent run at $2.83 and a Sonnet run at $0.36. Writing code is Sonnet's job at every tier above S.
2. **Tier S code is reviewed by Haiku.** Review is a decision point; Haiku is below the quality floor for it.
3. **Effort is fixed per agent file.** Skills pass `model` but never `effort`, so the implementer runs at `medium` on a typo fix and on a tier L change alike.

Hard-coded sites route outside the tier logic altogether: `workflows/review.js:148` (referee `sonnet`), `templates/rig-triage.yml:37` (Haiku), `agents/scout.md` (Haiku). Nothing fetches docs on a cheap model: research falls to the main thread.

## 2. Decisions taken

| Decision | Choice |
|---|---|
| Scope order | Routing first (this spec), spend caps second (Spec 2) |
| Priority when cost and quality conflict | **Quality floor, then cheapest.** Each role has a minimum model it never drops below; above the minimum, the cheapest model wins |
| Mechanism | One routing table in code, read by skills, workflows and CI (approach A). Rejected: one agent file per role and tier (nine files, no per-call switch); settings-only aliases (cannot make two roles differ at the same tier) |

## 3. Goals and non-goals

**Goals**
- One function, `route(role, type, tier, round)`, returns `{ model, effort }` for every model call the harness makes.
- Floors are enforced in code: no setting, override or retry can route a role below its floor.
- Every launch site (skills, the review workflow, CI) reads the route; no site hard-codes a model.
- Spend per role is visible in `sdlc.ts metrics`, so the change is measured, not assumed.

**Non-goals**
- Caps per person, team or period, and downshifting near a cap (Spec 2).
- Choosing the main thread's model. It stays the session model (Sonnet in `templates/settings.json`); switching it mid-session re-reads the context uncached (DESIGN.md §2, principle 7).
- Automatic evals. `sdlc.ts evals` stays manual.

## 4. The routing table

| Role | Tier S | Tier M | Tier L and greenfield | Floor |
|---|---|---|---|---|
| `scout`: read and search code | Haiku · low | Haiku · low | Haiku · low | none |
| `researcher`: fetch and summarise docs (new) | Haiku · low | Haiku · low | Haiku · low | none |
| `architect`: spec, plan, design | main thread | main thread | **Opus · high** | Opus at L and greenfield |
| `implementer`: edit and test | Haiku · medium | Sonnet · medium | **Sonnet · high** (was Opus) | Sonnet above tier S |
| `slice-review`: per-slice review, tier L only | script checks | script checks | **Sonnet · high** (was Opus) | Sonnet |
| `reviewer`: PR review | **Sonnet · medium** (was Haiku) | Sonnet · high | Opus · high | Sonnet |
| `referee`: review workflow referee | Sonnet · medium | Sonnet · medium | Sonnet · high | Sonnet |
| `triage`: CI failure triage | Haiku · low | Haiku · low | Haiku · low | none |

"Main thread" means the skill writes the document itself, on the session model, as it does today: the M0 plan found a subagent costs more than it saves for a 15-line plan. Greenfield uses the tier L column at every tier, as `modelFor` does today.

**Retry on a bigger model.** On a budgeted node (`build`, `test`, `sensors`, `pr-review`), when `round >= 1` (an attempt after a failed check), the `implementer` route moves up one step: effort first (low → medium → high), then model (Haiku → Sonnet → Opus) at `medium` effort. The round comes from `ratchet.json`, so no model decides. A retry never goes below the floor (moving up cannot) and never lifts the node's dollar cap: the ratchet's `usd` cap still stops the node.

**Expected effect.** Tier L code-writing and slice reviews move from Opus to Sonnet: the largest share of subagent spend moves to a model about 8× cheaper per run. Tier S PR reviews move from Haiku to Sonnet: a deliberate cost increase that closes the quality gap. Opus still writes tier L plans and does the final tier L review.

## 5. Interfaces

### 5.1 `scripts/graph.ts`

```ts
export type Role = 'scout' | 'researcher' | 'architect' | 'implementer' | 'slice-review' | 'reviewer' | 'referee' | 'triage'
export type Effort = 'low' | 'medium' | 'high'
export type Route = { model: ModelAlias; effort: Effort } | 'main'
export function route(role: Role, type: ChangeType, tier: Tier, round = 0, override?: RoutingOverride): Route
export function routes(type: ChangeType, tier: Tier, round: number, override?: RoutingOverride): Record<Role, Route>
```

- The table in §4 is one `const` in `graph.ts`; `FLOOR` is a second `const`. `route` reads the table, applies the override, applies the retry step, then clamps to the floor. The clamp runs last, so nothing bypasses it.
- `modelFor` is removed. `inbox.ts` shows `route('implementer', …).model`.
- `Step` gains `routes: Record<Role, Route>`. `Step.model` stays for one release as an alias of `routes.implementer.model`, because vendored repos (`vendor --standalone`) carry the old skills, which read `model`. A later release removes it.

### 5.2 Override in `.sdlc/sensors.json`

```json
"routing": { "implementer": { "S": "sonnet:medium" }, "reviewer": { "M": "opus:high" } }
```

- Each value is `model` or `model:effort`. An unknown role, tier, model or effort is a config error (the same path as other `sensors.json` errors in `model.ts`).
- An override can lower a route only down to its floor; anything lower is clamped up and `sdlc.ts next` prints a warning naming the role.
- `sensors.json` is already behind an `ask` rule, so a model cannot change routing without a person confirming.

### 5.3 `sdlc.ts next --json`

Adds `routes` (the §5.1 record for the change's effective tier, type and current round). `route --role <role> [--slug <s>]` prints one route as `model effort` for shell callers (CI). With no `--slug` it uses the active change; with no change it routes as tier L.

## 6. Call sites

| Site | Today | After |
|---|---|---|
| `build`, `test`, `sensors`, `pr`, `pr-review` skills: implementer | `model` from `next --json` | `routes.implementer.model` and `.effort` |
| `build` skill: tier L slice review | `rig:reviewer`, `model` from `next --json` (Opus) | `rig:reviewer` with `routes['slice-review']` |
| `pr-review` skill: tier S and M review | `rig:reviewer`, tier model (S Haiku) | `routes.reviewer` (S Sonnet medium, M Sonnet high) |
| `pr-review` skill: tier L review | `code-review` at `high`, or shards with `rig:reviewer` | unchanged for `code-review` (cannot take a model); shard reviewers use `routes.reviewer` |
| `design`, `plan`, `spec` skills: architect | `rig:architect`, `model` from `next --json` | `routes.architect` (still main thread at S and M) |
| every skill: `rig:scout` launches | agent file (Haiku low) | `routes.scout`, passed explicitly |
| `workflows/review.js` referee | hard-coded `model: 'sonnet'` | `args.referee` from `routes.referee` (the skill passes it); falls back to `sonnet` when absent |
| `templates/rig-review.yml` | shell `case` on tier, model only | `sdlc.ts route --role reviewer` → `--model` and `--effort` |
| `templates/rig-triage.yml` | `--model claude-haiku-5-5` | `sdlc.ts route --role triage` → `--model` and `--effort` |
| new `agents/researcher.md` | none | Haiku low; tools `WebFetch, WebSearch, Read`; returns a summary with source URLs, never edits |

The common skill line (`**Models:** pass model from … next --json …`) becomes: pass `model` and `effort` from `routes.<role>` on every `rig:*` launch. Skills stay within 60 lines.

CI aliases: the YAML templates map `haiku`, `sonnet` and `opus` to full IDs through the existing `ANTHROPIC_DEFAULT_*_MODEL` values in `templates/settings.json`, so a model upgrade is one edit.

## 7. Measuring it

- The usage ledger (`hooks/register.ts` `turn.complete`) already records `agentType` per agent turn. Add `role` (the route the skill launched with, passed as the subagent's description prefix `role:<name>`, and `null` when absent), since one agent type (`rig:reviewer`) serves three roles.
- `sdlc.ts metrics` adds `tokens_by_role` and `model_by_role` next to `tokens_by_agent_type`.
- Before the new table becomes the default, a person runs `sdlc.ts evals` against the old and new routing on the same eval set. The new table ships only if the pass rate does not fall. Evals stay manual.

## 8. Checks before planning

These decide details of §5 and §6, not the design:

1. **Does `claude-haiku-5-5` resolve?** The harness pins it in four places (`agents/scout.md`, `templates/settings.json`, `rig-triage.yml`, `rig-review.yml`), but the latest Haiku known to Claude Code here is Haiku 4.5, and a dispatch with the `haiku` alias ran on Haiku 4.5. Check: `claude -p --model claude-haiku-5-5 "reply ok"`. If it fails, every Haiku pin moves to the ID that resolves.
2. **Does the Haiku in use accept `effort`?** If not, Haiku routes carry `effort` only as a record and the launch omits it.
3. **Does the Workflow `agent()` call accept an effort option?** If not, the referee route passes `model` only.
4. `claude -p --effort` exists (checked: `claude --help` lists `--effort <level>`).

## 9. Error handling

- Unknown or malformed `routing` in `sensors.json`: config error, `next` refuses, as for other config errors.
- An override or retry that would land below a floor: clamped up, with a warning on `next`.
- A skill that cannot read `routes` (an old vendored skill): it reads `model`, which still exists for one release.
- CI `route` fails (no readable change, two change folders, unreadable `ratchet.json`): it routes as tier L, matching today's rule that CI never picks a cheaper model when unsure.

## 10. Testing

Unit tests in `scripts/graph.spec.ts` (temp repos, never this repo):
- Every role and tier in §4 returns the table's route; greenfield returns the L column at S and M.
- `round >= 1` raises the implementer one step; the step is effort first, then model.
- An override below the floor is clamped up; an override above it is honoured; a malformed override is a config error.
- A lowered `intent.md` tier on a recorded L change still routes as L (the recorded tier is a floor, as today).
- `route --role` in CI with no readable change returns the L route.
- `size.spec.ts` stays green (10,000-line cap, skills at most 60 lines).

Verification: `npm run typecheck`, `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`, `claude plugin validate .claude-plugin/plugin.json`. No rig commands against this repository (standing rule).

## 11. Docs to update

DESIGN.md §2 principle 7 and the cost table row "Cheap subagents"; README agent diagram (adds `researcher`, routing by role and tier); CHANGELOG.

## 12. Amendments (2026-10-08, while planning)

These replace the sections they name; the plan (`docs/superpowers/plans/2026-10-08-role-by-tier-routing.md`) implements them.

1. **§5.3, §6 (CI): no `sdlc.ts route` CLI.** `rig-review.yml` runs with secrets on a PR whose head the author controls; running that head's `.sdlc/bin/sdlc.ts` would execute PR code with secrets. The inline picker stays (it reads files as data); it takes the reviewer table (S Sonnet medium, M Sonnet high, L Opus high) and passes `--effort`. A test ties it to `routing.ts`.
2. **§5.1: `Step.model` keeps today's tier model for one release**, not the implementer route. Old vendored skills pass `model` to architect, implementer and reviewer; the implementer route would drop their tier L architect and reviewer to Sonnet.
3. **§7: role is derived, not tagged.** Metrics map `agentType` plus `stage` to a role (`rig:reviewer` at `build` is `slice-review`, elsewhere `reviewer`). No description prefix. Workflow referee turns count as `other`.
4. **§5.2: architect overrides name tier L only**; S and M draft in the main thread.
5. **§4, §6: scout and triage stay pinned in their files**, not passed per launch: a per-call alias can resolve to another model outside the template env. Overrides for them are config errors.
6. **§4 retry: the build retry counts the open slice's rounds** (`ratchet.ts` records build rounds per slice); a failed slice never lifts later slices.
7. **§6 researcher tools: `WebFetch, WebSearch` only.** With `Read`, a page could steer it to read a repo file and send it out through a fetched URL; the caller's brief carries any versions it needs. The researcher is also pinned in its file like the scout (item 5).
