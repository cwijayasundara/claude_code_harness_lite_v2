---
name: review
description: One independent review pass per change by the Opus sdlc:reviewer agent (plus /security-review for risky changes), recorded in review.md with high-confidence findings only and at most one fix round.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git diff*), Bash(git log*), Bash(git remote*), Read, Write, Edit, Agent, Skill
---
# Review $0

**Subagents:** run every subagent this skill launches in the foreground and wait for its result. Never end your turn while one is still running, because the work is lost if the session ends.

The budget is **one review pass and at most one fix round**. Reviews that chase every conceivable edge case cost more than they save.

1. **Read** `intent.md` for the tier and risks.
2. **Review.** Launch `sdlc:reviewer`, which runs on Opus, with the change folder `.sdlc/changes/$0/` and the diff base (the branch point from main). It is the only general reviewer, so do not add reviewer agents from other plugins.
   - If the tier is L, or the intent's risks name auth, payments, data, secrets or a public API, also invoke Claude Code's built-in `security-review` skill. Run `git remote get-url origin` first. If it fails, the repo has no remote and `/security-review` cannot diff: tell the reviewer to treat security as its first priority instead, and say so in `review.md`.
3. **Fix round.** If the reviewer returns `changes-needed`, fix its findings once:
   - with one `sdlc:implementer` run (plan files only) for tier L or large plans
   - directly in this conversation for small changes

   Then rerun the plan's verification commands once.
4. **Record.** Write `.sdlc/changes/$0/review.md` with frontmatter:
   - `result`: `pass` (no findings), `accepted` (all findings fixed) or `blocked`
   - `rounds`: 1 if no fixes, 2 after the fix round
   - `caught`: the number of findings fixed

   The body lists findings with severity, category and disposition, then the deferred items. Keep each finding's category tag in review.md, because metrics counts recurring categories to suggest new rules.
5. **Unresolved findings.** If any remain, set `result: blocked`, and the person decides.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts status`. End with: `Next: <command from status>`.
