<!-- rig:begin (written by /rig:init; edit outside these markers, a re-run replaces only this block) -->
## Development with rig

This repo uses **rig**, a thin SDLC harness for Claude Code. rig routes every change through a short, gated lifecycle and checks it with deterministic scripts, locally and in CI. Commands below use the `{{P}}` prefix.

### Architecture

```
 YOU        {{P}}start  {{P}}next  {{P}}approve  {{P}}waive        intent and approval
 SKILLS     start design plan diagnose build test sensors pr …   the stages
 AGENTS     scout·haiku  implementer·sonnet  reviewer·opus       model by role and tier
 HOOKS      session-start · prompt-submit · post-edit · stop     guardrails, zero tokens
            git: pre-commit · pre-push                           any editor or agent
 SCRIPTS    .rig/bin/sdlc.ts → check · sensors · graph · …     the deterministic brain
 EVIDENCE   .rig/changes/<slug>/                                committed; read by CI
```

- **Lifecycle of one change:** intent → (spec → plan →) design → build → test → sensors → PR → review. How many stages run depends on the change type (greenfield, feature, bugfix, refactor, migration, chore, spike, incident) and its tier (S, M, L).
- **Human gates:** a person approves the design (tier M), or the spec, plan and design (tier L and greenfield). A model can never approve.
- **Deterministic checks decide:** the commands in `.rig/sensors.json` (fast tests, full tests, lint, test levels, quality counts) must pass; failures that already existed are recorded as `knownRed` so rig never blocks on debt it did not create.
- **State lives in files:** `.rig/sensors.json` (config), `.rig/changes/<slug>/` (intent, design, plan, verification, approvals, `pr.md`), `.rig/bin/` (vendored harness), `.claude/` (hooks and settings), `CLAUDE.md` (project context for Claude).
- **Local equals CI:** `rig-check` in CI runs the same checks as the git hooks.

### User guide

| You want to | Run |
|---|---|
| Start a change | `{{P}}start "<what you want>"` (the type and tier are chosen for you) |
| Move to the next stage | `{{P}}next` (chains build, test, sensors and PR; fix rounds are capped) |
| Approve a gate | `{{P}}approve <slug> design` (also `spec`, `plan`); only a person can |
| Waive a failing sensor with a reason | `{{P}}waive <slug> <sensor> "<reason>"` |
| See where a change stands | `{{P}}status` |

Typical flow:

1. `{{P}}start "add user signup"`. Read the design or plan it writes in `.rig/changes/<slug>/`.
2. Approve the gate with `{{P}}approve <slug> design`.
3. `{{P}}next` until the PR node writes `pr.md`. Review it, then merge as usual.
4. Commit `.rig/`, `.claude/`, `.claude-plugin/` and `CLAUDE.md`; they are the evidence CI reads.

Good to know:

- A bug starts with a failing test; a refactor starts with characterization tests; a one-liner is a chore with almost no ceremony.
- Run the project's checks by hand with the commands in `CLAUDE.md`; `.rig/bin/sdlc.ts check` runs the gate.
- A teammate who never opens Claude Code runs `node .rig/bin/sdlc.ts hooks install` once so the git hooks apply to them.
- To upgrade rig, re-run `vendor --standalone` from a newer plugin checkout. Re-running `/rig:init` only replaces this section.
{{BRAIN}}<!-- rig:end -->
