# sdlc: a thin AI-native SDLC harness for Claude Code

This plugin turns Claude Code into a disciplined software engineer. It adds very little of its own and relies on what Claude Code already provides. It follows [the AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) and measures both the playbook's metrics and what each change costs.

It handles every kind of task: greenfield, brownfield, feature, bugfix, refactor, migration, chore, spike and incident. How much process a change goes through depends on its type and tier. See [DESIGN.md](DESIGN.md) for the evidence and the reasoning behind each choice.

## Install

For a team, once per project:

1. Add the marketplace and install the plugin for the project (it lands in the committed `.claude/settings.json`):

   ```bash
   claude plugin marketplace add cwijayasundara/claude_code_harness_lite_v2 --scope project
   claude plugin install sdlc@sdlc --scope project
   ```

2. Merge [`templates/settings.json`](templates/settings.json) into `.claude/settings.json` and commit it, so every engineer gets the same models and switches: Sonnet main thread, advisor off (`CLAUDE_CODE_DISABLE_ADVISOR_TOOL`), Sonnet as the default subagent model (`CLAUDE_CODE_SUBAGENT_MODEL`), and the unrelated plugins off.
3. Run `/sdlc:onboard` once. It sets up `.sdlc/` and the sensors, offers the CI check and the PR review workflow, writes a compact CLAUDE.md and builds the code wiki in `docs/wiki/`.

To try it for one session without installing: `claude --plugin-dir /abs/path/to/claude_code_harness_lite_v2`.

Requires Claude Code 2.1.287 or later for the mod (band, zero-token commands, impact dialog). The skills, agents and settings hooks work on older versions.

## Use

| You type | What happens |
|---|---|
| `/sdlc:start "add CSV export to reports"` | Classifies type and tier, writes `.sdlc/changes/<slug>/intent.md`, and prints the path and the next command. Tier S is built in the same turn. |
| `/sdlc:next` | Runs whatever comes next for the active change, and stops only at human gates. The one command to remember. |
| `/sdlc:spec`, `/sdlc:plan`, `/sdlc:build`, `/sdlc:diagnose`, `/sdlc:verify`, `/sdlc:review`, `/sdlc:ship` | One stage each. Every stage ends with the exact next command. |
| `/sdlc-approve <slug> <spec\|plan>` | **Human gate.** A mod command: costs zero tokens, the model cannot invoke it, and the approval goes stale if the artifact changes afterwards. |
| `/sdlc-waive <sensor> <file\|*> <reason>` | **Human only.** Records a waiver for a sensor finding on the active change (the sensor name is validated). Zero tokens, and the model cannot invoke it. |
| `/sdlc-sensors` | A pane with what the sensors found, known-red items and waivers. Zero tokens. |
| `/sdlc:rule "<what keeps recurring>"` | Promotes a convention the agent keeps breaking into a mechanical rule in `.sdlc/rules.json`, once there are two real occurrences. |
| `/sdlc-status` | Where every change stands. Zero tokens. |
| `/sdlc:incident "<what broke>"` | Maintain stage: records the incident and opens a bugfix-path change. |
| `/sdlc:wiki` | Builds or updates the code wiki in `docs/wiki/`. |
| `/sdlc:metrics [days]` | The playbook's 12 metrics (leading and lagging per stage) plus cost per change, stage and agent. |

## Team install

1. Install as above. Upgrades reach everyone through `claude plugin marketplace update sdlc`; releases are tagged (`v0.3.3`), and DESIGN.md records what each one changed and measured.
2. Builds use sdlc's own implementers. To run a tier L or greenfield build through superpowers subagent-driven development (6.4.1 or later), enable superpowers and set `"build": "sdd"` in `.sdlc/sensors.json`. It costs several times the tokens, so keep it for plans with many independent slices.
3. For the PR review, add an `ANTHROPIC_API_KEY` repository secret, copy `templates/sdlc-review.yml`, and make `sdlc-check` and `sdlc-review` required checks with both workflows in CODEOWNERS.

**Opus advisor: off.** In the v0.3 trials an Opus advisor on the main thread was the largest single cost, about a third of each run. A user-level `advisorModel` still applies to every project, so the template turns the advisor off with `"env": { "CLAUDE_CODE_DISABLE_ADVISOR_TOOL": "true" }`. Remove that line to opt back in. Opus still writes tier L specs and plans (architect) and reviews.

**Gates by risk, not size.** Tier S and M have no human gate and no in-session review: they run plan, build, verify and ship in one turn. Their single review runs on the PR from `templates/sdlc-review.yml` (Opus with no shell or network, reading a prepared diff; a model-free step posts the comment after a credential check; fails only on a high-severity finding; needs an `ANTHROPIC_API_KEY` secret). Tier L, and anything touching auth, payments, data, security or a public contract, keeps the spec and plan gates and an in-session `/code-review` plus the plan-contract check. A diff over `limits.diffLines` blocks at ship unless the person approved its plan.

## Guides and sensors

Computational sensors run on the hot path at zero tokens; one inferential review runs per change. `sdlc.ts check` is the single entry point, so local equals CI.
- **Config** is `.sdlc/sensors.json`: `fast`/`full` commands, `tests`, `testSupport` (overlaid with the tests when proving against the base), `fixtures` (exempt from pattern sensors only; deletions stay tracked and adding a glob counts as weakening), `ignore`, `contracts`, `consumers`, `layers`, `limits`, `knownRed`. `.sdlc/rules.json` holds regex rules.
- **Sensors:** test-tamper, suppression, layering, size, secrets, rules, contract-impact, harness-tamper, traceability and red-proof, plus ad-hoc, commands and config findings.
- **When they fire:** on each edit (secrets, tamper and guide context, as notices), at Stop (the turn's diff), at plan and ship (traceability, red-proof, impact), and in CI.
- **Red-proof** depends on the change type: changed tests must fail on the base for bugfix and incident, and for feature and greenfield at M and L; they must pass on the base for refactor at M and L; chore and migration are exempt.
- **Stop cap:** a turn is blocked at most 2 times, then the findings go to `.sdlc/unresolved.json` and ship and CI refuse them, so a loop cannot wedge a session. Findings that are red on the base are ratcheted as known-red rather than blamed on the change.
- **Waivers** come only from the person (`/sdlc-waive`). Evidence files (approvals, waivers, `runs.jsonl`, `verification.md`, `impact.json`, `.gate`) are written only by sdlc.
- **Guides** (contracts, engineering, testing) are copied to `.sdlc/guides/` by init and injected on first touch of a matching path.
- **CI:** `sdlc.ts vendor` copies the checker into `.sdlc/bin`; copy `templates/sdlc-check.yml` and require `sdlc-check`. CI runs the base branch's checker and config.

For long unattended builds, `/sdlc:build` prints a ready `/goal` line, so you don't have to keep typing "continue".

## What is in the box

| Part | Role |
|---|---|
| `skills/` (14) | The stages, run by the main thread (Sonnet 5.5; the Opus advisor is opt-in, see below). No skill sets `model:`, because a model switch re-reads the whole conversation uncached. Opus comes in through the architect and reviewer agents, which start with their own small contexts. |
| `agents/scout.md` | Haiku, read-only, `omitClaudeMd`. Cheap code search, used instead of Explore running on your main model. |
| `agents/architect.md` | **Opus 5.5**, high effort. Writes spec.md and plan.md, the design-heavy steps. |
| `agents/implementer.md` | **Sonnet 5.5**. The code generator: builds one slice test-first and reports real test output. |
| `agents/reviewer.md` | **Opus 5.5**, high effort. One independent review per change, keeping findings at confidence 80 or above. |
| `agents/verifier.md` | Sonnet 5.5. Runs the verification commands and writes the report. Never repairs. |
| `hooks/hooks.json` | Settings hooks, which also hold in `-p` and CI. They inject session context, block model-made approvals, ask about edits outside the plan's `## Files`, and reject secrets or plans that contain code (exit 2). |
| `hooks/register.ts` | The mod. It records per-turn tokens and the dollar delta from the session ledger, shows the context and spend band, runs the zero-token commands and the context-budget nudges, and gives general-purpose subagents Sonnet by default. |
| `scripts/*.ts` (11) | Zero-dependency Node, no build step: `core` (paths, change state, approvals), `model` (pure diff, config and glob model), `sensors` (the pure sensors), `diffs` (baselines and git diffs), `runs` (captured exit codes and verification reports), `check` (one `check` entry point for Stop, plan, ship and CI), `hooks` (hook decisions and the Stop gate), `metrics` (playbook metrics and cost), `wiki` (surface hash and stale pages), `sdlc` (the CLI), `shell` (bash-faithful tokenizer and the read-only Bash allowlist). |
| `guides/` | Short per-area guides (contracts, engineering, testing) injected when a matching file is touched. |
| `templates/sdlc-check.yml` | The required CI check, judged by the base branch's vendored checker. |
| `templates/sdlc-review.yml` | One background Claude review per PR, for tier S and M and as a second look on L. |

Artifacts live in **`.sdlc/`** at the repo root and are committed; `usage.jsonl` is gitignored. They are not under `.claude/`, which Claude Code protects: writes there always prompt, or are denied in headless runs, and allow rules can't change that.

## Develop

```bash
npm run typecheck                            # scripts only (what CI runs)
node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts
npm run typecheck:mod                        # the mod; needs generated types, so local only
claude plugin test .                         # mod tests
npm test                                     # all of the above
claude plugin validate .claude-plugin/plugin.json
tests/trials/run-trials.sh [M|L] [outdir]     # LIVE and PAID: M (about $2) or L (three arms, about $8)
```
