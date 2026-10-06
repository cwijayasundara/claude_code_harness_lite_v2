---
name: init
description: One-time setup of a repo for the sdlc harness. Brownfield writes a compact CLAUDE.md from a cheap parallel scout sweep; greenfield scaffolds a walking skeleton with test and lint commands. Never rerun per task.
argument-hint: '[--defaults] [greenfield "<stack and goal>"]'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Initialise this repo

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts init` first.

## `--defaults` mode
When the arguments contain `--defaults`, the person has pre-approved every recommended answer below, so ask no AskUserQuestion at all. Use these answers:
- Greenfield: stack, deployment target and test framework come from the quoted goal; anything it leaves out takes the recommended default (deployment: local only).
- **Sensors:** write `.sdlc/sensors.json` with `fast`, `full`, `gates` (default: design for M, spec, plan and design for L), `value.rate` $100/h and no `consumers`. Then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts init --stack`: it declares `levels` from the shipped stack template. Do not write `levels` or `quality` yourself: the write guard asks a person before a model adds a declared command, and an unattended run cannot answer. Say that `quality` and a real acceptance or api command need the person's yes (re-run `/rig:init` without `--defaults`).
- Standalone `vendor --standalone`, and merge `templates/settings.json` into `.claude/settings.json`.
- Skip: `claude plugin marketplace add`, the `.github/workflows/` files and `REVIEW.md`. The first writes user settings and the others need a remote, so they stay an explicit yes.
- Existing `CLAUDE.md` still gets a proposed diff, never an overwrite: write the diff to `CLAUDE.md.proposed` and say so.
End with a table of every answer taken and every item skipped, and how to do each skipped one (re-run `/rig:init` without `--defaults`, or `claude plugin marketplace add <repo-root>`).

## Brownfield (source code exists)
1. Launch three `rig:scout` agents **in one message** so they run in parallel:
   - (a) stack, entry points and a module map;
   - (b) the exact build, test, lint and type-check commands, including a fast targeted test command and how to make output quiet;
   - (c) conventions, gotchas, environment setup and things that must never be done.
2. Verify the fast test command by running it once with quiet output.
3. Write `CLAUDE.md` in **at most 120 lines**. Sections:
   - a first line under the title, verbatim: `sdlc routes all work in this repo: start with /rig:start; use superpowers skills only when an sdlc skill names one.`
   - What this is (3 lines)
   - Map (directories, one line each)
   - Commands
   - Conventions
   - Gotchas
   - `# Compact instructions`: keep the active sdlc change, failing tests and file paths; drop exploration output.

   If a `CLAUDE.md` already exists, propose edits as a diff and do not overwrite it.
4. **Code wiki.** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill wiki` and follow it, reusing scout (a)'s module map.

## Greenfield
1. Ask up to three questions with AskUserQuestion: stack, deployment target, and test framework (recommend defaults).
2. Scaffold the smallest walking skeleton that builds, plus one passing smoke test, a lint config, and a `Makefile` or package scripts with `test`, `test-fast` and `lint` targets.
3. Write `CLAUDE.md` as above, then `git init` if needed.

## Both
1. **Sensors.** Detect the stack from scout (a) and propose `levels` and `quality` from `${CLAUDE_PLUGIN_ROOT}/templates/stacks.json`, adjusted to what scout (b) found (the real test command, an existing linter config). Also `fast`/`full` command strings as the harness expects, plus `tests`, `contracts` globs, `limits`, and any e2e, smoke or bench command found (say what each proves). Show one `sensors.json` and write `.sdlc/sensors.json` on a yes (with `--defaults`, follow that mode: `init --stack` declares the levels). Tier L requires `levels` for unit, integration (when the plan spans modules), acceptance and api (endpoint changes): declare all four, with the real command for each (acceptance and api usually an e2e or HTTP test script); an undeclared required level blocks verification. A category the person declines is left out and reads `unmeasured`. Ask with AskUserQuestion (unless `--defaults`): per-tier gates (default: design for M, spec, plan and design for L), the value rate (default $100/h), and whether other repos consume this one's API (each becomes a `consumers` entry: `name`, `path`, `repo`, `test`).
2. **Baseline.** Run each `fast` and `levels` command once through `sdlc.ts run`. Already-failing ones go into `knownRed`, so the gate never blocks on debt it did not create. Then run `sdlc.ts quality <first-change-slug>` on the first change to record the base counts, including the first full security scan. Tell the person the counts.
3. **Standalone (the default).** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts vendor --standalone` unless the person said the team installs the plugin. It copies scripts, skills, agents and hooks into `.sdlc/bin` and `.claude/`, and the mod into `.sdlc/mod` (band, panes, `/rig-run`). Say: the commands are `/rig-start`, `/rig-next`, and so on; the human gates are `/rig-approve` and `/rig-waive`; to upgrade, re-run `vendor --standalone` from a newer plugin. Then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts hooks install` so commits and pushes made outside Claude Code are checked too; say that a teammate who never opens Claude Code runs `node .sdlc/bin/sdlc.ts hooks install` once.
   **Register the mod once:** with the person's yes, run `claude plugin marketplace add <repo-root>` (it writes their user settings). Say that in a fresh clone Claude Code may prompt to trust the project marketplace, and that without registration the settings hooks still gate but the band, panes and `/rig-run` are absent.
4. **Install and verify.** On a yes for each, copy `${CLAUDE_PLUGIN_ROOT}/templates/rig-check.yml` and `rig-review.yml` to `.github/workflows/` (not standalone: also run `sdlc.ts vendor`, CI runs that copy), copy `${CLAUDE_PLUGIN_ROOT}/templates/REVIEW.md` to the repo root, and merge `templates/settings.json` into `.claude/settings.json`. Then **verify**: list `.github/workflows/`, run `git remote get-url origin`, and report each item as installed, skipped by the person, or failed (with why). A missing remote means local-only PRs: say so.
   Some starter tools use the network (npm audit, semgrep --config auto, govulncheck, pip-audit, OWASP dependency-check); say so. Skip the marketplace step in unattended or cloud runs.
   Tell them: make `rig-check` (and `rig-review`) required checks, add CODEOWNERS entries for `.sdlc/**` and the workflows, add an `SDLC_CONSUMERS_TOKEN` secret if a consumer repo is private, and `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or `ANTHROPIC_API_KEY` for the review.

End by telling the person to commit `.sdlc/`, `.claude/`, `.claude-plugin/` and `CLAUDE.md` (make a first commit if the repo has none; ship and CI need a base), then: `Next: /rig-start "<first task>"` (`/rig:start` if not standalone).
