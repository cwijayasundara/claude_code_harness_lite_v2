---
name: rule
description: Turn a convention the agent keeps breaking into a mechanical rule in .sdlc/rules.json (promote prose to a sensor). Use when metrics suggest a recurring review category, or the person says "this keeps happening".
argument-hint: '"<what keeps recurring>"'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Grep, Glob, AskUserQuestion
---
# Promote a rule: $ARGUMENTS

A rule is a regular expression over **added lines** that blocks or warns, with a `why`. Earn every rule: it must trace to a real, recurring finding.

1. **Evidence.** Find at least two real occurrences: review.md findings with this category, or `git log -p` hits. If there are fewer than two, stop and say the rule is not earned yet.
2. **Draft** one entry:
   `{ "id": "<kebab>", "pattern": "<regex>", "paths": ["<globs>"], "message": "<what to do instead>", "why": "<the incident or finding it traces to>", "action": "block" | "warn" }`
   - The pattern must match the bad lines and not the good ones. Show three lines it matches and three similar lines it must not.
   - Use `warn` unless a mistake would be costly. Prefer narrow `paths`.
3. **Check** with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts check --at ship --json` on a branch that contains a known occurrence: the rule must fire exactly there.
4. **Hand over.** `.sdlc/rules.json` is a protected harness file, so show the person the entry and ask them to add it (the edit prompts them). It goes through PR review like any harness change.

Rules that never fire for 90 days show up in `/rig:metrics` as prune candidates. Fire counts come from this machine's usage.jsonl, so treat prune candidates as suggestions to confirm. Remove them in the same way.

End with: `Next: add the rule (you), then /rig:start for the next change`.
