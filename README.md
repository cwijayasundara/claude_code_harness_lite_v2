# rig: a thin AI-native SDLC harness for Claude Code

This plugin turns Claude Code into a disciplined software engineer. It adds very little of its own and relies on what Claude Code already provides. It follows [the AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) and measures both the playbook's metrics and what each change costs.

It handles every kind of task: greenfield, brownfield, feature, bugfix, refactor, migration, chore, spike and incident. How much process a change goes through depends on its type and tier. See [DESIGN.md](DESIGN.md) for the evidence and the reasoning behind each choice.

## Install

The harness lives in each repo it runs on, so a repo never depends on the plugin. You need the plugin only to initialise a repo and to upgrade it.

1. Install the plugin for yourself (once per machine):

   ```bash
   claude plugin marketplace add cwijayasundara/claude_code_harness_lite_v2
   claude plugin install rig@rig
   ```

   Or, for one session: `claude --plugin-dir /abs/path/to/claude_code_harness_lite_v2`.
2. In the repo, make a first commit if it has none, then run `/rig:init`. It writes a compact CLAUDE.md, `.sdlc/` (sensors, guides, the checker CI runs) and the code wiki, and copies the harness into the repo (`vendor --standalone`): skills to `.claude/skills/rig-*`, agents to `.claude/agents/rig-*`, hooks to `.claude/settings.json`, scripts to `.sdlc/bin`. It offers the CI check, the PR review workflow and [`templates/settings.json`](templates/settings.json) (Sonnet main thread, advisor off, Sonnet subagents).
3. Commit `.sdlc/`, `.claude/` and `CLAUDE.md`. Anyone who clones the repo, and any cloud session, now runs the harness with no install. In the repo the commands are `/rig-start`, `/rig-next` and so on.

**Where things live.** Change artifacts, approvals, waivers and run records go in `.sdlc/`, not `.claude/`, for two reasons. Claude Code treats `.claude/` as protected, so writes there prompt and fail in headless runs. And these files are evidence the `rig-check` CI gate reads, so they are meant to be committed. Machine-local state (`.gate`, `.baseline`, `usage.jsonl`, `unresolved.json`) is already in `.sdlc/.gitignore`.

**Upgrade** by re-running `node <plugin>/scripts/sdlc.ts vendor --standalone` from a newer plugin and committing; `.sdlc/bin/VERSION` records the version in the repo. To keep a repo on the plugin instead (central upgrades, no copy), tell onboarding the team installs the plugin.

**With and without the plugin.** A standalone repo has everything that decides what may happen: skills, agents, hooks, sensors, gates and the CI check. `/rig-approve` and `/rig-waive` are skills only the person can invoke: the model cannot call them, and it cannot set `SDLC_HUMAN` itself. Installing the plugin as well adds the mod: the band, the `/rig-sensors` pane, the impact dialog, `/rig-status` with no model call, and per-stage cost capture for `/rig:metrics`. The plugin's own hooks step aside in a standalone repo, so none runs twice. The mod needs Claude Code 2.1.287 or later.

## Use

| You type | What happens |
|---|---|
| `/rig:start "add CSV export to reports"` | Classifies type and tier, writes `.sdlc/changes/<slug>/intent.md`, and prints the path and the next command. Tier S is built in the same turn. |
| `/rig:next` | Runs whatever comes next for the active change, and stops only at human gates. The one command to remember. |
| `/rig:spec`, `/rig:plan`, `/rig:build`, `/rig:diagnose`, `/rig:test`, `/rig:pr-review`, `/rig:pr` | One stage each (`ship` stays a CLI alias of `pr`). Every stage ends with the exact next command. |
| `/rig-approve <slug> <spec\|plan\|impact\|tier>` | **Human gate.** A mod command: costs zero tokens, the model cannot invoke it, and the approval goes stale if the artifact changes afterwards. |
| `/rig-waive <sensor> <file\|*> <reason>` | **Human only.** Records a waiver for a sensor finding on the active change (the sensor name is validated). Zero tokens, and the model cannot invoke it. |
| `/rig-approve <slug> budget` | **Human gate.** Raises a change's spend cap; the model cannot. |
| `/rig-approve <slug> tier` | **Human gate.** Accepts a tier or type edited in `intent.md`; the recorded tier is the floor, so only a person can lower it. |
| `/rig:sensors` | Runs the sensors on the active change and prints what they found. |
| `/rig-run` | The driver: submits one node per turn and stops at a human gate, a block or a turn with no progress. |
| `/rig-story` | A pane with the change's nodes, rounds and cost against budget. Zero tokens. |
| `/rig-metrics-pane` | A pane with the scorecard: cost, tokens and value per change and node. Zero tokens. |
| `/rig-sensors` | A pane with what the sensors found, known-red items and waivers. Zero tokens. |
| `/rig:rule "<what keeps recurring>"` | Promotes a convention the agent keeps breaking into a mechanical rule in `.sdlc/rules.json`, once there are two real occurrences. |
| `/rig:learn` | Reads every shipped change, finds recurring review findings and waiver churn, and proposes harness edits, each replayed against past diffs. Zero tokens. A person promotes a passing rule with `/rig-approve <id> learn`. |
| `/rig-status` | Where every change stands. Zero tokens. |
| `/rig:incident "<what broke>"` | Maintain stage: records the incident and opens a bugfix-path change. |
| `/rig:wiki` | Builds or updates the code wiki in `docs/wiki/`. |
| `/rig:metrics [days]` | The playbook's 12 metrics (leading and lagging per stage) plus cost per change, stage and agent. |

## Team install

1. Onboard as above and commit; teammates need nothing else. To upgrade a repo, run `claude plugin marketplace update rig`, re-run `vendor --standalone` and commit. Releases are tagged (`v0.3.7`), and DESIGN.md records what each one changed and measured.
2. Builds use sdlc's own implementers. To run a tier L or greenfield build through superpowers subagent-driven development (6.4.1 or later), enable superpowers and set `"build": "sdd"` in `.sdlc/sensors.json`. It costs several times the tokens, so keep it for plans with many independent slices.
3. For the PR review, add a `CLAUDE_CODE_OAUTH_TOKEN` repository secret (your Pro/Max plan, from `claude setup-token`) or an `ANTHROPIC_API_KEY`, copy `templates/rig-review.yml`, and make `rig-check` and `rig-review` required checks with both workflows in CODEOWNERS.

**Opus advisor: off.** In the v0.3 trials an Opus advisor on the main thread was the largest single cost, about a third of each run. A user-level `advisorModel` still applies to every project, so the template turns the advisor off with `"env": { "CLAUDE_CODE_DISABLE_ADVISOR_TOOL": "true" }`. Remove that line to opt back in. Opus still writes tier L specs and plans (architect) and reviews.

**Gates by risk, not size.** Tier S and M have no human gate. Their build still reviews each slice in session (a bounded loop), then they walk test, sensors, pr and, when the PR review workflow is not installed, pr-review. Where the workflow is installed, the review of the PR runs there from `templates/rig-review.yml` (Opus with no shell or network, reading a prepared diff; a model-free step posts the comment after a credential check; fails only on a high-severity finding; needs a `CLAUDE_CODE_OAUTH_TOKEN` secret from `claude setup-token` for a Pro/Max plan, or an `ANTHROPIC_API_KEY`). Tier L, and anything touching auth, payments, data, security or a public contract, keeps the spec and plan gates and an in-session `/code-review` plus the plan-contract check. A diff over `limits.diffLines` blocks at ship unless the person approved its plan.

## Cloud sessions

Long builds belong in a Claude Code cloud session (claude.ai/code or `claude --cloud`). It keeps running while your laptop sleeps. In the Prism build, the laptop sleeping accounted for most of the 3 days. A standalone repo runs there as it is: `claude --cloud "/rig-next — continue through ship; commit on the branch"`. The result comes back as a pushed branch or PR, and `--teleport` brings the session back to your machine. Tier S and M changes have no gates, so they can run in the cloud from start to finish. For tier L, approve the spec and plan locally and push before the cloud build: `/rig-approve` has not been tried in a cloud session.

## Guides and sensors

Computational sensors run on the hot path at zero tokens; one inferential review runs per change. `sdlc.ts check` is the single entry point, so local equals CI.
- **Config** is `.sdlc/sensors.json`: `fast`/`full` commands, `tests`, `testSupport` (overlaid with the tests when proving against the base), `fixtures` (exempt from pattern sensors only; deletions stay tracked and adding a glob counts as weakening), `ignore`, `contracts`, `consumers`, `layers`, `limits`, `knownRed`. `.sdlc/rules.json` holds regex rules.
- **Sensors:** test-tamper, suppression, layering, size, secrets, rules, contract-impact, harness-tamper, traceability and red-proof, plus ad-hoc, commands and config findings.
- **When they fire:** on each edit (secrets, tamper and guide context, as notices), at Stop (the turn's diff), at plan and ship (traceability, red-proof, impact), and in CI.
- **Red-proof** depends on the change type: changed tests must fail on the base for bugfix and incident, and for feature and greenfield at M and L; they must pass on the base for refactor at M and L; chore and migration are exempt.
- **Stop cap:** a turn is blocked at most 2 times, then the findings go to `.sdlc/unresolved.json` and ship and CI refuse them, so a loop cannot wedge a session. Findings that are red on the base are ratcheted as known-red rather than blamed on the change.
- **Waivers** come only from the person (`/rig-waive`). Evidence files (approvals, waivers, `runs.jsonl`, `verification.md`, `impact.json`, `ratchet.json`, `events.jsonl`, `pr.md`, `ship.json`, `.gate`) are written only by sdlc.
- **Guides** (contracts, engineering, testing) are copied to `.sdlc/guides/` by init and injected on first touch of a matching path.
- **CI:** `sdlc.ts vendor` copies the checker into `.sdlc/bin`; copy `templates/rig-check.yml` and require `rig-check`. CI runs the base branch's checker and config.

**Autonomous build to PR.** A feature or greenfield change goes intent → design: `/rig:start` writes `intent.md`, `design.md` follows in the same turn, and the person is asked **once** (the mod shows an Approve dialog; `/rig-approve <slug> design` without the mod) for both files together. Once the design is approved, build runs slice by slice with a bounded review loop per slice, then test levels, quality sensors compared with the base branch, and the PR with its checks; commands declared in sensors.json and edits inside the plan's files need no prompt. Humans keep approvals, waivers and budget raises. `sensors.json` keys: `gates` (human gates per tier), `levels` (test commands per level), `quality` (lint-style commands compared with base), `ratchet` (round and budget caps) and `value` (`{ rate, hours }`: an hourly rate and hours saved per tier S, M and L, so value is an estimate). Run autonomous builds in Claude Code's sandbox.

For long unattended builds, `/rig:build` prints a ready `/goal` line, so you don't have to keep typing "continue".

## What is in the box

| Part | Role |
|---|---|
| `skills/` (15) | The stages, run by the main thread (Sonnet 5.5; the Opus advisor is opt-in, see below). No skill sets `model:`, because a model switch re-reads the whole conversation uncached. Opus comes in through the architect and reviewer agents, which start with their own small contexts. |
| `agents/scout.md` | Haiku, read-only, `omitClaudeMd`. Cheap code search, used instead of Explore running on your main model. |
| `agents/architect.md` | **Opus 5.5**, high effort. Writes spec.md and plan.md, the design-heavy steps. |
| `agents/implementer.md` | **Sonnet 5.5**. The code generator: builds one slice test-first and reports real test output. |
| `agents/reviewer.md` | **Opus 5.5**, high effort. One independent review per change, keeping findings at confidence 80 or above. |
| `agents/verifier.md` | Sonnet 5.5. Runs the verification commands and writes the report. Never repairs. |
| `hooks/hooks.json` | Settings hooks, which also hold in `-p` and CI. They inject session context, block model-made approvals, ask about edits outside the plan's `## Files`, and reject secrets or plans that contain code (exit 2). |
| `hooks/register.ts` | The mod. It records per-turn tokens and the dollar delta from the session ledger, shows the context and spend band, runs the zero-token commands and the context-budget nudges, and gives general-purpose subagents Sonnet by default. |
| `scripts/*.ts` (19, not counting specs and testkit) | Zero-dependency Node, no build step (the list names the main ones; the rest are `graph`, `ratchet`, `levels`, `quality`, `autoapprove`, `pr`, `scorecard` and `vendor`): `core` (paths, change state, approvals), `model` (pure diff, config and glob model), `sensors` (the pure sensors), `diffs` (baselines and git diffs), `runs` (captured exit codes and verification reports), `check` (one `check` entry point for Stop, plan, ship and CI), `hooks` (hook decisions and the Stop gate), `metrics` (playbook metrics and cost), `wiki` (surface hash and stale pages), `sdlc` (the CLI), `shell` (bash-faithful tokenizer and the read-only Bash allowlist). |
| `guides/` | Short per-area guides (contracts, engineering, testing) injected when a matching file is touched. |
| `templates/rig-check.yml` | The required CI check, judged by the base branch's vendored checker. |
| `templates/rig-review.yml` | One background Claude review per PR, for tier S and M and as a second look on L. |

Artifacts live in **`.sdlc/`** at the repo root and are committed; `usage.jsonl` is gitignored. They are not under `.claude/`, which Claude Code protects: writes there always prompt, or are denied in headless runs, and allow rules can't change that.

## Develop

```bash
npm run typecheck                            # scripts only (what CI runs)
node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts
npm run typecheck:mod                        # the mod; needs generated types, so local only
claude plugin test .                         # mod tests
npm test                                     # all of the above
claude plugin validate .claude-plugin/plugin.json
tests/trials/run-trials.sh [M|L|I|S] [outdir] # LIVE and PAID: M (about $1), L (three arms, about $8), I (integration, about $1), S (greenfield, bugfix and refactor scenarios, about $4)
```
