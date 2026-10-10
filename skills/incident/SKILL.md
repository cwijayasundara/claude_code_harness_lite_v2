---
name: incident
description: Maintain stage - record an incident or monitoring band breach and turn it into an incident change on the bug path.
argument-hint: '"<what broke>" [--escaped]'
disable-model-invocation: true
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Read, Write, Edit, AskUserQuestion
---
# Incident

1. Gather the details from $ARGUMENTS. Ask at most two questions:
   - severity (sev1–sev4)
   - whether it reached production (escaped)
2. Write `.rig/incidents/<yyyymmdd>-<kebab>.md` with frontmatter:
   - `class:` a short reusable category such as `null-input`, `timeout`, `auth` or `config`; reuse an existing class from `.rig/incidents/` when it fits, because repeat classes are measured
   - `severity:`
   - `escaped: true|false`
   - `detected:` ISO time
   - `restored:` ISO time service was restored (leave it blank until then, and fill it in when it is); time to restore is measured from it
   - `intent_at:` now

   Body: symptoms, impact, evidence (log lines, links).
3. Create the change with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts new <slug> --type incident --tier <sev1-2: L, sev3: M, sev4: S> --title "<title>"` and fill `intent.md`, linking the incident file.

End with: `Next: /rig:diagnose <slug>`.
