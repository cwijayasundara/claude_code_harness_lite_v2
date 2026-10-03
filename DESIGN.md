# sdlc — a thin AI-native SDLC plugin for Claude Code

Status: v0 design · 2026-10-02 · targets Claude Code ≥ 2.1.287 (mods)

## 1. Why: evidence from the last build

The `edm_sementic_layer_v2.0` ("Prism") build ran from 2026-09-30 to 10-02. Forensics covered all 356 transcripts. The scripts are in `scratchpad/forensics/`.

| Fact | Number |
|---|---|
| Total spend | **≈ $525–554** across ≈ 785M tokens; the earlier "billions" estimate double-counted |
| Share that was cache *reads* of long contexts | **57%** ($315) |
| Spend on turns with > 150k context | **50%** ($276); 220 turns ran at 500k–1M |
| Compactions | **1** in 25 h (auto, at 969k) |
| Opus subagent vs Sonnet subagent, avg | **$2.83 vs $0.36** per run; $169 total on Opus subagents |
| Retry / fix-wave / re-review agents | **$64**, plus a $20 resumed Opus fix agent |
| security-guidance auto-reviews | 141 runs on Opus 4.7 `xhigh`, **$79** (14%) |
| Cache rebuilds after > 5 min idle (sleep-polling, waiting) | **$49**; 62 `sleep` polls |
| Human prompts that were "continue / keep going / yes" | **42 of 117**; one "keep going until done" cost **$39** |
| Plans written | 8 plans, **880 KB** (full code embedded), for 12.8k LOC of source |
| CLAUDE.md | **none**; 20 plugins enabled, including finance, PE and AWS |

The build was not plain Claude Code. Two plugins effectively acted as an unplanned harness:
- **superpowers** drove the process: brainstorm, then code-bearing plans, then per-task Opus reviews.
- **security-guidance** ran Opus security reviews on every change.

The first Sonnet-main + Opus-advisor sessions ran ~40% cheaper per turn than the later Opus orchestrator.

These savings overlap. The single biggest lever is **bounded context**.

## 2. Principles

1. **Thin layer, built-ins first.** The harness owns only five things:
   - the artifact chain
   - human gates
   - guardrails
   - routing / budgets
   - measurement

   Everything else is a built-in: plan mode, `/code-review`, `/security-review`, `/simplify`, `/goal`, Explore-style agents, worktrees, `/rewind`, LSP.
2. **Ceremony scales with the task.** Routing is by type × tier. Small work never pays for the full pipeline.
3. **State lives in files, not chat.** This is copied from code-modernization. Any session can resume from `.sdlc/`, and status is derived from which files exist.
4. **Every skill ends with the exact next command.**
5. **Humans gate; models never self-approve.** Approval is a mod command, so the model cannot invoke it, and it costs zero tokens.
6. **Bounded context is a hard rule.** Hand off at about 150k: write `STATE.md`, run `/clear`, resume.
7. **Generator on Sonnet, reviewer and designer on Opus.**
   - Main thread: Sonnet 5.5 with an Opus 5.5 advisor.
   - Code generation (implementer): Sonnet 5.5.
   - Design steps (spec, plan) via the architect agent: Opus 5.5.
   - Code review via the reviewer agent: Opus 5.5.
   - Search: Haiku.
   - Model IDs are pinned, so an alias update cannot silently change cost or behaviour.
8. **Deterministic checks decide; models advise.** Scope-drift, tests and secrets are computed by a script.
9. **Measure from git + mod telemetry.** Report `unmeasured` when n < 5.
10. **Computational sensors on the hot path, inferential review once per change.** Edit, Stop and SubagentStop cost zero tokens. Local equals CI via one `check` entry point, and CI judges a PR with the base branch's checker and config.

## 3. Architecture

```
sdlc/                                  plugin root (this repo is also its marketplace)
├── .claude-plugin/{plugin.json, marketplace.json}
├── skills/                            model- or user-invoked, namespaced /sdlc:*
│   ├── start/      router: classify type×tier, write intent.md, print path + next cmd
│   ├── onboard/    once per repo: compact CLAUDE.md (<120 lines), settings template, test cmds
│   ├── spec/       M/L features & greenfield: spec.md with numbered B<n> behaviours
│   ├── plan/       plan.md: ## Files (ownership), ## Slices, ## Verification — NO code
│   ├── build/      execute slices via Sonnet implementer subagents; ends with a /goal line
│   ├── diagnose/   bug path: reproduce → isolate → regression test → fix
│   ├── verify/     verifier agent runs the checks, writes verification.md with real output
│   ├── review/     one review per change: /code-review (+ /security-review if risk) → review.md
│   ├── ship/       scope-drift gate → commit → gh pr create with artifact links
│   ├── handoff/    write STATE.md (≤40 lines) and tell the user to /clear and resume
│   ├── incident/   Maintain stage: incident record → intent.md (bug path)
│   └── metrics/    playbook metrics + cost metrics from git, gh and usage.jsonl
├── agents/
│   ├── scout.md        haiku, read-only, omitClaudeMd — cheap codebase search (replaces Explore-on-Opus)
│   ├── architect.md    claude-opus-5-5, effort high — writes spec.md / plan.md (design-heavy steps)
│   ├── implementer.md  claude-sonnet-5-5, effort medium — the generator: one slice, tests first
│   ├── reviewer.md     claude-opus-5-5, effort high — one independent review pass, findings >= 80 confidence
│   └── verifier.md     claude-sonnet-5-5 — runs verification commands, reports, never repairs
├── hooks/
│   ├── hooks.json      settings hooks (work everywhere incl. -p) + "modules": mod
│   └── register.js     the mod: usage capture, status band, /sdlc-status, /sdlc-approve, guards
└── scripts/sdlc.ts    zero-dep Node: init, status, approve, scope-drift, secrets, metrics
```

### Why each component is where it is

**Skills, not commands.** Commands are legacy.
- No skill sets `model:`. A model switch inside a skill breaks the prompt cache for that turn.
- Skills set `effort` only, which is cache-safe on Opus 5.5 and Sonnet 5.5.
- Model routing happens through agents (`model:` in agent frontmatter) or through `context: fork`.

**Agents.** Plugin agents ignore `hooks`, `mcpServers` and `permissionMode`. Per-agent guards therefore live in plugin-level hooks or the mod, keyed on `agent_type` / `e.agentId`.

**Settings hooks vs the mod.**
- Settings hooks are portable and sandbox-friendly, and they run in `-p` and CI. Essential gates go here.
- The mod runs in-process. It does what settings hooks cannot:
  - exact per-request token usage (`turn.step`)
  - zero-token commands
  - `$.ui.ask` budget prompts
  - a live status band
- Mods aren't sandboxed and don't draw in `-p`, so nothing essential depends on the mod.

**Script.** All deterministic logic lives in one file, so it can be tested and reused by CI.

## 4. Task routing (type × tier)

`/sdlc:start "<request>"` classifies the request. If it is genuinely ambiguous, it asks at most two questions via AskUserQuestion. It then writes `.sdlc/changes/<slug>/intent.md`, with `type:` and `tier:` in its frontmatter.

| Type | Path |
|---|---|
| greenfield | onboard → intent → spec → plan (architecture + walking skeleton slice first) → build → verify → review → ship |
| feature | intent → [spec if L] → plan → build → verify → review → ship (tier S: intent+plan+build+verify in one turn, review folded into ship) |
| bugfix | intent → diagnose (failing test first) → verify → review → ship |
| refactor | intent → plan (characterization tests first) → build → verify (behaviour unchanged) → review → ship |
| migration | intent → plan (inventory + pilot unit) → build pilot → approve → fan out → verify → ship |
| chore | intent → build → verify → ship |
| spike | read-only scout, ≤ 1 page answer in `notes.md`; no gates |
| incident | incident record → intent (bugfix path) |

| Tier | Rule of thumb | Human gates | Review |
|---|---|---|---|
| S | ≤ 3 files, no public contract or data change | none before code | `/code-review` at ship |
| M | ≤ 15 files or touches a contract | plan | `/code-review` |
| L / high-risk | auth, payments, data migration, security, public API, > 15 files | spec + plan | `/code-review` + `/security-review` (+ Opus reviewer) |

Brownfield repos run `onboard` once to produce a compact `CLAUDE.md`. Greenfield runs it at project creation. It is never repeated per task.

## 5. Artifacts (in the consumer project, committed)

```
.sdlc/
├── changes/<slug>/
│   ├── intent.md          type, tier, problem, outcome, non-goals (≤ 40 lines)
│   ├── spec.md            B<n> behaviours + acceptance (M/L only, ≤ 150 lines)
│   ├── plan.md            ## Files, ## Slices (interfaces + acceptance tests, no code), ## Verification (≤ 120 lines)
│   ├── verification.md    commands run + pasted tail output
│   └── review.md          findings ≥ 80 confidence, severity, disposition
├── incidents/<id>.md      class:, escaped: true|false, links
├── approvals.jsonl        {slug, stage, by, at, digest} — written only by the human command
├── STATE.md               ≤ 40 lines: active change, stage, next command, open questions
└── usage.jsonl            per-turn cost rows from the mod (gitignored by default)
```

Plans must not contain code. This rule alone would have removed about 880 KB of plan text that every subagent re-read.

## 6. Token & time policy (each line maps to evidence in §1)

| Lever | Setting / mechanism |
|---|---|
| Hand off at ~150k context | Mod band turns amber at 120k and red at 150k. At 150k the mod calls `$.ui.ask`: "hand off now?". `/sdlc:handoff` writes STATE.md, then the user runs `/clear` and `/sdlc:start --resume`. Backstop: `autoCompactWindow: 200000` in project settings. |
| Sonnet main + Opus advisor | Settings template: `"model": "sonnet"`, `"advisorModel": "opus"` |
| Cheap subagents | `implementer` uses sonnet; `scout` uses haiku; `verifier` uses sonnet. Opus only for the L-tier reviewer. |
| No auto security reviews per edit | Disable security-guidance in harness projects. Run `/security-review` once at ship for L/high-risk changes. |
| One review per change | `review` skill: single pass, findings below 80 confidence dropped, max one fix round, then ship or escalate to the human. |
| No sleep-polling | Instructions say background agents notify, never `sleep`. A PreToolUse hook blocks `sleep N` with N ≥ 30. |
| No "continue" prompting | `build` ends by printing a ready `/goal` line containing the slice acceptance tests, plus "or stop after N turns". The evaluator runs on the small fast model. |
| Lean plans | Plan template caps and a "no code blocks > 10 lines" rule. `sdlc.ts status` warns when a plan exceeds 120 lines. |
| Small context per subagent | `omitClaudeMd: true` on scout. Implementers get a brief of ≤ 60 lines: the slice, files and acceptance criteria. |
| Plugin diet | Project `enabledPlugins` turns off the finance, PE, AWS and small-business plugins. The skill listing is capped at 1% of context. |
| Quiet test output | PostToolUse/PreToolUse guidance to use `-q` and tail-only output. The verifier runs tests, so verbose output stays out of the main context. |
| Cache TTL | Subscription: main conversation 1h by default. Optionally `subagentPromptCacheTtl: "1h"` for long implementer runs. |

## 7. Measurement

**Playbook metrics** (definitions as on the playbook page):

| Stage | Leading | Lagging | Source |
|---|---|---|---|
| Plan | first conversation → committed intent.md | intent survival (share accepted into spec/plan) | git, approvals.jsonl |
| Design | intent commit → spec commit | spec commits after first plan commit | git |
| Build | first-pass merge share; plan approval → merged PR | rework cycles; merged diff matches plan `## Files` | approvals, gh, scope-drift |
| Test | first-pass CI success | review time per PR | gh |
| Deploy | time to first review; comments resolved without human | defects caught pre-merge vs escaped | gh, review.md, incidents |
| Maintain | band breach → intent in queue | findings → merged fixes; repeat incidents by class | incidents/, gh |

**Cost metrics** (added; these come from the mod's `turn.step`/`turn.complete` usage):
- $ and tokens per change
- $ and tokens per stage
- $ and tokens per agent type
- peak context per session
- cache hit %
- Opus share

These should be reconciled against `/usage`, because advisor and classifier tokens may not appear in per-request usage.

## 8. Install

```jsonc
// <project>/.claude/settings.json
{
  "extraKnownMarketplaces": { "sdlc": { "source": { "source": "directory", "path": "/abs/path/claude_code_harness_lite_v2" } } },
  "enabledPlugins": {
    "sdlc@sdlc": true,
    "superpowers@claude-plugins-official": false,
    "security-guidance@claude-plugins-official": false,
    "financial-analysis@claude-for-financial-services": false,
    "private-equity@claude-for-financial-services": false,
    "aws-serverless@claude-plugins-official": false,
    "harness@harness-local": false
  },
  "model": "sonnet",
  "advisorModel": "opus",
  "autoCompactWindow": 200000,
  "permissions": { "allow": ["Edit(.sdlc/**)", "Write(.sdlc/**)"] }
}
```

While developing the plugin, run `claude --plugin-dir ./sdlc`, and run `claude plugin validate ./sdlc` before any install.

## 9. Kept from earlier harnesses / dropped

| Kept | Dropped (built-in replaces it) |
|---|---|
| artifact chain + digest approvals (stale on edit) | `deliver.mjs` headless driver → skills + subagents + `/goal` |
| `## Files` ownership + scope-drift at ship | graph/pack/map code index → scout (haiku) + LSP |
| secrets scan, PostToolUse quick check | custom reviewer/evaluator → `/code-review`, `/security-review` |
| verifier that reports, never repairs | 849-line CLI → one `sdlc.ts` |
| `diagnose` | `experiment.mjs` → `claude plugin eval` with/without comparison |
| metrics with `unmeasured` when n < 5 | self-governance machinery |

## 10. Findings from the v0 build (2026-10-02)

- **`.claude/` is a protected path.** Writes there prompt in default and acceptEdits modes, go to the classifier in auto mode, and are denied in dontAsk mode and `-p`. Allow rules cannot pre-approve them. Artifacts therefore live in **`.sdlc/`** at the repo root, the same pattern code-modernization uses with `analysis/`.
- **Tier S has to be a fast path.** With the full path (5 fresh sessions plus subagents), a trivial change cost **$1.04**; plain Claude Code cost **$0.15**. With the fast path (start builds and verifies inline; ship does review, scope gate and commit), the cost is **$0.60** for the full lifecycle, including a `/code-review` pass, artifacts and a commit. The remaining overhead is about $0.12 per fresh `-p` session for the system-prompt cache write; an interactive session pays it once.
- **Cross-skill chaining through the Skill tool failed in `-p`.** Steps a skill depends on are inlined rather than invoked.
- **Mod capabilities used:**
  - `agent.spawn` gives each subagent's type, and lets general-purpose spawns with no model default to Sonnet. Subagents have their own cache, so this is cache-safe.
  - `turn.start` lets spend be attributed to the stage that incurred it.
  - `$.session.usage().cost` gives exact dollars that reconcile with `/usage`, including advisor and classifier calls.
- **Known gaps in v0:**
  - Subagents spawned inside built-in skills such as `code-review` sometimes log as `unknown` agent type.
  - L-tier bugfix and incident changes have no human gate, because their path has no spec or plan stage.
  - The `agent.spawn` Sonnet default applies to every unpinned general-purpose spawn in a `.sdlc` repo, including those inside built-in skills, and has not been observed live yet. A `userConfig` toggle is the planned follow-up.
  - Only the tier S path was exercised end-to-end. The M/L paths (gates, implementer fan-out, verifier and review repair rounds, band and handoff) still need an interactive trial.

### Tier M trial (2026-10-02/03, todo-core sample repo, Sonnet main + Opus advisor)

Task: add an optional `dueDate`, an overdue filter and a due-date sort. About 6 files.

The plan was checked against a hidden acceptance test of 6 cases. Every completed run passed it, and so did plain Claude Code.

| Run | Sessions | Cost | Acceptance | Notes |
|---|---|---|---|---|
| Plain Claude Code, same settings | 1 | **$0.25** | 6/6 | 13 tests, no plan, review, artifacts or commit |
| Harness, one session per stage | 9 | **≈ $1.85** | 6/6 | 25 tests, approval gate held, 0 drift, committed on a branch with artifacts |
| Harness, `/goal` chaining build → ship | 2 | ≈ $1.85 | 6/6 | 55-turn orchestrator; `/goal` skipped the ship skill's steps and used a pr-review-toolkit reviewer |
| Harness, size-scaled skills | 2–3 | incomplete | — | Start + plan: $0.49. The build was interrupted by host sleep overnight; resuming from files worked up to the stall. |

What this shows:
- **About half the per-stage cost is session restart.** Each fresh session writes roughly 25–30k tokens of system prompt and tools to the cache, at about $0.11.
- **Most of the rest is orchestration turns and subagent start-up**, which a 6-file change does not need. Builds are now size-scaled: small M changes build and verify in the main thread, and subagents are kept for large plans and tier L.
- **The harness does not make a capable model more correct on a small, clear task.** What it adds is process and evidence: plan, gate, scope check, tests, review, commit and metrics. Its savings case is the long-running, large change, where context bloat, Opus orchestration and fix waves cost $525 in the Prism build.

Bugs the trial found, all fixed with tests:
1. The approvals guard blocked `git add` of the approvals log. It now uses an allowlist of git and read-only commands.
2. Ship reported done before committing. Done now means `ship.json` is committed, which git verifies.
3. Headless sessions ended while a background scout was still running. Skills and the session context now require foreground subagents.
4. Reading `approvals.jsonl` through Bash was blocked. The session context now says to use the Read tool.

Still to measure:
- the size-scaled tier M path end to end, on an awake machine
- a long tier L change, which is where the harness's savings should appear

### Final trials (2026-10-03): pinned models, size-scaled skills, Mac kept awake

Model routing in these runs:
- main thread: Sonnet 5.5, with an Opus 5.5 advisor
- architect (spec and plan): Opus 5.5
- implementer: Sonnet 5.5
- reviewer: Opus 5.5
- scout: Haiku

| Trial | Harness | Plain Claude Code | Hidden acceptance | Own tests (harness / plain) |
|---|---|---|---|---|
| Tier M: due dates, ~6 files | **$1.08** in 2 sessions, plus $0.27 to re-ship after a bookkeeping bug | **$0.25** | 6/6 and 6/6 | 14 / 13 |
| Tier L: API-key auth, per-user isolation, pagination, atomic file store | **$2.87** in 3 sessions, gated spec and plan | **$0.41** | 5/5 and 5/5 | 42 / 29 |

- **Cost:** the harness costs about 4–7x plain Claude Code on tasks a capable model already gets right.
- **What the extra spend bought on tier L:**
  - The Opus reviewer found and fixed two real issues. One was an auth-configuration bypass: a user with an empty `apiKey` matched a request carrying an empty `x-api-key`.
  - The plain run **has that bypass**: an empty key against an empty header returns 200.
  - The harness run also produced a reviewed spec (94 lines) and plan (107 lines), 13 more tests, and a scoped commit with an audit trail.
- **Bugs found and fixed:**
  - In a chained session the model wrote `result: pass` in the report body and committed the code without `.sdlc/`. Shipping is now a deterministic `sdlc.ts ship` (preconditions, scope gate, branch, staging, commit), and report fields are read leniently.
  - `/security-review` needs a git remote. Without one, the review skill now hands security to the reviewer.

Bottom line: the harness's value is assurance and audit (gates, independent Opus review, scope control, metrics), not cheaper correct code on small tasks. Its cost case remains the long-running build, where it bounds context and keeps Opus on review and design only. That case is not yet measured; the next trial is to replay a Prism-sized milestone.

#### Trial details

Every run used `claude -p` with `acceptEdits` and an $8 budget cap. Gates were approved by the scripted operator between sessions. The runner and the probes are `run-trials.sh`, `probe-L.mjs` and `probe-L2.mjs` in the trial scratchpad.

| Session | Stage(s) | Cost | Turns | Wall time | Sonnet / Opus / Haiku |
|---|---|---|---|---|---|
| M-A | start + plan | $0.51 | 8 | 100 s | $0.20 / $0.30 / – |
| M-B | build → ship | $0.58 | 27 | 126 s | $0.46 / $0.12 / – |
| L-A | start + spec | $0.63 | 3 | 8 s | $0.27 / $0.36 / – |
| L-B | plan | $0.64 | 4 | 185 s | $0.15 / $0.44 / $0.05 |
| L-C | build → ship | $1.60 | 27 | 373 s | $1.08 / $0.53 / – |
| L plain | everything | $0.41 | 22 | 86 s | $0.41 / – / – |

- **Opus share:** 39% for tier M and 46% for tier L, all of it from the architect, the reviewer and the advisor. The main thread stayed on Sonnet throughout.
- **Wall time:** tier L took about 6.6× as long as plain Claude Code (566 s against 86 s). The time went into the gates, the independent verifier and the review fix round.
- **What each run left behind:**
  - The harness runs ended on a branch, with one scoped commit that included the artifacts, and scope drift was 0 in both.
  - The plain run left its work uncommitted on `main`.

Auth probes on the tier L result, using malformed `users` configurations:

| Probe | Harness | Plain |
|---|---|---|
| user with empty `apiKey`, no key header | rejected at setup (`TypeError`) | 401 |
| user with empty `apiKey`, empty key header | rejected at setup | **200 (bypass)** |
| user with no `apiKey`, header `"undefined"` | rejected at setup | 401 |
| user with no `id`, valid key | rejected at setup | 200; that user sees `[]`, so scoping held |

Review outcomes:
- **Tier L:** two medium findings, both fixed in one round:
  - the auth bypass above;
  - a persistence test that did not prove B8 or B13.
  
  Six low-confidence items were deferred.
- **Tier M:** no findings. The reviewer deferred one note: "every todo now has `dueDate` and list order changes for all callers". That is a **contract change that tier M let through without a gate**. The contract-impact sensor in the quality-sensors design, which is in progress, is meant to catch it.

Defects these runs exposed:
1. **The Skill tool failed to load a stage skill twice per run**: `/sdlc:review` in M-B and `/sdlc:verify` in L-C. Both times the model followed the skill's steps by hand. This is the same `-p` chaining failure noted above, and it means a chained session can drift from a skill without any error.
2. **The verifier inferred exit codes instead of capturing them.** `verification.md` says `exit 0 (harness reported no error)`. The main thread re-ran the commands itself. A verdict has to come from captured exit codes, not from what the model says happened.
3. **`STATE.md` goes stale after ship.** After shipping, it still names the active change, and in L it says "next: verify". Ship neither updates nor stages it.
4. **Ship did not stage `.sdlc/.gitignore`** in the tier L run. `cmdShip` now stages it, and that fix is what the $0.27 tier M re-ship exercised.
5. **`/security-review` was skipped** because there was no `origin` remote. The reviewer covered security instead, as the review skill now prescribes.

### Spec 1 trial (2026-10-03)

Live run of `tests/trials/run-trials.sh` at commit 36089a3 on the todo-core sample, change `todo-due-dates`, tier M, models as above. The raw artifacts are kept with the Task 19 working notes.

| Run | Sessions | Cost | Turns | Wall time | Acceptance |
|---|---|---|---|---|---|
| Harness A (start and plan) | 1 | $1.100 (Opus $0.792, Sonnet $0.273, Haiku $0.035) | 12 | 281 s | – |
| Harness B (build, stopped at verify) | 1 | $0.457 (Sonnet only) | 23 | 127 s | 6/6 hidden, not shipped |
| Harness total | 2 | $1.557 (Opus share 51%) | 35 | 408 s | 6/6, not shipped |
| Plain Claude Code | 1 | $0.253 | 11 | 44 s | 6/6 |

Targets:
- **Stop blocks: 0.** `.gate` ends at `{blocks 0, warns 0}` and there is no `unresolved.json`, so the Stop gate raised no false positive. **Harness false positives: 1, so the 0-FP target is MISSED.** `verify-report` returned `result: fail` on correct, green work (41/41 tests green): `planVerification` extracted a command only when the backtick directly followed the bullet marker, and the architect wrote `Label: `cmd`` bullets, so all four plan bullets read as "Not run". The build agent correctly refused to hand-write `verification.md` or edit the approved plan, and stopped. That blocked ship. Fixed in 4cac9b1: the parser takes the first backticked span in command position, ignores prose and harness (`sdlc.ts`) bullets, and `agents/architect.md` now asks for one backticked command per bullet.
- **Cost: +44% against the $1.08 tier M trial ($1.557), target ≤ 5% MISSED.** It is a lower bound, because review and ship never ran. The Stop gate makes no model calls and blocked nothing, so the delta is not the gate: it is stage A's Opus share (architect and advisor, $0.79; 51% of the total against 39% in the earlier trial).
- **Median Stop-gate time: 164 ms, target ≤ 15 s met, but n = 1.** The only `runs.jsonl` row matching `.gate.last.at` is `npm test`. One sample is weak evidence.
- Skill fallbacks: 0.
- **Interactive checks (spec §15) not performed**: the trial was headless. The mod impact dialog (main-thread and subagent edits), the `sensors ✓/✗` band and the `/sdlc-sensors` pane are pending a human.
- Observation: `STATE.md` in the trial repo said "No active change" while `sdlc status` showed `todo-due-dates` at verify. See §11.

### v0.3 trial (2026-10-03): three arms, tier L, todo-core

Task: API-key auth, per-user isolation, pagination, atomic file store (`tests/trials/run-trials.sh L`). The arms ran in parallel; the whole run took 14 min 15 s. Hidden acceptance: `tests/trials/acceptance-L.test.js`, 5 cases including the empty-key bypass.

| Arm | Cost | Wall time | Acceptance | Outcome |
|---|---|---|---|---|
| Plain Claude Code | $0.37 | 80 s | 5/5 | done, uncommitted on main |
| Harness, native build | $3.12 | 474 s | 3/5 | stopped before Task 3 (pagination) on an open plan question; nothing committed |
| Harness, superpowers SDD build | $4.01 | 588 s | 5/5 | all 4 tasks built and committed per task; stopped at `Next: /sdlc:verify` (not verified, reviewed or shipped) |

Estimated cost split (`tests/trials/split.mjs`):

| Line | Native | SDD |
|---|---|---|
| Opus advisor (main thread) | $1.25 | $1.16 |
| Sonnet main thread | $1.11 | $1.49 |
| Opus architect | $0.38 | $0.33 |
| Sonnet implementers | $0.29 | $0.46 + $0.48 (SDD subagents) |
| Haiku scout | $0.06 | $0.05 |

Findings:
- **The Opus advisor is the largest single cost:** about 30–40% of each harness arm, three times the architect. This settles §11's open question. The §9 rule ("demote the architect if it dominates Opus spend") does not fire.
- **SDD stays the default for tier L.** It cost 1.28× native, under the 1.5× threshold, and finished every task. Native stalled.
- **Defect: plans carry unresolved gating questions.** The architect wrote "confirm the `GET /todos` shape before Task 3" into an approved plan. Headless, nobody answers it, so the native build stopped. Approval has to mean every open question is resolved or defaulted in `## Decisions`.
- **Defect: chained stages stop at the build's end line.** Both harness arms ended at `Next: /sdlc:verify` despite a prompt to continue. Neither verified nor shipped.
- **Plain Claude Code passed 5/5 at a tenth of the cost**, with no auth bypass this time. On a clear tier L task, the harness bought process and audit, not correctness.

## 11. Open items to verify

- Mod dollars come from the session cost ledger, which includes advisor and classifier calls. Reconcile them with `/usage` on a real multi-day project.
- Whether `autoCompactWindow` is honoured from project settings (it is documented as a user setting via `/autocompact`).
- `claude plugin eval` case format on the installed version.
- Edits made through Bash (`sed -i`, `cat >`, `python3 -`) bypass Write/Edit guards. The Stop and CI sensors now judge the resulting diff, so this is covered computationally rather than per edit.
- From the 2026-10-03 trials (all three fixed in Spec 1):
  - ~~The verifier must record captured exit codes, never inferred ones.~~ `sdlc.ts run` captures them and `verify-report` generates `verification.md`.
  - ~~Ship should clear `STATE.md` and stage it.~~
  - ~~Skill-load failures in `-p` need a deterministic fallback, or should be reported as an error.~~ A PostToolUseFailure hook hands the model `sdlc.ts skill <name>`.
- From the 2026-10-03 Spec 1 live trial (§10):
  - Cost target missed (+44%, a lower bound): find out why stage A spends 51% on Opus, and whether the architect or the advisor is the driver.
  - Rerun the tier M trial (paid) after the 4cac9b1 parser fix, to confirm it ships end to end and to get a full cost figure including review and ship.
  - The interactive mod checks still need a human: the impact dialog for main-thread and subagent edits, the `sensors ✓/✗` band, and the `/sdlc-sensors` pane.
  - `STATE.md` says "No active change" while a change is active. `createChange` and `setActive` rewrite only the `change:` frontmatter and keep the body, and `init` seeds that body with the "No active change." template. Only the model's build and handoff skills ever rewrite the body, and the build stopped at verify without doing so. `status` reads the frontmatter, so it is right; the session-start hook injects the body, so the model is told the opposite. Candidate fix (not made): `setActive` replaces a body that is still the template, and `verify` or `build` writes the slice and stage state mechanically.

## 12. Spec 1 (quality sensors, v0.2.0): deviations from the plan

Rulings made while building it; the code is the reference.
- Slugs must be at least 2 characters.
- Ten script files, not nine: `core`, `model`, `sensors`, `diffs`, `runs`, `check`, `hooks`, `metrics`, `sdlc` and `shell` (a bash-faithful tokenizer plus the read-only Bash allowlist).
- New `sensors.json` keys: `testSupport` (overlaid with the tests when proving against the base) and `fixtures` (files exempt from pattern sensors only; deletions are still tracked, and adding a fixture glob counts as weakening the harness). This plugin's own config sets `ignore` for `tests/trials/**`.
- Proof against the base depends on the change type: red (changed tests must fail on the base) for feature and greenfield at M and L and for bugfix and incident always; green-on-base for refactor at M and L; none for chore and migration.
- Ad-hoc tier: S if at most 3 source files and no contract, else M if at most 15, else L. It is re-tiered at ship and created only when there is a source diff.
- Impact gate: approving `impact` requires `impact.json`, and so do consumers that are not checked out. The approval digest covers `plan.md` plus the impact content without its timestamp.
- Read-only agents (scout, reviewer, verifier) get a Bash allowlist; verifier and reviewer may run `sdlc.ts run -- "<declared command>"` and nothing else.
- Evidence files (approvals, waivers, `runs.jsonl`, `verification.md`, `impact.json`, `.baseline`, `.gate`, `unresolved.json`) are written only by sdlc or the person. `verification.md` is generated by `sdlc.ts verify-report`.
- `npm run typecheck` covers the scripts only (CI). `npm run typecheck:mod` needs generated types, is local, and runs inside `npm test` with `claude plugin test .`.
- `runCommand` and the test kit strip `NODE_TEST_CONTEXT`, so a consumer's own `node --test` really runs.
- The mod adds `/sdlc-waive` (sensor names validated against `SENSOR_NAMES`), the `/sdlc-sensors` pane, the band, the impact dialog and per-edit notices. The harness-tamper dialog is intentionally not in the mod: the PreToolUse `ask` reason carries the same detail.

The Spec 1 live trial is recorded in §10.

## 13. v0.3

- **superpowers guides L builds.** Tier L and greenfield builds use superpowers subagent-driven development when it is installed (the settings template enables it), with sdlc overrides; otherwise the native sdlc implementers run.
- **Wiki.** `/sdlc:wiki` and `agents/wiki.md` (Sonnet, low effort) build `docs/wiki/`. `scripts/wiki.ts` stamps each page with a surface hash; a wiki-stale sensor warns at ship and CI but never blocks.
- **Guard freeze.** The local evidence guard is frozen at one best-effort rule. CI is the trust boundary.
- **LOC cap.** The harness (scripts, hooks, skills, agents, guides, templates, workflows, plugin JSON) is capped at 5000 lines by a test.
- **Fixes.** STATE.md follows the active change; tier L bugfix and incident get a plan gate after diagnosis; the size sensor warns on added lines over `limits.lineChars` (160); captured command output masks secrets.
- **/sdlc:next** runs the active change's next stage and stops at human gates.
- Trial results: see §10, v0.3 trial.
- **Lean S/M (after the v0.3 trials).** Gates by risk, not size: tier S and M have no human gate and no in-session review, and their plans are written by the main thread. Their one review runs on the PR (`templates/sdlc-review.yml`, advisory; `sdlc-check` stays the deterministic gate). A `tier` sensor blocks an S/M change whose diff reaches contracts or auth, security, payments, billing or migrations paths until it is re-tiered to L. The advisor is off (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`); SDD is opt-in (`"build": "sdd"`). A diff over `limits.diffLines` only warns once its plan is approved. Metrics such as first-pass share, rework cycles and `caught` now cover tier L only, because S/M have no review.md.
