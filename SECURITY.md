# Security model

rig makes a coding agent follow a process. It is not a sandbox. Read this before relying on it for an enterprise repo.

## What is a boundary and what is not

| Layer | What it gives you | Can the model get around it? |
|---|---|---|
| **CI (`rig-check`) + branch protection + CODEOWNERS** | The trust boundary. The checker and config come from the base branch. A PR that adds approval or waiver rows fails unless someone other than the PR author approved the current head commit. | No, if branch protection requires `rig-check` and a code-owner review, and dismisses stale approvals. |
| Hooks (`hooks/hooks.json`) and settings `permissions` | Fast, local feedback: the hooks check each edit and each turn; the template's deny rules keep the Edit and Write tools off evidence files and `.env`, and its ask rules make a person confirm edits to `sensors.json`, `rules.json` and `.claude/settings.json`. No hook runs on Bash. | **Yes.** Permission rules cover the file tools, not Bash, so a script the model writes and runs can still write a file. Treat them as guardrails, not locks. The template allows `node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts *` so subagents can record test runs without prompting; `run -- "<command>"` runs any command, including one that sets `SDLC_HUMAN=1`, so local approvals and waivers are not a boundary (CI requires an independent review of every row a PR adds). Edits to `.sdlc/bin/**` still ask. |
| `/rig-approve`, `/rig-waive` | A human decision recorded as a row in `.sdlc/`. | The row is only a file. CI is what proves a person made it. |
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
- Windows is not supported yet: its CI job is red (about ten tests in the `pr` flows use POSIX shell fakes for `gh`), and the end-to-end check runs on Linux. Do not require the Windows job in branch protection until it is fixed.

## Reporting

Report a vulnerability privately to the maintainers (GitHub security advisories on this repository). Do not open a public issue.
