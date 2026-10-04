---
name: learn
description: Find what keeps going wrong across shipped changes and propose harness edits (rules, sensor tuning), each proven against past diffs. Use when metrics suggest a recurring review category, or after a batch of changes ships.
argument-hint: ''
effort: low
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read
---
# Learn from shipped changes

Run each sdlc.ts command as its own Bash call: no `cd`, pipes, redirects, `&&` or shell variables; use the Read tool to read files.

1. Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts learn`. It reads every shipped change, clusters recurring findings and waivers, and replays each candidate rule against the stored diffs. It costs no tokens.
2. Show the person the proposals. For each `rule-add` say its `replay` status:
   - `pass`: it fired on a change it came from and on no clean shipped change. The person can promote it.
   - `fail`: say why (the reason is printed); do not suggest promoting it.
   - `insufficient-holdout`: there are too few shipped changes to trust it yet; say how many are needed.
3. A `sensor-tune` proposal is advice only. Show the evidence and let the person decide; never edit `.sdlc/sensors.json` yourself.
4. To promote a passing rule the person runs `/rig-approve <id> learn`. You cannot run it, and the harness re-checks the replay when they do.

End with: `Next: /rig-approve <id> learn (you), or keep shipping changes`.
