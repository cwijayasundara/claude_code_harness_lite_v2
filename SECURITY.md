# Security model

rig makes a coding agent follow a process. It is not a sandbox. Read this before relying on it for an enterprise repo.

## What is a boundary and what is not

| Layer | What it gives you | Can the model get around it? |
|---|---|---|
| **CI (`rig-check`) + branch protection + CODEOWNERS** | The trust boundary. The checker and config come from the base branch. A PR that adds approval or waiver rows fails unless someone other than the PR author approved the current head commit. | No, if branch protection requires `rig-check` and a code-owner review, and dismisses stale approvals. |
| Hooks (`hooks/hooks.json`) and settings `permissions` | Fast, local feedback: the hooks check each edit and each turn; the template's deny rules keep the Edit and Write tools off evidence files and `.env`, and its ask rules make a person confirm edits to `sensors.json`, `rules.json`, `.claude/settings.json` and eval definitions (`.sdlc/evals/*.json`), and the `sdlc.ts evals` command itself. No hook runs on Bash. | **Yes.** Permission rules cover the file tools, not Bash, so a script the model writes and runs can still write a file. Treat them as guardrails, not locks. The template allows `node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts *` so subagents can record test runs without prompting; `run -- "<command>"` runs any command, including one that sets `SDLC_HUMAN=1`, so local approvals and waivers are not a boundary (CI requires an independent review of every row a PR adds). Edits to `.sdlc/bin/**` still ask. |
| `/rig-approve`, `/rig-waive` | A human decision recorded as a row in `.sdlc/`. | The row is only a file. CI is what proves a person made it. |
| `rig-spec.yml` (optional) | Drafts a change from an accepted inbox intent. The draft job holds the Anthropic credential and the model runs rig's commands there, with a read-only token and no persisted git credentials. The publish job runs no model and accepts only rig's own files in one change folder (no symlinks, no subfolders), refuses a change the trunk already has, and publishes only the Markdown (`intent.md`, `design.md`, `spec.md`, `plan.md`, `notes.md`); rig's records (`ratchet.json`, `events.jsonl`, `impact.json`, `runs.jsonl`, `verification.md`) are not published, so the change waits for a person to set its tier and type before any step. The draft job's model cannot edit `.sdlc/bin`, `sensors.json`, `rules.json`, `.claude/` or `.github/`. Inbox files are model-writable (`Edit(.sdlc/**)`), so CODEOWNERS on `/.sdlc/` is what makes acceptance a person's decision. | The draft job can read the repository and spend the credential. Run it on trusted-team repos. |
| Git hooks (`.sdlc/githooks`, wired at session start) | The same checker at `git commit` and `git push`, for any editor, agent or person. They run tracked code at commit and push, so checking out an untrusted branch and committing runs that branch's checker. The opt-out is `node .sdlc/bin/sdlc.ts hooks uninstall`. | **Yes**, by `--no-verify` or `hooks uninstall`, from a person or the model. They are guardrails; CI plus branch protection remain the boundary. |

## Do these before a team rollout

1. Protect the default branch: require `rig-check` (and `rig-review` if used), require code-owner review, **dismiss stale approvals on new commits**, and block direct pushes. Add a `.github/CODEOWNERS` that covers the files that define the rules, so an agent or its operator cannot change what it is judged by:

   ```
   /.sdlc/              @your-org/platform
   /.claude/            @your-org/platform
   /.github/workflows/  @your-org/platform
   /CLAUDE.md           @your-org/platform
   ```
2. Run agents in Claude Code's sandbox, and deploy managed settings so engineers cannot widen them (`allowManagedPermissionRulesOnly`, `disableBypassPermissionsMode`, and `allowManagedHooksOnly` where you want central control). Deny reads of `.env*`, `~/.aws`, `~/.ssh` there, since the Read deny does not cover Bash.
3. Keep Bash on a prompted permission mode for unattended fan-out steps.
4. Install from your own fork pinned to a release tag, not from a moving branch.

## Known limits

- Permission rules cover the file tools only. A model that writes and runs a script can touch evidence files locally; CI catches forged approvals and waivers, not forged `runs.jsonl` rows on a branch nobody reviews.
- The secrets sensor is pattern based. It misses unusual token formats and skips files over 2 MB or detected as binary.
- `sdlc.ts evals` runs `claude -p` with the tools an eval definition allows (`allowedTools`) and runs its `command` checks as shell. Eval definitions (`.sdlc/evals/*.json`) are therefore protected harness files: a person approves edits made with the file tools, harness-tamper flags them and CI review applies. `evals --seed` writes its drafts itself, with no prompt, so read each draft before running it. The template asks before `sdlc.ts evals` runs (a guardrail, not a lock: `sdlc.ts run -- "<command>"` can still start it). Run evals in Claude Code's sandbox, like autonomous builds. Dependency directories (`node_modules`, `.venv`, `venv`, `vendor`) are shared into the eval worktree by symlink, so an eval can write through to yours. `GH_TOKEN` and `GITHUB_TOKEN` are stripped from the environment `claude` gets, but other credentials in your shell are not.
- Windows is not supported yet: its CI job is red (about ten tests in the `pr` flows use POSIX shell fakes for `gh`), and the end-to-end check runs on Linux. Do not require the Windows job in branch protection until it is fixed.

## Reporting

Report a vulnerability privately to the maintainers (GitHub security advisories on this repository). Do not open a public issue.
