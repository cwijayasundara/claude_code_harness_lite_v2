# rig: a thin AI-native SDLC harness for Claude Code

This plugin turns Claude Code into a disciplined software engineer. It adds very little of its own and relies on what Claude Code already provides. It follows [the AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) and measures both the playbook's metrics and what each change costs.

It handles every kind of task: greenfield, brownfield, feature, bugfix, refactor, migration, chore, spike and incident. How much process a change goes through depends on its type and tier. See [DESIGN.md](DESIGN.md) for the evidence and the reasoning behind each choice.

## Status

As of 2026-10-06. `.claude-plugin/plugin.json` says **0.4.1**, the last release and tag; everything built since is on `main` and listed under *Unreleased* in [CHANGELOG.md](CHANGELOG.md). No later release has been cut.

| Area | State | Evidence |
|---|---|---|
| Lifecycle: start, design or plan, build, test, sensors, PR, review; human gates; tiers | Shipped and trialled live with paid runs | [DESIGN.md](DESIGN.md) §§8 and 9 |
| Autonomous ratchet (bounded build, quality and cost caps) and `rig learn` | Shipped | DESIGN §§9 and 10 |
| Git hooks: `pre-commit`, `pre-push`, session-start wiring, warnings the agent sees, and the guard that stops the model bypassing them | Merged and covered by tests that drive real `git`. **Not yet trialled live.** The bypass guard is a best-effort text match: CI plus branch protection is the boundary, and the guard's open gaps are listed | DESIGN §11, [SECURITY.md](SECURITY.md) |
| Code wiki: computed diagrams, tables and history, `wiki build/check/status/search`, `/rig:ask` | Merged and tested; run end to end on a sample app. **Not yet used on a large real repo.** Diagrams are computed for JS/TS and Python only | DESIGN §12 |
| `rig-wiki` refresh workflow | **Never run on GitHub.** Its privilege split was reviewed and is linted, but the first-run checklist in DESIGN §12 is still open | DESIGN §12 |
| Windows | **Not supported.** Its CI jobs are red, and the hook scripts are POSIX `sh` | SECURITY.md |

**Quality gates on `main`:** the full suite (about 600 tests), `npm run typecheck` and `claude plugin validate` pass locally. In CI the Linux and macOS jobs and the dogfood check are the ones to trust; the Windows jobs fail for the reason above.

**Known limits worth knowing before you adopt it:** the live trials predate the git hooks and the wiki; hooks only protect what is committed through git, so `--no-verify` by a person leaves CI as the only judge; the wiki's model-written prose is reviewed in a PR, not machine-checked beyond citations and section presence. The open items for each area are in DESIGN §§11 and 12.

## How the harness is put together

rig is a **thin control layer** around Claude Code. It owns five things (the artifact chain, human gates, guardrails, routing and budgets, measurement) and borrows everything else (plan mode, `/code-review`, `/security-review`, `/goal`, worktrees) from Claude Code itself.

### Core design principles

| # | Principle | What it means in practice |
|---|---|---|
| 1 | **Thin layer, built-ins first** | Own only the five things above. Do not rebuild what Claude Code ships. |
| 2 | **Ceremony scales with risk** | Routing is type × tier. A tier S chore never pays for a design gate; auth, payments and public contracts always do. |
| 3 | **State lives in files, not chat** | `.sdlc/changes/<slug>/` is the memory. Any session, local or cloud, resumes from it. Status is derived from which files exist. |
| 4 | **Humans gate, models never self-approve** | `/rig-approve` and `/rig-waive` are human-only. Approvals go stale when the artifact changes. |
| 5 | **Deterministic checks decide, models advise** | Sensors, red-proof, scope and secrets are computed by scripts at zero tokens. One inferential review runs per change. |
| 6 | **Local equals CI** | One `check` entry point serves Stop, plan, ship and CI. CI judges a PR with the *base branch's* checker, so a PR cannot weaken its own judge. |
| 7 | **Right model for the job** | Sonnet writes code, Opus designs and reviews, Haiku searches. No skill switches model mid-conversation (that re-reads the context uncached). |
| 8 | **Bounded loops** | Review rounds, Stop blocks and spend are capped. Past a cap the finding goes to `unresolved.json` and ship refuses it. A loop cannot wedge a session. |
| 9 | **Measure, then change** | Every release is trialled and its cost summarised in DESIGN.md. `/rig:learn` proposes harness edits and replays each against past diffs first. |
| 10 | **Every step ends with the next command** | You never have to guess what to type. `/rig:next` is the one to remember. |

### The layers

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │ YOU            /rig:start  /rig:next  /rig-approve  /rig-waive         │  intent, approval
 ├────────────────────────────────────────────────────────────────────────┤
 │ SKILLS (18)    start design plan diagnose build test sensors pr ask …  │  the stages: prompts
 ├────────────────────────────────────────────────────────────────────────┤
 │ AGENTS (6)     scout·haiku  architect·opus  implementer·sonnet         │  model routing:
 │                reviewer·opus  verifier·sonnet  wiki                    │  small fresh contexts
 ├────────────────────────────────────────────────────────────────────────┤
 │ HOOKS          session-start · pre-bash · pre-edit · post-edit ·       │  guardrails: run in
 │                stop · subagent-stop · prompt-submit                    │  -p and CI, zero tokens
 │                + git: pre-commit · pre-push (any editor or agent)      │
 ├────────────────────────────────────────────────────────────────────────┤
 │ SCRIPTS        sdlc.ts → check · sensors · graph · ratchet · runs …    │  the deterministic brain
 ├────────────────────────────────────────────────────────────────────────┤
 │ MOD (optional) band · /rig-status · /rig-story · /rig-run · cost       │  UI and telemetry only;
 │                capture                                                 │  nothing essential here
 ├────────────────────────────────────────────────────────────────────────┤
 │ EVIDENCE       .sdlc/changes/<slug>/  intent design plan runs.jsonl    │  committed; read by
 │                verification approvals waivers pr.md ship.json          │  CI (`rig-check`)
 └────────────────────────────────────────────────────────────────────────┘
```

Dependencies point downward and evidence flows upward. Skills never decide anything the scripts can compute, and nothing essential depends on the optional mod. The scripts are plain Node with no build step and no dependencies.

### Command graph: the lifecycle of one change

Squares are commands, hexagons are **human gates**, and the dotted edge is the repair loop. Run `/rig:next` at any node and it picks the right edge.

```mermaid
flowchart TD
    I["/rig:init<br/><i>once per repo</i>"] --> S
    S["/rig:start &quot;task&quot;<br/><i>classify type × tier,<br/>write intent.md</i>"] --> R{type?}

    R -- "feature · greenfield" --> D["/rig:design<br/><i>design.md: slices + tests</i>"]
    R -- "refactor · migration" --> P["/rig:plan<br/><i>plan.md</i>"]
    R -- "bugfix · incident" --> DG["/rig:diagnose<br/><i>failing test, root cause, fix</i>"]
    R -- "chore" --> B
    R -- "spike" --> N["notes.md<br/><i>read-only answer</i>"]

    D --> G1{{"/rig-approve slug design<br/><b>HUMAN GATE</b><br/><i>intent + design, once</i>"}}
    P -. "tier L, or risky" .-> G2{{"/rig-approve slug plan<br/><b>HUMAN GATE</b>"}}
    P --> B
    G1 --> B
    G2 --> B

    B["/rig:build<br/><i>per slice: implementer → sensors → reviewer</i>"] --> T
    DG --> T["/rig:test<br/><i>unit → integration → acceptance → api</i>"]
    T --> SN["/rig:sensors<br/><i>lint, types, audit, coupling vs base</i>"]
    SN --> PR["/rig:pr<br/><i>scope gate, ship gate, commit, open PR</i>"]
    PR --> RV["/rig:pr-review<br/><i>or CI rig-review</i>"]
    RV --> CI["CI: rig-check<br/><i>base branch's checker</i>"]
    CI --> M(["merge"])

    T -. "red: fix round (capped)" .-> B
    SN -. "finding: one fix round" .-> B
    RV -. "high finding" .-> B

    SN -. "needs a waiver" .-> W{{"/rig-waive<br/><b>HUMAN ONLY</b>"}}
    B -. "budget hit" .-> BG{{"/rig-approve slug budget<br/><b>HUMAN ONLY</b>"}}
    CI -. "approval rows added" .-> H{{"someone other than<br/>the author approves"}}

    classDef gate fill:#fde68a,stroke:#b45309,color:#000
    class G1,G2,W,BG,H gate
```

Which gates a change actually meets comes from `gates` in `.sdlc/sensors.json` (default: tier S none, M design, L and greenfield spec, plan and design) and only where that stage is on the change's path. In practice a feature meets one design gate at M and L, and a refactor or bugfix meets a plan gate at L. A change whose recorded tier or type is edited later falls back to the stricter reading until a person runs `/rig-approve <slug> tier`.

### Routes: one metro map

Each line is a change type. `●` is a node, `◆` is a gate that applies at tier L (design also at tier M for features).

```
feature     ●start ─ ●design ─◆─ ●build ─ ●test ─ ●sensors ─ ●pr ─ ●pr-review
greenfield  ●start ─ ●design ─◆─ ●build ─ ●test ─ ●sensors ─ ●pr ─ ●pr-review
refactor    ●start ─ ●plan ───◆─ ●build ─ ●test ─ ●sensors ─ ●pr ─ ●pr-review
migration   ●start ─ ●plan ───◆─ ●build ─ ●test ─ ●sensors ─ ●pr ─ ●pr-review
bugfix      ●start ─ (●plan ◆ at L) ─ ●diagnose ─ ●test ─ ●sensors ─ ●pr ─ ●pr-review
incident    ●start ─ (●plan ◆ at L) ─ ●diagnose ─ ●test ─ ●sensors ─ ●pr ─ ●pr-review
chore       ●start ─────────────────── ●build ─ ●test ─ ●sensors ─ ●pr ─ ●pr-review
spike       ●start ─ ●notes                                      (no code, no gates)
```

For tier S and M the `pr-review` stop is dropped when the `rig-review` workflow is installed, because CI performs it. `/rig:incident` joins the map from the side: it records what broke and opens an `incident` change on the bugfix line.

### Command atlas: when to reach for each

**Drive the change** (the model runs these; `/rig:next` chains them)

| Command | Use it when | Cost |
|---|---|---|
| `/rig:init` | First time in a repo. Writes CLAUDE.md, `.sdlc/`, the wiki, and vendors the harness. | tokens, once |
| `/rig:start "<task>"` | Any new task, or to resume one by slug. | tokens |
| `/rig:next` | You are not sure what is next. Runs the next node, stops at a human gate. | tokens |
| `/rig:design` · `/rig:plan` · `/rig:spec` | Writing the design (feature, greenfield), plan (refactor, migration, L bugfix) or spec. | Opus architect |
| `/rig:diagnose` | Bugfix or incident: reproduce with a failing test, then the smallest fix. | tokens |
| `/rig:build` | Approved design or plan: slice by slice, bounded review loop. | Sonnet + Opus review |
| `/rig:test` · `/rig:sensors` | After build: run every test level, then the quality sensors against base. | mostly zero-token |
| `/rig:pr` · `/rig:pr-review` | Ship: commit, push, open the PR, then review it and wait for green checks. | tokens |
| `/rig:incident "<what broke>"` | Production is on fire. Records it and opens a bugfix-path change. | tokens |

**Look, at zero tokens** (mod; no model call)

| Command | Shows |
|---|---|
| `/rig-status` | Where every change stands and the next command. |
| `/rig-story` | The active change's nodes, rounds and cost against budget. |
| `/rig-sensors` | Findings, known-red items and waivers. |
| `/rig-metrics-pane` | The scorecard: cost, tokens and value per change and node. |
| `/rig-run` | Drives the change one node per turn; stops at a gate, a block, or no progress (`/rig-run stop` pauses). |

**Decide, human only** (the model cannot invoke these and cannot set `SDLC_HUMAN`)

| Command | Authorises |
|---|---|
| `/rig-approve <slug> design\|spec\|plan` | The artifact as written. Stale if it changes afterwards. |
| `/rig-approve <slug> impact` | A cross-repo impact set. |
| `/rig-approve <slug> budget` | A higher spend cap. |
| `/rig-approve <slug> tier S\|M\|L [type]` | A tier or type edit. The recorded tier is a floor, so only a person lowers it. |
| `/rig-waive <sensor> <file\|*> <reason>` | One sensor finding on the active change. |
| `/rig-approve <learn-id> learn` | A rule that `/rig:learn` proved against past diffs. |

**Improve the harness itself**

| Command | Use it when |
|---|---|
| `/rig:rule "<what recurs>"` | The agent broke the same convention twice: promote it to a mechanical rule. |
| `/rig:learn` | After a batch of changes ships: find recurring findings and waiver churn, propose edits, replay each. |
| `/rig:metrics [days]` | You want the 12 playbook metrics plus cost per change, stage and agent. |
| `/rig:wiki` | After init, or when pages go stale: regenerate the diagrams and tables (zero tokens) and rewrite stale prose. |
| `/rig:ask "<question>"` | You want to know how something works: a Haiku scout answers from the wiki and the lines it cites. |

**The script underneath** (`node .sdlc/bin/sdlc.ts <cmd>`): `status`, `next`, `check`, `check-file`, `diff`, `quality`, `ratchet`, `run`, `verify-report`, `pr`, `pr-checks`, `scope-drift`, `secrets`, `waive`, `approve`, `impact-status`, `metrics`, `scorecard`, `learn`, `wiki (status, build [--check], search, stamp)`, `vendor`, `hooks`, `hook <event>`. Skills and CI call these; so can you.

### What fires when (the automatic edges)

| Moment | Hook | What happens, at zero tokens |
|---|---|---|
| Session opens | `session-start` | Injects the active change, its next command and the guides that apply. |
| You submit a prompt | `prompt-submit` | Snapshots the tree as the turn baseline, so Stop judges exactly this turn's diff. (Subagents get their own baseline at `subagent-start`.) |
| Before a shell command | `pre-bash` | Blocks writes to evidence files, secret reads and forged `SDLC_HUMAN`; allows only a read-only command set for read-only agents. |
| Before an edit | `pre-edit` | Asks about files outside the plan's `## Files`; rejects secrets and plans containing code. |
| After an edit | `post-edit` | Notices for secrets, test tampering and the matching guide. |
| A turn or subagent ends | `stop`, `subagent-stop` | Runs the sensors on the turn's diff; blocks at most 2 times, then records `unresolved.json`. |
| You commit | git pre-commit | The staged diff goes through the Stop sensors and the fast commands; warnings print with their fix text, blocks refuse the commit (during a merge or rebase only the fast commands are skipped). |
| You push | git pre-push | The branch's commits (against its merge-base with the trunk, as CI) go through the ship checks and the quality ratchet; warnings print with their fix text; `githooks.prePush: "off"` disables it. |
| A PR opens | CI `rig-check`, `rig-review` | The base branch's checker re-judges; Opus reviews a prepared diff; human-approval check on approval rows. |
| A change merges to main | CI `rig-wiki` | Regenerates `docs/wiki/` (zero tokens) and, with a model secret, rewrites stale prose; opens one PR, never pushes to main. Two jobs: `generate` (requests a read-only token; the model step is the only one that runs the model, and is configured, not yet verified, to have no shell or network, see DESIGN §12) and `publish` (write token, no model step). `RIG_WIKI_TOKEN` is optional so required checks start on the PR. |
| A change ships | mod, weekly `learn.yml` | `/rig:learn` runs and toasts what is promotable. |

## Install

The harness lives in each repo it runs on, so a repo never depends on the plugin. You need the plugin only to initialise a repo and to upgrade it.

**Requirements:** Node 22.18 or later (the scripts run as plain TypeScript with no build step), `git`, a POSIX shell (the git hooks are `sh`) and Claude Code. macOS and Linux are supported; Windows is not (see Status). The GitHub CLI `gh` is used by `/rig:pr`, the PR metrics and the CI approval check, and is optional otherwise.

1. Install the plugin for yourself (once per machine):

   ```bash
   claude plugin marketplace add cwijayasundara/claude_code_harness_lite_v2
   claude plugin install rig@rig
   ```

   Or, for one session: `claude --plugin-dir /abs/path/to/claude_code_harness_lite_v2`.
2. In the repo, make a first commit if it has none, then run `/rig:init`. It writes a compact CLAUDE.md, `.sdlc/` (sensors, guides, the checker CI runs) and the code wiki, and copies the harness into the repo (`vendor --standalone`): skills to `.claude/skills/rig-*`, agents to `.claude/agents/rig-*`, hooks to `.claude/settings.json`, scripts to `.sdlc/bin`. It offers the CI check, the PR review workflow and [`templates/settings.json`](templates/settings.json) (Sonnet main thread, advisor off, Sonnet subagents).
   Run `node .sdlc/bin/sdlc.ts hooks install` (or let the first Claude Code session do it) to wire the git hooks; they cover editors and other agents. `--no-verify` still works for a person; CI is the floor. To opt out, run `node .sdlc/bin/sdlc.ts hooks uninstall`: it sets `rig.githooks = off`, so session start no longer wires them, until `hooks install`.
3. Commit `.sdlc/`, `.claude/` and `CLAUDE.md`. Anyone who clones the repo, and any cloud session, now runs the harness with no install. In the repo the commands are `/rig-start`, `/rig-next` and so on.

**Where things live.** Change artifacts, approvals, waivers and run records go in `.sdlc/`, not `.claude/`, for two reasons. Claude Code treats `.claude/` as protected, so writes there prompt and fail in headless runs. And these files are evidence the `rig-check` CI gate reads, so they are meant to be committed. Machine-local state (`.gate`, `.baseline`, `usage.jsonl`, `unresolved.json`) is already in `.sdlc/.gitignore`.

**Upgrade** by re-running `node <plugin>/scripts/sdlc.ts vendor --standalone` from a newer plugin and committing; `.sdlc/bin/VERSION` records the version in the repo. To keep a repo on the plugin instead (central upgrades, no copy), tell onboarding the team installs the plugin.

**With and without the plugin.** A standalone repo has everything that decides what may happen: skills, agents, hooks, sensors, gates and the CI check. `/rig-approve` and `/rig-waive` are skills only the person can invoke: the model cannot call them, and it cannot set `SDLC_HUMAN` itself. Installing the plugin as well adds the mod: the band, the `/rig-sensors` pane, the impact dialog, `/rig-status` with no model call, and per-stage cost capture for `/rig:metrics`. The plugin's own hooks step aside in a standalone repo, so none runs twice. The mod needs Claude Code 2.1.287 or later.

## Use

| You type | What happens |
|---|---|
| `/rig:start "add CSV export to reports"` | Classifies type and tier, writes `.sdlc/changes/<slug>/intent.md`, and prints the path and the next command. Tier S is built in the same turn. |
| `/rig:next` | Runs whatever comes next for the active change, and stops only at human gates. The one command to remember. |
| `/rig:design`, `/rig:spec`, `/rig:plan`, `/rig:build`, `/rig:diagnose`, `/rig:test`, `/rig:pr-review`, `/rig:pr` | One stage each (`ship` stays a CLI alias of `pr`). Every stage ends with the exact next command. |
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
| `/rig:learn` | Reads every shipped change, finds recurring review findings and waiver churn, and proposes harness edits, each replayed against past diffs. Zero tokens. A person promotes a passing rule with `/rig-approve <id> learn`. With the mod it also runs by itself when a change ships and toasts what is promotable; a weekly CI job covers repos without the mod. |
| `/rig-status` | Where every change stands. Zero tokens. |
| `/rig:incident "<what broke>"` | Maintain stage: records the incident and opens a bugfix-path change. |
| `/rig:wiki` | Builds or updates the code wiki in `docs/wiki/`: `sdlc.ts wiki build` regenerates the computed blocks (a module diagram from real imports, file, entry-point, dependency and test tables, a history) at zero tokens, and the agent writes only the plain-words prose. `wiki build --check` fails on drift of the structural blocks; `wiki status` lists `stale`, `missing`, `uncovered`, `generated`, `prose` and `invalid` (a broken manifest is reported, never a crash). |
| `/rig:ask "<question>"` | Answers from the wiki and the source lines it cites; `sdlc.ts wiki search "<terms>"` is the zero-token ranked search underneath. Wiki text is treated as untrusted data. |
| `/rig:metrics [days]` | The playbook's 12 metrics (leading and lagging per stage) plus cost per change, stage and agent. |

## Team install

1. Onboard as above and commit; teammates need nothing else. To upgrade a repo, run `claude plugin marketplace update rig`, re-run `vendor --standalone` and commit. Releases are tagged (`v0.3.7`), and CHANGELOG.md records what each one changed.
2. Builds use sdlc's own implementers. To run a tier L or greenfield build through superpowers subagent-driven development (6.4.1 or later), enable superpowers and set `"build": "sdd"` in `.sdlc/sensors.json`. It costs several times the tokens, so keep it for plans with many independent slices.
3. For the PR review, add a `CLAUDE_CODE_OAUTH_TOKEN` repository secret (your Pro/Max plan, from `claude setup-token`) or an `ANTHROPIC_API_KEY`, copy `templates/rig-review.yml`, and make `rig-check` and `rig-review` required checks with both workflows in CODEOWNERS.

4. Read [SECURITY.md](SECURITY.md) before rollout. The hooks are guardrails; the boundary is CI plus branch protection, code-owner review and managed settings. A PR that adds approval or waiver rows fails `rig-check` until someone other than its author approves the head commit.

**Opus advisor: off.** In the v0.3 trials an Opus advisor on the main thread was the largest single cost, about a third of each run. A user-level `advisorModel` still applies to every project, so the template turns the advisor off with `"env": { "CLAUDE_CODE_DISABLE_ADVISOR_TOOL": "true" }`. Remove that line to opt back in. Opus still writes tier L specs and plans (architect) and reviews.

**Gates by risk, not size.** Tier S has no human gate, and tier M has one (the design, approved once with the intent). Their build still reviews each slice in session (a bounded loop), then they walk test, sensors, pr and, when the PR review workflow is not installed, pr-review. Where the workflow is installed, the review of the PR runs there from `templates/rig-review.yml` (Opus with no shell or network, reading a prepared diff; a model-free step posts the comment after a credential check; fails only on a high-severity finding; needs a `CLAUDE_CODE_OAUTH_TOKEN` secret from `claude setup-token` for a Pro/Max plan, or an `ANTHROPIC_API_KEY`). Tier L, and anything touching auth, payments, data, security or a public contract, keeps the spec and plan gates and an in-session `/code-review` plus the plan-contract check. A diff over `limits.diffLines` blocks at ship unless the person approved its plan.

## Cloud sessions

Long builds belong in a Claude Code cloud session (claude.ai/code or `claude --cloud`). It keeps running while your laptop sleeps. In the Prism build, the laptop sleeping accounted for most of the 3 days. A standalone repo runs there as it is: `claude --cloud "/rig-next — continue through ship; commit on the branch"`. The result comes back as a pushed branch or PR, and `--teleport` brings the session back to your machine. Tier S changes have no gates, so they can run in the cloud from start to finish; tier M needs the one design approval first. For tier L, approve the spec and plan locally and push before the cloud build: `/rig-approve` has not been tried in a cloud session.

## Guides and sensors

Computational sensors run on the hot path at zero tokens; one inferential review runs per change. `sdlc.ts check` is the single entry point, so local equals CI.
- **Config** is `.sdlc/sensors.json`: `fast`/`full` commands, `tests`, `testSupport` (overlaid with the tests when proving against the base), `fixtures` (exempt from pattern sensors only; deletions stay tracked and adding a glob counts as weakening), `ignore`, `contracts`, `consumers`, `layers`, `limits`, `knownRed`, `githooks` (`{ prePush: "ship" | "off", budgetMs }`). `.sdlc/rules.json` holds regex rules.
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
| `skills/` (18) | The stages, run by the main thread (Sonnet 5.5; the Opus advisor is opt-in, see below). No skill sets `model:`, because a model switch re-reads the whole conversation uncached. Opus comes in through the architect and reviewer agents, which start with their own small contexts. |
| `agents/scout.md` | Haiku, read-only, `omitClaudeMd`. Cheap code search, used instead of Explore running on your main model. |
| `agents/architect.md` | **Opus 5.5**, high effort. Writes spec.md and plan.md, the design-heavy steps. |
| `agents/implementer.md` | **Sonnet 5.5**. The code generator: builds one slice test-first and reports real test output. |
| `agents/reviewer.md` | **Opus 5.5**, high effort. One independent review per change, keeping findings at confidence 80 or above. |
| `agents/verifier.md` | Sonnet 5.5. Runs the verification commands and writes the report. Never repairs. |
| `agents/wiki.md` | Writes the plain-words prose of one wiki page; scripts own the rest. |
| `hooks/hooks.json` | Settings hooks, which also hold in `-p` and CI. They inject session context, block model-made approvals, ask about edits outside the plan's `## Files`, and reject secrets or plans that contain code (exit 2). |
| `hooks/register.ts` | The mod. It records per-turn tokens and the dollar delta from the session ledger, shows the context and spend band, runs the zero-token commands and the context-budget nudges, and gives general-purpose subagents Sonnet by default. |
| `scripts/*.ts` (28, not counting specs and testkit) | Zero-dependency Node, no build step (the list names the main ones; the rest are `graph`, `wikigraph`, `wikigen`, `wikisearch`, `ratchet`, `levels`, `quality`, `autoapprove`, `pr`, `scorecard` and `vendor`): `core` (paths, change state, approvals), `model` (pure diff, config and glob model), `sensors` (the pure sensors), `diffs` (baselines and git diffs), `runs` (captured exit codes and verification reports), `check` (one `check` entry point for Stop, plan, ship and CI), `hooks` (hook decisions and the Stop gate), `metrics` (playbook metrics and cost), `wiki` (surface hash and stale pages), `sdlc` (the CLI), `shell` (bash-faithful tokenizer and the read-only Bash allowlist). |
| `guides/` | Short per-area guides (contracts, engineering, testing) injected when a matching file is touched. |
| `templates/rig-check.yml` | The required CI check, judged by the base branch's vendored checker. |
| `templates/rig-review.yml` | One background Claude review per PR, for tier S and M and as a second look on L. |
| `templates/rig-wiki.yml` | Refreshes the wiki through one pull request. Optional secrets: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (prose rewrite only), `RIG_WIKI_TOKEN` (so required checks start on the PR). Untested on GitHub so far. |

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
