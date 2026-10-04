---
name: onboard
description: One-time setup of a repo for the sdlc harness. Brownfield writes a compact CLAUDE.md from a cheap parallel scout sweep; greenfield scaffolds a walking skeleton with test and lint commands. Never rerun per task.
argument-hint: '[greenfield "<stack and goal>"]'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Write, Edit, Glob, Grep, AskUserQuestion, Agent
---
# Onboard this repo

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts init` first.

## Brownfield (source code exists)
1. Launch three `sdlc:scout` agents **in one message** so they run in parallel:
   - (a) stack, entry points and a module map;
   - (b) the exact build, test, lint and type-check commands, including a fast targeted test command and how to make output quiet;
   - (c) conventions, gotchas, environment setup and things that must never be done.
2. Verify the fast test command by running it once with quiet output.
3. Write `CLAUDE.md` in **at most 120 lines**. Sections:
   - a first line under the title, verbatim: `sdlc routes all work in this repo: start with /sdlc:start; use superpowers skills only when an sdlc skill names one.`
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
1. **Sensors.** Detect the stack from scout (a) and propose `levels` and `quality` from `${CLAUDE_PLUGIN_ROOT}/templates/stacks.json`, adjusted to what scout (b) found (the real test command, an existing linter config). Also `fast`/`full` command strings as the harness expects, plus `tests`, `contracts` globs, `limits`, and any e2e, smoke or bench command found (say what each proves). Show one `sensors.json` and write `.sdlc/sensors.json` on a yes. A category the person declines is left out and reads `unmeasured`. Ask with AskUserQuestion: per-tier gates (default: spec and plan for L), the value rate (default $100/h), and whether other repos consume this one's API (each becomes a `consumers` entry: `name`, `path`, `repo`, `test`).
2. **Baseline.** Run each `fast` and `levels` command once through `sdlc.ts run`. Already-failing ones go into `knownRed`, so the gate never blocks on debt it did not create. Then run `sdlc.ts quality <first-change-slug>` on the first change to record the base counts, including the first full security scan. Tell the person the counts.
3. **Standalone (the default).** Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts vendor --standalone` unless the person said the team installs the plugin. It copies scripts, skills, agents and hooks into `.sdlc/bin` and `.claude/`, and the mod into `.sdlc/mod` (band, panes, `/sdlc-run`). Say: the commands are `/sdlc-start`, `/sdlc-next`, and so on; the human gates are `/sdlc-approve` and `/sdlc-waive`; to upgrade, re-run `vendor --standalone` from a newer plugin.
   **Register the mod once:** with the person's yes, run `claude plugin marketplace add <repo-root>` (it writes their user settings). Say that in a fresh clone Claude Code may prompt to trust the project marketplace, and that without registration the settings hooks still gate but the band, panes and `/sdlc-run` are absent.
4. **Install and verify.** On a yes for each, copy `${CLAUDE_PLUGIN_ROOT}/templates/sdlc-check.yml` and `sdlc-review.yml` to `.github/workflows/` (not standalone: also run `sdlc.ts vendor`, CI runs that copy), copy `${CLAUDE_PLUGIN_ROOT}/templates/REVIEW.md` to the repo root, and merge `templates/settings.json` into `.claude/settings.json`. Then **verify**: list `.github/workflows/`, run `git remote get-url origin`, and report each item as installed, skipped by the person, or failed (with why). A missing remote means local-only PRs: say so.
   Tell them: make `sdlc-check` (and `sdlc-review`) required checks, add CODEOWNERS entries for `.sdlc/**` and the workflows, add an `SDLC_CONSUMERS_TOKEN` secret if a consumer repo is private, and `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or `ANTHROPIC_API_KEY` for the review.

End by telling the person to commit `.sdlc/`, `.claude/`, `.claude-plugin/` and `CLAUDE.md` (make a first commit if the repo has none; ship and CI need a base), then: `Next: /sdlc-start "<first task>"` (`/sdlc:start` if not standalone).
