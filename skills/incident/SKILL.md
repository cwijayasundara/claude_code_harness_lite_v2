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
2. Write `.sdlc/incidents/<yyyymmdd>-<kebab>.md` with frontmatter:
   - `class:` a short reusable category such as `null-input`, `timeout`, `auth` or `config`; reuse an existing class from `.sdlc/incidents/` when it fits, because repeat classes are measured
   - `severity:`
   - `escaped: true|false`
   - `detected:` ISO time
   - `intent_at:` now

   Body: symptoms, impact, evidence (log lines, links).
3. Create the change with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts new <slug> --type incident --tier <sev1-2: L, sev3: M, sev4: S> --title "<title>"` and fill `intent.md`, linking the incident file.

End with: `Next: /sdlc:diagnose <slug>`.
