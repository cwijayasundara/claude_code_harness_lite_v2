---
name: metrics
description: Report AI-native SDLC playbook metrics (per stage, leading and lagging) plus cost metrics for this repo.
argument-hint: '[days]'
disable-model-invocation: true
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read
---
# Metrics

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts metrics --days <the days argument, default 30>` and show its output unchanged. Then add **at most 5 lines** of observations:
- the worst leading indicator
- the biggest cost driver (change, stage or agent type)
- context discipline: peak context and the count of turns over 150k
- the `budget` block: team month spent, projected and budget (soft, across clones that published) and how many changes in the window reached their change budget

Metrics with fewer than 5 samples read `unmeasured`. Say so rather than guessing. Dollar figures come from the session cost ledger. Remind the person to compare against `/usage` once a week.
