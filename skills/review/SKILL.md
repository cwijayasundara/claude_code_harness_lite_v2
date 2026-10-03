---
name: review
description: One review pass per tier L change - Claude Code's built-in /code-review plus a spec and contract check (and /security-review for risky changes) - recorded in review.md, at most one fix round.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git diff*), Bash(git log*), Bash(git remote*), Read, Write, Edit, Agent, Skill
---
# Review $0

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

The budget is **one review pass and at most one fix round**. Reviews that chase every conceivable edge case cost more than they save.

1. **Read** `intent.md` for the tier and risks.
2. **Review.** Run Claude Code's built-in `code-review` skill with `high` on the change's diff: it finds the correctness bugs, cheaply. Then check what it cannot know, in a few lines: each `## Contracts` line of plan.md matches the diff, and nothing contradicts a B-number in spec.md (the traceability sensor already proves each B-number has a test). If `code-review` fails to load, launch `sdlc:reviewer` (Opus) with the change folder and the diff base instead.
   - If the tier is L, or the intent's risks name auth, payments, data, secrets or a public API, also invoke Claude Code's built-in `security-review` skill. Run `git remote get-url origin` first. If it fails, the repo has no remote and `/security-review` cannot diff: review security yourself as the first priority instead, and say so in `review.md`.
3. **Fix round.** If the review keeps findings, fix them once:
   - with one `sdlc:implementer` run (plan files only) for tier L or large plans
   - directly in this conversation for small changes

   Then rerun the plan's verification commands once.
4. **Record.** Write `.sdlc/changes/$0/review.md` with frontmatter:
   - `result`: `pass` (no findings), `accepted` (all findings fixed) or `blocked`
   - `rounds`: 1 if no fixes, 2 after the fix round
   - `caught`: the number of findings fixed

   The body lists findings with severity, category and disposition, then the deferred items. Keep each finding's category tag in review.md, because metrics counts recurring categories to suggest new rules.
5. **Unresolved findings.** If any remain, set `result: blocked`, and the person decides.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. End with: `Next: <command from status>`. Then keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it, unless the person asked to stop after this stage.
