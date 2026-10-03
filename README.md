# sdlc: a thin AI-native SDLC harness for Claude Code

This plugin turns Claude Code into a disciplined software engineer. It adds very little of its own and relies on what Claude Code already provides. It follows [the AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) and measures both the playbook's metrics and what each change costs.

It handles every kind of task: greenfield, brownfield, feature, bugfix, refactor, migration, chore, spike and incident. How much process a change goes through depends on its type and tier. See [DESIGN.md](DESIGN.md) for the evidence and the reasoning behind each choice.

## Install

1. Add this folder as a marketplace and enable the plugin in the project's `.claude/settings.json`. [`templates/settings.json`](templates/settings.json) has the full recommended block:

   ```jsonc
   {
     "extraKnownMarketplaces": { "sdlc": { "source": { "source": "directory", "path": "/abs/path/to/claude_code_harness_lite_v2" } } },
     "enabledPlugins": { "sdlc@sdlc": true, "superpowers@claude-plugins-official": false, "security-guidance@claude-plugins-official": false },
     "model": "sonnet",
     "advisorModel": "opus",
     "autoCompactWindow": 200000
   }
   ```

   To try it for a single session, run `claude --plugin-dir /abs/path/to/claude_code_harness_lite_v2` instead.

2. In the project, run `/sdlc:onboard`. It runs once per repo and writes a compact CLAUDE.md, or scaffolds a walking skeleton for a new project.

Requires Claude Code 2.1.287 or later for the mod parts. The skills, agents and settings hooks work on older versions.

## Use

| You type | What happens |
|---|---|
| `/sdlc:start "add CSV export to reports"` | Classifies type and tier, writes `.sdlc/changes/<slug>/intent.md`, and prints the path and the next command. Tier S is built in the same turn. |
| `/sdlc:spec`, `/sdlc:plan`, `/sdlc:build`, `/sdlc:diagnose`, `/sdlc:verify`, `/sdlc:review`, `/sdlc:ship` | One stage each. Every stage ends with the exact next command. |
| `/sdlc-approve <slug> <spec\|plan>` | **Human gate.** A mod command: costs zero tokens, the model cannot invoke it, and the approval goes stale if the artifact changes afterwards. |
| `/sdlc-status` | Where every change stands. Zero tokens. |
| `/sdlc:handoff` | Writes a STATE.md of 40 lines or fewer so you can `/clear` and resume cheaply. The band above the prompt turns red at 150k context. |
| `/sdlc:incident "<what broke>"` | Maintain stage: records the incident and opens a bugfix-path change. |
| `/sdlc:metrics [days]` | The playbook's 12 metrics (leading and lagging per stage) plus cost per change, stage and agent. |

For long unattended builds, `/sdlc:build` prints a ready `/goal` line, so you don't have to keep typing "continue".

## What is in the box

| Part | Role |
|---|---|
| `skills/` (12) | The stages, run by the main thread (Sonnet 5.5, with Opus 5.5 as advisor). No skill sets `model:`, because a model switch re-reads the whole conversation uncached. Opus comes in through the architect and reviewer agents, which start with their own small contexts. |
| `agents/scout.md` | Haiku, read-only, `omitClaudeMd`. Cheap code search, used instead of Explore running on your main model. |
| `agents/architect.md` | **Opus 5.5**, high effort. Writes spec.md and plan.md, the design-heavy steps. |
| `agents/implementer.md` | **Sonnet 5.5**. The code generator: builds one slice test-first and reports real test output. |
| `agents/reviewer.md` | **Opus 5.5**, high effort. One independent review per change, keeping findings at confidence 80 or above. |
| `agents/verifier.md` | Sonnet 5.5. Runs the verification commands and writes the report. Never repairs. |
| `hooks/hooks.json` | Settings hooks, which also hold in `-p` and CI. They inject session context, block model-made approvals, block sleep-polling, ask about edits outside the plan's `## Files`, and reject secrets or plans that contain code (exit 2). |
| `hooks/register.tsx` | The mod. It records per-turn tokens and the dollar delta from the session ledger, shows the context and spend band, runs the zero-token commands and the context-budget nudges, and gives general-purpose subagents Sonnet by default. |
| `scripts/sdlc.ts` | Zero-dependency core: change state, approvals, scope drift, secret scanning, hook decisions, metrics. |

Artifacts live in **`.sdlc/`** at the repo root and are committed; `usage.jsonl` is gitignored. They are not under `.claude/`, which Claude Code protects: writes there always prompt, or are denied in headless runs, and allow rules can't change that.

## Develop

```bash
node --test tests/*.test.mjs                 # core script (12 tests)
claude plugin test .                         # mod (4 tests)
claude plugin validate .claude-plugin/plugin.json
```
