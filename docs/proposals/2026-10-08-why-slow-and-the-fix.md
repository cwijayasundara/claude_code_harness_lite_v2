# Why working on this harness is slow, and how to make it fast and cheap

Evidence: the 736 transcript files under `~/.claude/projects/-Users-...-claude-code-harness-lite-v2/`
(2026-10-02 to 2026-10-08), the user and plugin settings on this machine, and the plugin sources.
Every number below was computed from those files.

## 1. Headline

| Fact | Value |
|---|---|
| Recorded spend, main sessions, 7 days | $878 (31 sessions) |
| Recorded spend, background security-review sessions, 6 days | $119 (688 sessions, 4.5 API-hours) |
| Share of all recorded spend on Opus 5.5 | $679 of $997 (68%) |
| Today's build session (eda1a927, "start Spec 2" to "merge to main") | $30.75, 2h51m wall-clock, 304 main-thread calls |
| Mean context per main-thread call in that session | 249k tokens (min 57k, max 479k); 75M cache-read tokens |
| Subagents launched in that session | 22, all sequential, 27M cache-read tokens between them |
| Longest single turn | 85 minutes (the implement/review loop) |
| System prompt before any work (first call of a fresh session) | 56.7k tokens |

**The rig plugin's own hooks are not the cause.** The `sdlc@sdlc` plugin is installed but not enabled
(`~/.claude/settings.json` `enabledPlugins` has no `sdlc` or `rig` entry), `.sdlc/.gate` was last written on
2026-10-07, and the per-turn `stop_hook_summary` records in today's transcript list exactly three Stop hooks,
none of them rig's. The "full verification after every change" you saw comes from elsewhere.

## 2. Root causes, in order of cost

### 2.1 The `security-guidance` plugin runs an agentic Opus security review after every turn and every subagent

`~/.claude/plugins/cache/claude-plugins-official/security-guidance/2.0.11/hooks/hooks.json` registers the review
on `Stop`, on `SubagentStop`, and on every `git commit` / `git push`. It spawns a separate Claude Code SDK session
(`entrypoint: sdk-py`), pinned to the newest Opus (`llm.py:139`), whose system prompt says
"Read EVERY changed file in full ... Then Grep for the changed function/class names to find callers"
(`review_api.py:71-80`), followed by a second Opus "refute" pass.

Counts of those sessions in this project directory: 119 (10-03), 92 (10-04), 23 (10-05), 131 (10-06),
75 (10-07), 100 (10-08). Today between 19:07 and 20:12 the same four-file diff
(`scripts/cicd.spec.ts` + three `templates/rig-*.yml`) was reviewed three separate times, and the final
12-file branch diff twice (once on Stop, once on push). This is what the screenshot's "full review on the most
capable model" and the review subagents on the band were doing, on top of the SDD reviewers below.

It does review only changed files, as you want. The problem is the trigger (every Stop and every
SubagentStop), the model (Opus, two passes), and the lack of a "already reviewed this hash on this branch"
guard across turns.

### 2.2 The build ran through the superpowers subagent-driven-development loop on an Opus coordinator

Today's session (and the $93 to $146 sessions on 10-03, 10-04, 10-06, 10-07, 10-08) followed the pattern
"implement task N (subagent) -> review task N (subagent) -> hand-back as a new user turn -> next task".
Nine tasks produced 22 subagent launches, each hand-back landed as a `SendMessage` user turn that fired all
Stop hooks again (and the security review again). The coordinator was `claude-opus-5-5` holding 250k tokens of
context on average, so every one of the 304 calls paid for a quarter-million-token cache read before doing any
work. `DESIGN.md` §6 says "Sonnet main thread" and "small fresh contexts per subagent"; the sessions did neither,
because this repo deliberately does not dogfood rig and so fell back to superpowers defaults.

### 2.3 The system prompt is 57k tokens before the first line of work

Measured from the attachments in today's transcript:

| Attachment | Bytes |
|---|---|
| skill listing (≈170 skills) | 36,054 |
| deferred tool listing (≈250 tools: Shopify, eToro, AWS Serverless MCP, Playwright, Google Workspace, ...) | 36,535 |
| agent listing (21 agent types with long descriptions) | 16,863 |
| MCP server instructions | 6,589 |
| superpowers SessionStart injection | 3,673 |

The source is `~/.claude/settings.json` `enabledPlugins`: 20 plugins enabled at **user** scope, including
`financial-analysis`, `private-equity`, `small-business`, `aws-serverless`, `playwright`, `sourcegraph`,
`typesafe`, `eli5`, `ralph-loop`, `claude-md-management`, `claude-code-setup`, `pr-review-toolkit`,
`code-simplifier`, `skill-creator`, `security-guidance`, `superpowers`, and `harness@harness-local`.
Every one of them is loaded into every session on every project, and the 57k baseline is re-read (cached)
on every call and re-written on every cache miss.

### 2.4 "The harness triggers itself": a different harness plugin is globally enabled

`harness@harness-local` resolves to `/Users/chamindawijayasundara/Documents/coding_harneses/claude_code_harness_x_v1`.
It contributes the `harness:harness-generator`, `harness:harness-evaluator`, `harness:harness-evaluator-fast`
agents and the `harness:harness-engineering-core`, `harness-context-selection`, `harness-tracker-publish` skills
you see in the listings, plus Stop, TaskCompleted, PostToolUse and SubagentStop hooks
(`.claude/hooks/hooks.json`, "Verifying production sensor evidence", 240 s timeout). Its gate exits early
here because there is no `.claude/harness.yaml`, so its time cost is small (max 135 ms per Stop today), but
its agents and skills sit in every prompt and are what the model picked when it reached for a "harness"
agent. The `ralph-loop` Stop hook is the third hook in every turn (10 to 50 ms, harmless, but useless here).

### 2.5 Settings that raise cost per call

`~/.claude/settings.json`: `alwaysThinkingEnabled: true`, `advisorModel: "opus"`, `autoDreamEnabled: true`,
`modelSettings.claude-opus-5.effortLevel: "high"`. The sessions that cost $90 to $146 all ran on
`claude-opus-5-5` as the main model.

### 2.6 What rig itself does per edit and per turn (for completeness)

`hooks/hooks.json` runs `sdlc.ts hook post-edit` on every Write/Edit (secret scan, plan check, slim
per-file sensors) and `hook stop` on every turn: built-in sensors on **this turn's diff only**, then the
`fast` commands from `.sdlc/sensors.json` (`npm run typecheck`, which is `tsc -p scripts/tsconfig.json` over
the whole `scripts/` tree) under a 60 s budget, with a diff-hash short-circuit (`gate.passed.main`). None of
this runs a model. When it is enabled, its cost is seconds, not dollars. It is not what made the week slow.

## 3. Proposal

### 3.1 Today, settings only (expected: most of the spend and most of the waiting)

1. **Stop the per-turn security reviews.** In `~/.claude/settings.json` `env`, add
   `"ENABLE_STOP_REVIEW": "0"` (keeps the commit and push reviews) or, for this repo,
   `"ENABLE_CODE_SECURITY_REVIEW": "0"` and run `/security-review` once per PR. If a per-commit review is wanted,
   set `"SECURITY_REVIEW_MODEL": "claude-sonnet-5-5"`.
2. **Move plugins to project scope.** Keep at user scope only `superpowers`, `code-review`, `typescript-lsp`.
   Disable `harness@harness-local`, `ralph-loop`, `financial-analysis`, `private-equity`, `small-business`,
   `aws-serverless`, `playwright`, `sourcegraph`, `typesafe`, `eli5`, `claude-code-setup`,
   `claude-md-management`, `pr-review-toolkit`, `code-simplifier`, `skill-creator`, `rust-analyzer-lsp` at user
   scope and re-enable each only in the projects that use it. Target: first-call context under 20k tokens.
3. **Main thread on Sonnet 5.5, Opus only by explicit choice.** Set `"model": "sonnet"` for this project (or
   `/model sonnet` at session start), `advisorModel` off or `sonnet`, `alwaysThinkingEnabled: false`
   (ask for thinking when a step needs it).
4. **Verify with the same measurement.** Start a fresh session, run one small change, and check the first
   assistant call's `cache_creation_input_tokens` in the transcript and the absence of `sdk-py` sessions.

### 3.2 This week, how we build this repo (expected: 3 to 5x fewer calls per change)

1. **One review per change, on the diff, at the end.** Do not run implement+review pairs per task. Implement
   all tasks of a plan inline (superpowers `executing-plans`) or with at most one Sonnet implementer per
   independent group, run `npm test` once, then one `/code-review` (or rig reviewer) on `git diff main...HEAD`.
   Fix findings in one wave. That is rig's own `build` rule for tiers S and M ("no model review"); apply it to
   building rig as well.
2. **Keep the coordinator small.** No subagent hand-backs through `SendMessage` (each one is a user turn that
   re-fires every Stop hook). Launch agents in the foreground and let the tool result return. `/compact` before
   the coordinator passes 100k; the active change lives in `.sdlc/STATE.md` and the plan file, not in context.
3. **Parallelize independent tasks** (the plan already marks `Files:` ownership) instead of serial pairs.
4. **Brief, not transcript.** Subagent briefs of 60 lines with file paths, not restated plans; today's briefs
   were 2k to 4k characters plus a 50k to 190k token fresh system prompt each, so 22 launches cost 2.5M cache
   writes.

### 3.3 In the harness itself (so target repos get the fast path by default)

1. **`rig init` writes `ENABLE_STOP_REVIEW=0` into the project `.claude/settings.json` env** and documents
   that the per-change review is rig's reviewer or `/security-review` at the PR node. Two overlapping review
   systems on every turn is the single biggest waste found.
2. **A context sensor.** `sdlc.ts status` already reads session usage for the band; add a warning when the first
   call of a session exceeds a threshold (say 25k tokens) with the list of enabled plugins, and when a turn's
   context exceeds 150k. The design doc's own "spend on turns over 150k context: 50%" finding needs a live
   guard, not a retrospective.
3. **Count background sessions.** `metrics` should count `sdk-py` sessions and hook-spawned reviews per change
   and show them next to the change's own cost, so a plugin like this is visible the day it is enabled.
4. **Stop gate: cache the `fast` typecheck by tree hash across turns** (it is keyed by diff hash today) and
   scope `tsc` to an incremental build (`"incremental": true` in `scripts/tsconfig.json`) so a passing Stop
   costs under two seconds.
5. **Pin the role models in the skills that build rig**, exactly as `routing.ts` does for target repos:
   Haiku reads, Sonnet writes, Opus only for a tier L design or final review, and never as the coordinator.

### 3.4 How we will know it worked

Re-run the transcript tally after one real change:

| Metric | This week | Target |
|---|---|---|
| First-call context (fresh session) | 56.7k | < 20k |
| Mean main-thread context per call | 249k | < 100k |
| Background review sessions per change | 10 to 20 | 0 (one explicit review) |
| Subagent launches per 9-task plan | 22 | ≤ 4 |
| Wall-clock for a Spec-2-sized change | 2h51m | < 45 min |
| Cost for a Spec-2-sized change | $31 + reviews | < $8 |
