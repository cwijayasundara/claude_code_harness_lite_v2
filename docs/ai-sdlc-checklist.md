# AI-Native SDLC — Implementation Checklist with Measurements

Source: *The AI-Native SDLC Playbook* (Louis Claxton, Anthropic), `docs/6aba736348bdf4f08183f463_AI Native SDLC Playbook_designv2 (1).pdf`.
Page references (`p.N`) use the page numbers printed in the playbook.

**How to read this checklist**

- Each play follows the playbook's own structure: **Prerequisites → Infrastructure → Execute → Governance → Measure**.
- `[ ]` items are things to put in place or verify. *Owner* names the role the playbook assigns.
- Items tagged **(proposed)** are **not in the playbook**. I added them where the playbook gives no metric or no verification step. Treat them as suggestions.
- The playbook states few numeric targets. The ones it does state are quoted as written. Any other target is marked *suggested*.

---

## 0. Cross-cutting foundations

### 0.1 The artifact chain (p.7–8)

Each stage ends by committing an artifact, and the next stage starts by reading it. Taken together, the chain is the audit trail.

| Stage | Artifact committed | Commit that triggers the next stage |
|---|---|---|
| Plan | `intent.md` | Product owner accepts (merges) intent → requirements & design pass |
| Design | `spec.md` (next to `intent.md`) | Approved spec → plan mode |
| Build | `plan.md`, the diff and its tests | — |
| Deploy | PR with review findings | Merged PR → pipeline |
| Maintain | Incident record / `lessons/*.md` | Control-band breach → new `intent.md` |

- [ ] Every stage commits its artifact to version control. No stage hands off through chat or email only.
- [ ] Each artifact is readable by both a human (product owner) and an agent.
- [ ] The commit chain shows who asked for what, what the agent produced, and who approved it (p.7).
- [ ] Humans stay accountable for every decision that needs judgment. Human attention moves to reviewing artifacts at the gates (p.7, p.9).
- [ ] Adoption path: prompt each step by hand first. Then automate until each accepted artifact fires the next gate (p.9).

### 0.2 Source of truth for legacy systems (sidebar, p.22)

- [ ] For **each** artifact type (work item, requirement, design, change approval), name exactly **one** system as the source of truth. Every other system holds a copy or a link.
- [ ] Choose a configuration per artifact:
  - [ ] **Repo as source of truth.** The markdown is authoritative, and the legacy system (Jira, ServiceNow, etc.) references files within commits. Records live in one tool with one timestamp authority.
  - [ ] **Legacy system as source of truth.** Markdown files are working copies. Claude reads the record at the start of the session and writes the outcome back through an MCP connector in the same session.
  - [ ] **Linkage as the minimum bar.** Every artifact notes the record ID, and every legacy record holds the commit SHA of the markdown file. This is the recommended starting point; it accepts two sources of truth.
- [ ] Confirm that auditors and regulators accept the chosen configuration, since they already accept the existing systems.
- [ ] **(proposed) Metric:** % of artifacts with bidirectional linkage (record ID in markdown, SHA in the legacy record).

### 0.3 Adoption order — play dependency graph (Figure 3, p.9)

**Entry points** need nothing first: **Capture intent**, **CLAUDE.md**, **Plan mode**, **Feedback loop**, **Hooks**.

| Play | Required before it (solid arrow in the graph) | Helps, not required (dotted arrow) |
|---|---|---|
| Capture intent | — (entry point) | — |
| CLAUDE.md | — (entry point) | — |
| Plan mode | — (entry point) | Requirements & design, CLAUDE.md |
| Feedback loop | — (entry point) | — |
| Hooks | — (entry point) | — |
| Requirements & design | Capture intent, Skills | — |
| Skills | CLAUDE.md *(the play text, p.25, says "None required; CLAUDE.md helps")* | — |
| Subagents | CLAUDE.md | Feedback loop |
| Evals | CLAUDE.md, Feedback loop | — |
| PR review | CLAUDE.md | Skills |
| CI/CD | PR review, Hooks | — |
| Closing the loop | Capture intent, PR review, CI/CD, Hooks | — |

- [ ] Start with at least one entry-point play.
- [ ] Before adopting any other play, confirm that every play with a solid arrow into it is in place.
- [ ] Stages are modular. Prioritize the stages that are the current bottleneck (usually plan, review/test, deploy — p.4).

---

## 1. Stage 1 — Plan: Capture as `intent.md` (p.11–13)

**Prerequisites:** None.
**Infrastructure**
- [ ] Non-engineers have Claude access (claude.ai or Cowork).
- [ ] An agreed `intent.md` template exists, ideally encoded as a **skill** that a technical member sets up and a lead signs off.
- [ ] A shared, version-controlled **intent home** exists that the product owner watches:
  - [ ] Single product → an `intent/` folder in the product repo.
  - [ ] Monorepo → a directory.
  - [ ] Intent spans many repos → a dedicated intent repo (only if worth the overhead).
- [ ] Platform or engineering team decides **who can write** to the intent home (one-time setup).
- [ ] A VCS connector (e.g. GitHub) lets Claude commit markdown for contributors without git skills.

**Execute**
- [ ] 1. The originator describes the problem in their own words: what they can't do today, who is affected, what better looks like, what is out of scope.
- [ ] 2. Brainstorm with Claude until the idea is concrete. Claude asks the analyst's questions: scope, users, constraints, success.
- [ ] 3. Claude writes `intent.md` from the org template: problem, proposed outcome, affected users and systems, constraints, open questions.
- [ ] 4. The originator corrects anything Claude misunderstood.
- [ ] 5. Commit to the intent home. Author and timestamp join the record, and the product owner picks it up.
- [ ] Intents from event triggers (tickets, alerts, agents) follow the same steps. **The product owner reviews and corrects every agent-written `intent.md` before commit.**

**Template check (from the p.13 example):** `# Intent: <title>`, Author + Status, `## Problem`, `## Proposed outcome`, `## Affected users and systems`, `## Constraints`, `## Open questions`.

**Governance (p.13)**
- [ ] Evidence: the committed `intent.md`, with author, timestamp, and full revision history in git.
- [ ] The product owner approves. Accept is recorded as the **merge**, reject as the **closed review**.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Time from first conversation to committed `intent.md` | git history of intent home | "from a multi-week elicitation and refinement cycle to **hours**" |
| Lagging | Survival rate: % of `intent.md` accepted into Design vs. closed | merges vs. closed reviews | Track trend |
| Lagging | # of changes to `intent.md` made after the first `spec.md` commit for the same change | git log | ↓ |

---

## 2. Stage 2 — Design: Requirements and design (p.15–17)

**Prerequisites**
- [ ] An accepted `intent.md`.
- [ ] Brand, security, compliance, and UX policies written as **skills**.

**Infrastructure**
- [ ] A product owner with Claude access. No engineering skill is required.
- [ ] For front-end work: the product owner mocks up in Claude Design (beta) from `intent.md`, iterates, and exports to Claude Code.

**Execute**
- [ ] 1. The product owner opens a session with the org skills loaded and attaches `intent.md`.
- [ ] 2. The prompt points at `intent.md`, names the constraints, and **demands flagged concerns** (see the p.16 prompt). Automate it in stages:
  - [ ] a. Run by hand.
  - [ ] b. Codify as an **organization-level slash command**.
  - [ ] c. Trigger on merge of `intent.md` in the intent home. A **non-interactive job** runs the pass with the org skills and commits `spec.md` as a **PR**. The product owner's first involvement is then the review.
- [ ] 3. The product owner reviews the spec against the idea. Does it solve the problem? Are the open questions answered or carried forward?
- [ ] 4. Resolve **flagged concerns first**, each with its named **policy owner**, before engineering sees the spec.
- [ ] 5. Commit `spec.md` next to `intent.md`. The pair records what was asked for and what was decided.
- [ ] 6. A **human** decides whether to progress to build. Consult a tech lead for anything classed as higher risk. Accepting the spec starts plan mode.
- [ ] The spec explicitly describes contradicting policies that cannot all be satisfied.

**Governance (p.17)**
- [ ] Policy is applied while the spec is written. Skills act as constraints.
- [ ] Logged in version control: the **spec**, the **prompt that produced it**, and the **skill versions in force**.
- [ ] The product owner signs off. Flagged concerns go to named policy owners.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Elapsed time from `intent.md` commit to `spec.md` commit (same change) | two git timestamps | ↓ vs. old requirements + design cycle |
| Lagging | Requirements rework: # `spec.md` commits dated **after** the first `plan.md` commit | `git log` | ↓ |

---

## 3. Stage 3 — Build

### 3.1 Plan mode as the default starting point (p.19–21)

**Prerequisites:** `intent.md` / `spec.md` if one exists. CLAUDE.md helps.
**Infrastructure:** Claude Code with repo access.

**Execute**
- [ ] 1. Start the session in **plan mode**.
- [ ] 2. Give Claude `intent.md` and `spec.md`. Ask for a plan that names **the files that change, the order of work, and the tests that prove it**.
- [ ] 3. Interrogate the plan: what could it break, which step is riskiest, which alternatives were rejected?
- [ ] 4. Iterate until an engineer who never saw the conversation could implement from the plan alone.
- [ ] 5. Commit the approved plan as **`plan.md`**. It joins the audit trail, and PR review checks the diff against it.
- [ ] 6. Accept the plan and let Claude implement, often in a single pass.
- [ ] 7. When implementation departs from the plan, update `plan.md` **in the same commit**. Consider a hook that enforces this sync.

**Template check (p.20 example):** `# Plan: <title> (from intent.md <date>)`, `## Files that change`, `## Order of work`, `## Risks`, `## Proof`.

**Governance (p.20)**
- [ ] Design review happens before code exists. Plan mode enforces it, because Claude can't edit until the plan is accepted.
- [ ] The plan, its revisions, and who accepted it are logged.
- [ ] Routine changes → the engineer approves. Higher-risk changes → a tech lead or architect approves.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | % of changes merged from the first implementation pass | PR metadata | ↑ |
| Leading | Time from plan approval to merged PR | PR metadata | ↓ |
| Lagging | Rework cycles per change | PR metadata | ↓ |
| Lagging | How often the merged diff still matches the committed `plan.md` | PR vs. `plan.md` | ↑ |

### 3.2 Auto mode (p.21)

- [ ] The engineer approves the plan, then Claude applies changes without a per-edit prompt.
- [ ] Auto-accept becomes the default for routine work **only when the guardrails have matured**:
  - [ ] a tuned CLAUDE.md
  - [ ] skills that encode policy
  - [ ] hooks that block unsafe actions
  - [ ] a test suite Claude can run
- [ ] Qualifying work has a tight `spec.md`, a small blast radius, and code that existing tests already cover.
- [ ] Review moves from watching edits to reviewing artifacts after longer autonomous sessions.
- [ ] Combine with worktrees to run work in parallel (see 3.6).
- [ ] **(proposed) Metric:** % of routine changes run in auto mode, alongside the post-merge defect rate for those changes.

### 3.3 CLAUDE.md (p.23–24)

**Prerequisites:** None. **Infrastructure:** a repo, Claude Code, and one engineer who knows the codebase well.

**Execute**
- [ ] 1. Run `/init` to generate a starting file.
- [ ] 2. Cut it to what a new joiner needs on day one: build, test, and lint commands, the conventions that matter, and the things Claude keeps getting wrong.
- [ ] 3. Check it into git at the **repo root**. Changes are reviewed like code.
- [ ] 4. **Rule: when Claude makes a mistake twice, the correction goes into CLAUDE.md.**
- [ ] 5. Keep it **under a page**. Remove stale content.

**Section check (p.24 example):** `## Commands`, `## Conventions`, `## Architecture`, `## Things Claude gets wrong` (+ `## Verifying your work`, see 4.1).

**Governance (p.24)**
- [ ] Version-controlled, reviewable, and auditable. **Code owners** approve changes in PR review.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | How often Claude repeats a mistake CLAUDE.md should have caught | corrections tracked in CLAUDE.md git history | ↓ |
| Lagging | Time to first merged PR for a new team member | PR history | ↓ |

### 3.4 Skills as institutional knowledge (p.25–26)

**Rule of thumb:** write a skill for institutional knowledge that must be applied consistently. Don't write one for content that belongs in CLAUDE.md or a prompt.
**Prerequisites:** None required (CLAUDE.md helps). **Infrastructure:** one policy with a **named owner** and a **written source of truth**.

**Execute**
- [ ] 1. Pick one piece of knowledge that is enforced inconsistently today (a security standard, an API convention, a brand rule).
- [ ] 2. Write it as a skill: a folder with `SKILL.md`, whose frontmatter says **when it triggers** and whose body says **what to do**. An engineer writes it from the policy owner's source.
- [ ] 3. Place it in `.claude/skills/<name>/` (ships with the code) **or** distribute org-wide through a **plugin**.
- [ ] 4. **Test triggering.** Ask for the task several different ways and confirm the skill loads each time.
- [ ] 5. When the policy changes, update the skill. The **policy owner signs off**.
- [ ] 6. Engineers pick up the new version automatically in their next session.
- [ ] Where useful, the skill runs a deterministic script and includes its output in the summary (e.g. `scripts/check-endpoints.sh`, p.26).

**Governance (p.26)**
- [ ] A skill is an **advisory** control. Every policy that must always hold also has a **deterministic** backstop: a hook that blocks the action, or a PR review pass that re-checks it.
- [ ] Skill invocations are logged in session traces. The policy owner reviews skill changes like code.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Time from the policy owner approving a change to the updated skill merging | PR on the skill folder | ↓ |
| Lagging | PR review findings that cite the policy | PR review findings | "fall **towards zero**". If not, the skill isn't triggering or has drifted from policy |

### 3.5 Hooks as build-time guardrails (p.27)

- [ ] Hooks back every skill whose policy must hold without exception.
- [ ] Build-phase hooks:
  - [ ] Block edits to protected paths (generated classes, frozen packages).
  - [ ] Run the formatter and linter after file edits.
  - [ ] Keep credentials out of the diff.
  - [ ] Block edits to migrations and infra without a change ticket (p.40).
- [ ] Hooks are **fast and scoped to the changed file**. Heavy checks (full test suite) run at commit or PR.
- [ ] **No human-approval ("ask") hooks during build.** They belong to the Stage 5 gates, because they put a person on the critical path of every parallel session.
- [ ] **(proposed) Metrics:** hook block count per rule per week; median hook latency (target: suggested < 1–2 s); protected-path violations found in PRs (↓ to zero).

### 3.6 Parallel sessions and subagents (p.27–29)

**Prerequisites:** CLAUDE.md. The feedback loop (Stage 4) helps.
**Infrastructure**
- [ ] A git repository (isolation comes from **worktrees**).
- [ ] Permission settings tuned so sessions don't wait on prompts for commands the org considers safe.

**Execute**
- [ ] 1. Split work into tasks that touch **different files**, using `plan.md` to see independence. Tasks that share files run in one session, sequentially.
- [ ] 2. One worktree per parallel task, e.g. `claude --worktree feature-auth` and `claude --worktree fix-rate-limit`.
- [ ] 3. Start with **2–3 sessions**. Add more only while review keeps up. The ceiling is what one person can review properly.
- [ ] 4. Turn repeated jobs into **subagents** in `.claude/agents/` (name, when-to-use description, allowed tools). Check them into git. Examples:
  - [ ] code simplifier
  - [ ] **verifier**: runs the app, exercises the change and the two nearest neighboring flows, reports mismatches against `plan.md`, **report only, no fixes** (p.29)
  - [ ] researcher: explores the codebase without flooding the main context

**Governance (p.29)**
- [ ] Controls come from **repo configuration**. Hooks and permission settings apply to all sessions.
- [ ] Session activity is logged and attributed to the engineer who ran it.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Concurrent sessions per engineer while review quality holds | OpenTelemetry export | ↑ without quality loss |
| Leading | Share of the day spent steering vs. waiting | OpenTelemetry / self-report | ↑ steering |
| Lagging | Changes merged per engineer per week, **read alongside rework rate** | PR history | ↑ merged, rework flat or ↓ |

---

## 4. Stage 4 — Test

### 4.1 Give Claude a feedback loop (p.31–33)

The feedback loop runs throughout the task. The **verifier subagent** is a separate, one-time final check in a fresh context.

**Prerequisites:** None.
**Infrastructure**
- [ ] A test suite and a build, each runnable locally **with one command**.
- [ ] For UI: a browser tool or screenshot utility wired in via MCP.

**Execute**
- [ ] 1. Wrap multi-step checks in a single target (`make test`, `npm test`) that **exits non-zero on failure**.
- [ ] 2. List each command in CLAUDE.md `## Commands` **with an example of healthy output**.
- [ ] 3. State a **quantifiable target** per task (e.g. "all tests in `test_status.py` pass", "the screenshot matches the mock", "the endpoint returns 200 with the new field").
- [ ] 4. **Bug fixes: test first.** Reproduce the bug as a test, confirm it fails for the expected reason, and **commit the test**. Then make it pass **without editing the test**.
- [ ] 5. UI: visual loop (implement → screenshot → compare → adjust). 2–3 rounds is normal.
- [ ] 6. Verification is part of "done". CLAUDE.md tells Claude to run the tests before reporting complete and to **paste the output**.
- [ ] 7. **Protect the loop.** A hook blocks edits to test files during fix tasks, *or* review rejects any fix diff that touches a test.

**CLAUDE.md verification block check (p.33):** Build (`"Build succeeded"`), Test (all green, never skip or delete failing tests), Lint (zero warnings). Run all three and paste the output. "If a test fails, fix the code, not the test."

**Governance (p.33)**
- [ ] Enforced: verification before "done", and the test-edit block during fixes (as hooks where guaranteed behavior is needed).
- [ ] Evidence: literal toolchain output (`make test`, the build log, the screenshot diff).
- [ ] Logged: the session transcript goes to observability via OpenTelemetry, plus the **PR check run**.
- [ ] Approver: the **code owner**, who focuses on intent and risk.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | First-pass CI success rate for agent-written changes | CI system | ↑ |
| Lagging | Review time per PR | PR metadata | ↓ |
| Lagging | Change failure rate | incident tracker | ↓ |

### 4.2 Continuous evals in CI (p.34–35)

Evals are the AI-native version of stage-gate QA. They regression-test the **agent configuration** (CLAUDE.md, skills, hooks, prompts, model swaps). The suite is live: retire cases that stop discriminating and add new ones from monitoring. It can also run offline on a cadence instead of on every change.

**Prerequisites:** CLAUDE.md and the feedback loop.
**Infrastructure**
- [ ] CI that can run Claude Code non-interactively (`claude -p`).
- [ ] An API key **with budget** for eval runs.

**Execute**
- [ ] 1. The platform engineer collects **20–50 real tasks** from recent work, each with its expected or accepted outcome.
- [ ] 2. Write each as an eval: **prompt + checks** (tests pass, lint clean, behavior unchanged, policy followed).
- [ ] 3. Run non-interactively in CI **on a schedule** *and* **on any change to CLAUDE.md, skills, or hooks**.
- [ ] 4. **Gate configuration changes on results.** A change that drops the pass rate is reviewed before merge.
- [ ] 5. **Every production incident gets an eval**, written by the owning team and kept as a regression test.

**Workflow check (`.github/workflows/agent-evals.yml`, p.35)**
- [ ] Triggers: `pull_request` on paths `['CLAUDE.md', '.claude/**']` and `schedule` (e.g. `cron: '0 2 * * *'`).
- [ ] Installs `@anthropic-ai/claude-code`. `ANTHROPIC_API_KEY` comes from secrets.
- [ ] Loops over `evals/*.json` and runs `claude -p` with a **restricted `--allowedTools`** (e.g. `"Read,Edit,Bash(make test)"`) and `--output-format json`.
- [ ] A checker script (`./evals/check.sh`) scores each result.

**Governance (p.35)**
- [ ] The pass-rate threshold is enforced as a **merge check**.
- [ ] Runs are logged for comparison over time.
- [ ] The team that owns the configuration change approves it.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Eval pass rate over time | suite output per run | stable or ↑ |
| Leading | Time for a production incident to become a permanent eval | incident tracker + eval repo | ↓ |
| Lagging | Regressions caught in CI vs. found in production | CI + incident tracker | ratio ↑ |

---

## 5. Stage 5 — Deploy

### 5.1 AI in the PR review loop (p.37–39)

**Prerequisites:** an updated CLAUDE.md, skills (if review enforces written policy), and defined subagents.
**Infrastructure**
- [ ] **Either** the managed Code Review service (research preview), enabled by an admin for selected repos, **or** `claude-code-action` in your own CI.
- [ ] Model calls through Bedrock, Vertex, or Foundry where required.
- [ ] **Branch protection that requires code-owner approval.**

**Execute**
- [ ] 1. Fastest start: the managed service. Use `claude-code-action` when you need pipeline control or your own cloud agreement.
- [ ] 2. The tech lead writes **`REVIEW.md`** at the repo root, with passes for **bugs/logic**, **security/vulnerabilities**, and **compliance against `spec.md`, `plan.md`, and design principles**. It also defines Important vs. Nit and what to skip.
- [ ] 3. The tech lead sets the human threshold. **Findings never approve or block on their own**, and branch protection still requires a code owner. A platform engineer can optionally gate on the machine-readable severity counts from the check run.
- [ ] 4. **Fix loop:** tag `@claude` on a review comment and Claude pushes the fix (claude-code-action). In the managed service, `@claude review` requests a fresh review.
  - [ ] For PRs Claude opened: a custom slash command "babysits" the PR. It sweeps unresolved comments and failing checks and pushes fixes until the PR is green and waiting only on code-owner approval.
- [ ] 5. **Findings feed back into CLAUDE.md.** A mistake flagged a second time goes into CLAUDE.md in that review. Review also flags when a change makes CLAUDE.md outdated.
- [ ] 6. **Monthly tuning** by the tech lead: rate findings, cap Nit volume, and exclude generated paths and anything CI already enforces.

**REVIEW.md check (p.39):** `## Passes` (Bugs / Security / Compliance, each finding tagged with its pass), `## What Important means here` (breaks behavior, leaks data, or breaches policy; style and naming are nits), `## Cap the nits` (**at most 5 nits** per review, the rest as a count), `## Do not report` (generated files such as `src/gen/`, anything CI enforces).

**Governance (p.39)**
- [ ] **Separation of duties:** the agent that wrote the code cannot approve it.
- [ ] `REVIEW.md` applies to all PRs. Findings, fixes, ratings, and approvals are logged in PR history, so the PR is the audit record.
- [ ] Approval comes from a human through branch protection.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Time to first review | PR metadata / Git | "should fall to **minutes**" |
| Leading | % of review comments resolved without a human touching the branch | Git | ↑ |
| Lagging | Defects and vulnerabilities caught before merge vs. escaped to production | PR history + incident tracker | ratio ↑ |

### 5.2 Hooks as approval gates (p.40–41, 44)

Hooks can **allow, ask, or block**. They apply wherever Claude acts, not only at deploy.

**Prerequisites:** None. **Infrastructure:** a **written list of the approvals** the change process requires.

**Execute**
- [ ] 1. Engineering leadership, change management, and compliance list the human approval gates that must survive (change-management sign-off, release authorization, protected-path edits).
- [ ] 2. The platform engineer expresses each gate as a **hook** (a script run before Claude acts: allow / ask / block).
- [ ] 3. Team hooks go in `.claude/settings.json` in git. **Non-negotiable hooks go in managed settings** owned by the platform or IT admin, which engineers can't disable.
- [ ] 4. **Blocks explain themselves.** The reason and the route to approval appear in Claude's output.

**Example check (p.41)**
- [ ] `PreToolUse` hook with `matcher: "Bash"` → `${CLAUDE_PROJECT_DIR}/.claude/hooks/production-gate.sh`.
- [ ] The gate script reads `.tool_input.command` from stdin. If the command contains `deploy` **and** `production` and `$RELEASE_APPROVAL` is empty, it prints the reason to stderr and **`exit 2`** (block, message goes to Claude). Otherwise `exit 0`.

**Governance (p.41)**
- [ ] Gate conditions are enforced every time, for everyone.
- [ ] Allow and block decisions are logged with timestamps.
- [ ] The gate defines what counts as approval (an approved change ticket, the release manager's sign-off).

**Measure (p.44)**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Time spent waiting on each approval gate | OpenTelemetry export (every hook decision, timestamp + allow/block) | ↓ per gate |
| Lagging | Gate violations reaching production, before vs. after hooks | incident tracker | ↓ |

### 5.3 Worked example — managed settings for a regulated enterprise (p.42–43)

**Deployment**
- [ ] The platform team deploys via **MDM or the admin console**. Engineers **cannot edit or override** any of it.
- [ ] Treat it as **a starting point to tailor, not a recommendation to copy**. Every deny trades away capability, and the right balance depends on the repo's **data classification**. Reference: `code.claude.com/docs/en/settings`.

**Reference JSON (verbatim from p.42)**

```json
{
  "permissions": {
     "deny": [
        "Read(.env*)", "Read(./secrets/**)",
        "WebFetch", "Bash(curl *)", "Bash(wget *)"
     ],
     "allow": [
        "Bash(git *)", "Bash(make build)",
        "Bash(make test)", "Bash(make lint)"
     ],
     "disableBypassPermissionsMode": "disable"
  },
  "allowManagedPermissionRulesOnly": true,
  "sandbox": {
     "enabled": true,
     "failIfUnavailable": true,
     "allowUnsandboxedCommands": false,
     "network": { "allowedDomains": ["git.internal.example.com",
"registry.npmjs.org"] },
     "credentials": {
        "files": [
          { "path": "~/.ssh", "mode": "deny" },
          { "path": "~/.aws/credentials", "mode": "deny" }
        ],
        "envVars": [ { "name": "GITHUB_TOKEN", "mode": "deny" } ]
     }
  },
  "allowManagedHooksOnly": true,
  "disableSideloadFlags": true,
  "allowManagedMcpServersOnly": true,
  "strictKnownMarketplaces": [
     { "source": "github", "repo": "example-corp/approved-plugins" }
  ],
  "requiredMinimumVersion": "2.1.193"
}
```

**Line-by-line checklist.** Columns 1–2 come from p.42–43. The verification column is **(proposed)**.

| ✓ | Setting | Control it buys (p.43) | How to verify it works **(proposed)** |
|---|---|---|---|
| [ ] | `permissions.deny`: `Read(.env*)`, `Read(./secrets/**)` | Keeps secrets out of the agent's context | Ask Claude to read `.env` → denied |
| [ ] | `permissions.deny`: `WebFetch`, `Bash(curl *)`, `Bash(wget *)` | Blocks arbitrary network egress through tools | Ask for a WebFetch / `curl` → denied |
| [ ] | `permissions.allow`: `Bash(git *)`, `make build/test/lint` | Pre-approves the safe inner loop, so the deny list doesn't cause **prompt fatigue** | `make test` runs with no prompt |
| [ ] | `permissions.disableBypassPermissionsMode: "disable"` | Bypass mode cannot widen the rules | Launch with bypass mode → refused |
| [ ] | `allowManagedPermissionRulesOnly: true` | No engineer, project file, or CLI flag can widen the rules | Add an allow rule in project `.claude/settings.json` → ignored |
| [ ] | `sandbox.enabled: true` | Closes the gap permissions can't. A WebFetch deny doesn't stop a shell command reaching the network; the **OS-level domain allowlist** blocks egress outright | Shell command to a non-allowlisted host fails |
| [ ] | `sandbox.network.allowedDomains` (`git.internal.example.com`, `registry.npmjs.org`) | Egress only to approved hosts | `git fetch` / `npm install` work; other hosts fail |
| [ ] | `sandbox.failIfUnavailable: true` | Claude Code **refuses to start** if the sandbox can't initialize | Start on a host without sandbox support → refuses |
| [ ] | `sandbox.allowUnsandboxedCommands: false` | A command that fails inside the sandbox **cannot be retried outside it** | Force a sandbox failure → no unsandboxed retry offered |
| [ ] | `sandbox.credentials.files` (`~/.ssh`, `~/.aws/credentials` deny) | Closes the gap deny rules leave: `permissions.deny` covers Claude's file tools, but a sandboxed shell could otherwise read these | `cat ~/.ssh/id_*` in a sandboxed command → denied |
| [ ] | `sandbox.credentials.envVars` (`GITHUB_TOKEN` deny) | Strips named secrets from the environment of every sandboxed command | `echo $GITHUB_TOKEN` → empty |
| [ ] | `allowManagedHooksOnly: true` | Approval-gate hooks are the **only** hooks that run. Nothing local adds to or replaces them | Add a local hook → it doesn't fire |
| [ ] | `disableSideloadFlags: true` | No skills, agents, hooks, or MCP servers sideloaded from a home directory or flags | Sideload attempt → rejected |
| [ ] | `strictKnownMarketplaces` (`example-corp/approved-plugins`) | Everything arrives through the **approved plugin marketplace** | Install from another marketplace → rejected |
| [ ] | `allowManagedMcpServersOnly: true` | The agent's tool surface is an **allowlist owned by the platform team** | Add a project `.mcp.json` server → not loaded |
| [ ] | `requiredMinimumVersion: "2.1.193"` | Refuses to start below the approved floor, so controls run on an **assessed build** | Run an older version → refuses |

**Tailoring checklist**
- [ ] Classify each repo's data. Decide where its deny list sits on the capability ↔ control trade-off.
- [ ] Replace the example domains, marketplace repo, credential paths, env vars, and version floor with your own.
- [ ] Extend `permissions.allow` with your real build, test, and lint commands to avoid prompt fatigue.
- [ ] Re-check every key against the settings reference (managed-only keys documented there).
- [ ] **(proposed)** Run the verification column as an automated smoke test after each managed-settings change and each Claude Code version-floor bump.
- [ ] **(proposed) Metrics:** % of developer machines that report the managed policy (fleet coverage, target 100%); # sandbox or permission denials per week (spikes show tuning needs or attempted bypass); approval-prompt count per session (↓ = less prompt fatigue).

### 5.4 CI/CD integration and deployment (p.44–46)

Run Claude Code non-interactively inside CI/CD, sandbox execution, expose deployment through MCP, and rehearse rollback before the agent ever needs it.

**Prerequisites:** **PR review loop** and **hooks as approval gates**. The gates must exist before automation accelerates anything through them.
**Infrastructure**
- [ ] A CI platform with `claude-code-action`, **or** any runner that can call `claude -p`.
- [ ] Model access via the API, or **Bedrock, Foundry, or Vertex** where traffic must stay on the org's cloud agreement.
- [ ] **MCP servers for the deployment targets.**
- [ ] A **sandbox profile** for agent jobs with **no standing production credentials**.

**Execute**
- [ ] 1. **Read-only judgment steps first:** `claude -p` to triage a failed build, summarize a flaky test, draft the changelog.
- [ ] 2. **Write steps behind existing gates:** fix lint, update generated docs, address `@claude` review comments. Everything arrives as a **PR through branch protection**, and the agent **has no route to push to main**.
- [ ] 3. **Sandbox execution:** containers, a network policy, **short-lived scoped tokens**, and no production credentials by default.
- [ ] 4. **Deployment through MCP:** deploy, status, and rollback become **tools scoped per environment**, an allowlist rather than a shell script with credentials.
- [ ] 5. **Tier autonomy by environment:**
  - [ ] Dev: the agent deploys freely.
  - [ ] Staging: in between (define explicitly).
  - [ ] Production: the agent **prepares** the release, the **release manager authorizes** it, and a **hook enforces** the gate.
- [ ] 6. **Rollback is the most rehearsed path:** a single command the agent can run, **exercised regularly in staging**. Stage 6 depends on it, so prove it in advance.

**Pipeline step check (p.45):** an `if: failure()` step runs `claude -p` to read `out/build.log`, identify the likely cause, classify **flaky vs. real**, and write a **three-line summary** for the PR thread (`>> triage.md`).

**Other CI/CD touchpoints elsewhere in the playbook**
- [ ] Non-interactive spec job fires on `intent.md` merge and opens `spec.md` as a PR (p.16).
- [ ] Agent evals workflow on config change and nightly (p.35, see 4.2).
- [ ] `claude-code-action` review and `@claude` fix loop (p.38, see 5.1).
- [ ] Scheduled or webhook trigger for the closing-the-loop detector (p.50, see 6.1).

**Governance (p.46).** Principle: **the agent may act up to the production gate and cannot pass it.**
- [ ] Branch protection turns all agent writes into PRs, with no direct path to main.
- [ ] The production deploy hook blocks release until a **named release manager** authorizes it.
- [ ] Every non-interactive run acts under the **agent's own identity**, so pipeline logs separate agent actions from those of the engineer who triggered the run.
- [ ] Per-environment permission tiers bound what the agent may do before the gate.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | % of pipeline failures triaged without paging a human | CI/CD pipeline logs | ↑ |
| Lagging | **DORA**: deployment frequency, lead time for changes, change failure rate, time to restore service | CI system + deployment tooling | freq ↑, lead time ↓, CFR ↓, restore time ↓ |
| **(proposed)** | Rollback rehearsal frequency in staging, and rollback success rate | pipeline logs | suggested ≥ weekly; 100% success |
| **(proposed)** | # agent pushes to protected branches | Git audit log | **0** |

---

## 6. Stage 6 — Maintain

### 6.1 Maintenance and closing the loop (p.48–51)

A trigger invokes Claude with no person in the invocation path. Findings re-enter the pipeline as `intent.md`. Headless runs pass through an **independent confidence gate** between stages: a deterministic check **or** an adversarial reviewing agent decides whether to continue or escalate to a human.

**Prerequisites:** `intent.md` (structured output), accelerated PR reviews, hooks as the action boundary, and a **CI/CD rollback path** (used by the highest tier).
**Infrastructure**
- [ ] A metrics store the detector can query (Prometheus, the CI system's API, or equivalent).
- [ ] Read access to the repo.
- [ ] Non-interactive Claude Code in CI, **or** an Agent SDK service that receives webhooks.

**Execute**
- [ ] 1. The service owner or platform engineer picks **one metric with a stable rolling baseline** (CI test failure rate, post-deploy 5xx rate, PR cycle time).
- [ ] 2. Write the **detection script**: mean and standard deviation over a rolling window, with Western Electric (or similar) rules to catch **slow drift and spikes**. It is **version-controlled and unit-tested**, and **detection is entirely deterministic, with no model involved**.
- [ ] 3. Define **response tiers** in version-controlled config (`bands.yaml`):
  - [ ] **1σ → log only**
  - [ ] **2σ → Claude read-only diagnosis**
  - [ ] **3σ → Claude may act, but only by opening a PR into the review gate or triggering a pre-approved runbook**
- [ ] 4. Trigger layer: a scheduled GitHub/GitLab workflow, a monitoring webhook, or an in-network cron job. Claude runs **stateless**: a non-interactive CI step or an Agent SDK service in a sandboxed container.
- [ ] 5. The agent writes its diagnosis as **`intent.md` in the Stage 1 format**: anomaly + evidence, proposed outcome, affected systems, open questions.
- [ ] 6. The service owner or on-call engineer **triages the queue**: fix now / schedule / dismiss. Product-facing findings go to the product owner. **Dismissals tune the bands** to reduce noise.
- [ ] 7. When a fix ships, **add an eval** for the incident (see 4.2).

**`bands.yaml` check (p.50)**
```yaml
metric: ci_test_failure_rate
baseline: rolling_30d
rules: western_electric
tiers:
  1sigma: { action: log }
  2sigma: { action: diagnose,
            tools: "Read,Grep,Bash(gh run view *)" }
  3sigma: { action: propose,
            routes: [pull_request, runbook:rollback-deploy] }
```
- [ ] The 2σ tool list is read-only.
- [ ] 3σ routes are limited to `pull_request` and named, **pre-approved** runbooks.

**Example scenarios to implement and test (p.51)**
- [ ] CI test failure rate > 3σ → the agent **quarantines the flaky test or opens a revert PR**, and the review gate decides.
- [ ] Post-deploy 5xx rate > 3σ **with a deployment in the window** → the agent triggers the **existing rollback pipeline**.
- [ ] PR cycle time trips a drift rule → the agent writes a **report for engineering leadership** (process metrics, not only production metrics).

**Governance (p.50)**
- [ ] Tier boundaries are enforced from version-controlled config. Permissions and managed settings **deny production access**.
- [ ] Invocations, findings, and triage decisions are logged with timestamps.
- [ ] The service owner triages and approves. Resulting changes go through the **normal PR review gate**. Runbooks the agent may trigger are **approved in advance**.

**Measure**

| Type | Metric | Data source | Target / direction |
|---|---|---|---|
| Leading | Time from band breach to `intent.md` in the triage queue, vs. the old incident → post-mortem-action time | detection script log (breach timestamp + tier) | ↓ |
| Lagging | % of findings that become merged fixes | triage queue vs. PR history | ↑ |
| Lagging | Repeat incidents of the same class | incident tracker | ↓ (as fixes add eval cases) |
| **(proposed)** | Dismissal rate per band (noise) | triage log | ↓ after tuning |

### 6.2 Claude on call with Claude Tag (p.52)

- [ ] Claude Tag (public beta, Slack) is a **member of incident channels under its own identity**, as first responder.
- [ ] Anyone in the channel can guide the response, test hypotheses, and investigate. **Channel history is the audit trail**: request, diagnosis, human authorization, fix.
- [ ] **Destructive actions (e.g. rollback) wait for explicit human authorization in-thread.** In the p.52 example Claude asks "shall I run it?" and acts only after "Go."
- [ ] Prefer **rehearsed** remediations. The example rollback was rehearsed in staging that morning.
- [ ] Through MCP, Claude **verifies the metric is back at baseline** (inside its band) and confirms in the thread.
- [ ] The post-mortem is written to a **version-controlled lessons file** (e.g. `lessons/2026-06-checkout-cache.md`) that future investigations read.
- [ ] Tickets (tagged over MCP or asked in channel) are triaged the same way:
  - [ ] Small, well-bounded fix → **PR through the review gate**.
  - [ ] Larger work → **`intent.md`** for Stage 1, so the loop feeds itself.
- [ ] **(proposed) Metrics:** time from channel tag to first diagnosis (the example shows ~3 min); time to restore (feeds DORA); % of incidents with a lessons file committed; % of incidents that produce a new eval.

---

## 7. Consolidated measurement scorecard

Every leading and lagging indicator in the playbook, in one place. Most come from systems you already run (p.13–51).

| # | Play | Leading indicator | Lagging indicator | Data source(s) | Stated target / direction |
|---|---|---|---|---|---|
| 1 | Capture intent | First conversation → committed `intent.md` | Survival rate of intents; # `intent.md` edits after first `spec.md` | git history (intent home) | weeks → **hours**; edits ↓ |
| 2 | Requirements & design | `intent.md` commit → `spec.md` commit | # `spec.md` commits after first `plan.md` | git log | ↓ ; ↓ |
| 3 | Plan mode | % merged from first pass; plan approval → merged PR | Rework cycles per change; diff ↔ `plan.md` match rate | PR metadata | ↑, ↓ ; ↓, ↑ |
| 4 | CLAUDE.md | Repeat-mistake frequency | Time to first merged PR (new joiner) | CLAUDE.md git history; PR history | ↓ ; ↓ |
| 5 | Skills | Policy approval → skill merged | PR findings citing the policy | skill-folder PRs; PR reviews | ↓ ; → **zero** |
| 6 | Parallel sessions / subagents | Concurrent sessions per engineer (quality held); steering vs. waiting | Changes merged / engineer / week + rework rate | OpenTelemetry; PR history | ↑ ; ↑ with rework flat |
| 7 | Feedback loop | First-pass CI success (agent changes) | Review time per PR; change failure rate | CI; PR metadata; incident tracker | ↑ ; ↓, ↓ |
| 8 | Continuous evals | Eval pass rate over time; incident → eval time | Regressions caught in CI vs. in prod | eval suite; incident tracker | stable/↑, ↓ ; ↑ |
| 9 | PR review | Time to first review; % comments resolved without human touch | Defects/vulns pre-merge vs. escaped | Git / PR history; incident tracker | → **minutes**, ↑ ; ↑ |
| 10 | Hooks (approval gates) | Wait time per gate | Gate violations in prod, before vs. after | OpenTelemetry (hook decisions); incident tracker | ↓ ; ↓ |
| 11 | CI/CD | % pipeline failures triaged without paging | **DORA** metrics | CI/CD logs; deploy tooling | ↑ ; DORA improving |
| 12 | Closing the loop | Band breach → `intent.md` in triage | % findings → merged fixes; repeat incidents | detection log; triage queue; PR history; incident tracker | ↓ ; ↑, ↓ |
| — | Auto mode **(proposed)** | % routine changes in auto mode | Post-merge defect rate of auto-mode changes | OTel; incident tracker | ↑ ; flat/↓ |
| — | Build-time hooks **(proposed)** | Hook latency; blocks per rule | Protected-path violations in PRs | OTel; PR review | fast ; → 0 |
| — | Managed settings **(proposed)** | Fleet policy coverage; denials/week | Secret or egress incidents | MDM/admin console; OTel; incident tracker | 100% ; → 0 |
| — | Claude Tag **(proposed)** | Tag → first diagnosis | Lessons-file + eval coverage per incident | Slack history; repo | ↓ ; ↑ |
| — | Source of truth **(proposed)** | % artifacts with bidirectional linkage | Audit findings on traceability gaps | repo + legacy system | ↑ ; → 0 |

**Telemetry prerequisites for the scorecard**
- [ ] OpenTelemetry export from Claude Code enabled and forwarded to the observability stack (sessions, hook decisions, skill invocations).
- [ ] Artifacts for the same change linked by a shared identifier (folder, slug, or record ID), so git timestamps can be paired (intent → spec → plan → PR).
- [ ] PR metadata captures plan approval time, first-pass merge, and rework cycles.
- [ ] An incident tracker records change failure, escaped defects, repeat-incident class, and gate violations.
- [ ] Detection script logs breach timestamp and tier.
- [ ] **(proposed)** Capture a baseline for every metric **before** adopting each play, so "before vs. after" comparisons are possible.

---

## 8. Platform rollout checklist (Resources, p.54, in suggested roll-out order)

- [ ] Admin setup / decision map — `code.claude.com/docs/en/admin-setup`
- [ ] Settings reference and precedence, incl. managed-only keys — `code.claude.com/docs/en/settings`
- [ ] Server-managed settings from the admin console — `code.claude.com/docs/en/server-managed-settings`
- [ ] Permissions — `code.claude.com/docs/en/permissions`
- [ ] Sandboxing (OS-level filesystem and network isolation) — `code.claude.com/docs/en/sandboxing`
- [ ] Hooks guide and reference — `code.claude.com/docs/en/hooks-guide`, `code.claude.com/docs/en/hooks`
- [ ] Skills — `code.claude.com/docs/en/skills`
- [ ] Plugins and private marketplaces (org-wide distribution of skills and hooks) — `code.claude.com/docs/en/plugin-marketplaces`
- [ ] Managed MCP (central control of the tool surface) — `code.claude.com/docs/en/managed-mcp`
- [ ] Enterprise deployment via Bedrock / Vertex / Foundry — `code.claude.com/docs/en/third-party-integrations`
- [ ] Enterprise network configuration — `code.claude.com/docs/en/network-config`
- [ ] Monitoring (OpenTelemetry) — `code.claude.com/docs/en/monitoring-usage`
- [ ] Analytics dashboard — `code.claude.com/docs/en/analytics`
- [ ] Compliance API (activity feed, chat retrieval and deletion) — `platform.claude.com/docs/en/manage-claude/compliance-api`
- [ ] Security model — `code.claude.com/docs/en/security`

---

## 9. One-page "are we AI-native yet?" summary

- [ ] Ideas land as committed `intent.md` within hours, reviewed by a product owner.
- [ ] `spec.md` is generated with org skills loaded and concerns flagged, and a human accepts it.
- [ ] No code without an accepted, committed `plan.md`. The diff is checked against it.
- [ ] CLAUDE.md is under a page, in git, and updated whenever a mistake repeats.
- [ ] Every must-hold policy has a skill (advisory) **and** a hook or review pass (deterministic).
- [ ] Every session verifies its own work. Test files can't be edited during fixes.
- [ ] An eval suite (20–50+ tasks) gates every CLAUDE.md, skill, or hook change, and every incident adds an eval.
- [ ] Every PR gets the AI review passes from `REVIEW.md`. A human code owner still approves.
- [ ] Approval gates are hooks. Non-negotiable ones live in managed settings that engineers cannot override.
- [ ] Managed settings lock permissions, sandbox, credentials, hooks, MCP, marketplace, and version floor (p.42–43).
- [ ] The agent works through CI/CD up to the production gate and cannot pass it. Rollback is rehearsed.
- [ ] Deterministic band detection triggers Claude, whose findings return as `intent.md`. Claude Tag handles channel incidents.
- [ ] Every metric in §7 has a baseline and is trending the right way.
