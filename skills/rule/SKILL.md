---
name: rule
description: Turn a convention the agent keeps breaking into a mechanical rule in .sdlc/rules.json, or into one line of CLAUDE.md when no pattern can catch it (promote prose to a sensor). Use when metrics or a review show a recurring finding category, or the person says "this keeps happening".
argument-hint: '"<what keeps recurring>"'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Grep, Glob, AskUserQuestion
---
# Promote a lesson: $ARGUMENTS

A lesson is earned only by a real, recurring finding. It becomes a regular expression over **added lines** that blocks or warns, with a `why`; or, when no pattern can catch it, one line of CLAUDE.md the agent reads at every session start.

1. **Evidence.** Find at least two real occurrences: review.md findings with this category, or `git log -p` hits. If there are fewer than two, stop and say the rule is not earned yet.
2. **Draft.** If the mistake shows in the added lines, draft one rule entry:
   `{ "id": "<kebab>", "pattern": "<regex>", "paths": ["<globs>"], "message": "<what to do instead>", "why": "<the incident or finding it traces to>", "action": "block" | "warn" }`
   - The pattern must match the bad lines and not the good ones. Show three lines it matches and three similar lines it must not.
   - Use `warn` unless a mistake would be costly. Prefer narrow `paths`.

   If it cannot be stated as a regular expression (a design habit, a wrong assumption, a step it skips), draft one line for CLAUDE.md's `## Things Claude gets wrong` section instead: what to do, in at most 25 words, ending with `(seen: <slug>, <slug>)`. Skip step 3 for a CLAUDE.md line.
3. **Check** with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts check --at ship --json` on a branch that contains a known occurrence: the rule must fire exactly there.
4. **Hand over.** `.sdlc/rules.json` is a harness file and CLAUDE.md is a protected harness file too, so show the person the entry or the line and ask them to add it (for CLAUDE.md, under `## Things Claude gets wrong`, adding that heading if it is missing). It goes through PR review like any harness change.

Rules that never fire for 90 days show up in `/rig:metrics` as prune candidates. Fire counts come from this machine's usage.jsonl, so treat prune candidates as suggestions to confirm. Remove them in the same way.

End with: `Next: add the rule or the CLAUDE.md line (you), then /rig:start for the next change`.
