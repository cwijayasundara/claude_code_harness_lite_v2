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

## 11. Open items to verify

- Mod dollars come from the session cost ledger, which includes advisor and classifier calls. Reconcile them with `/usage` on a real multi-day project.
- Whether `autoCompactWindow` is honoured from project settings (it is documented as a user setting via `/autocompact`).
- `claude plugin eval` case format on the installed version.
- Edits made through Bash (`sed -i`, `cat >`, `python3 -`) bypass Write/Edit guards. Scope-drift at ship is the real gate, and per-edit guards are best-effort.
