#!/bin/sh
# Production gate (playbook p.41), a managed-only PreToolUse hook on Bash: install it root-owned outside any repo and wire it in managed settings.
# A command naming deploy and the production environment needs RELEASE_APPROVAL, else exit 2 with the route. A text match: leaky by design,
# acceptable because managed settings make it impossible to switch off. No jq or node needed. Logs only matching commands, never their text.
input=$(cat)
# Every "command" value in the input, still JSON-escaped; if none is found, match the whole input (blocks more, never less).
cmd=$(printf '%s' "$input" | grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"')
[ -n "$cmd" ] || cmd=$input
env_name=${RIG_PRODUCTION_ENV:-production}
printf '%s' "$cmd" | grep -qiF deploy || exit 0
printf '%s' "$cmd" | grep -qiF -- "$env_name" || exit 0
if [ -n "$RELEASE_APPROVAL" ]; then decision=allow; else decision=block; fi
session=$(printf '%s' "$input" | sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9-]*)".*/\1/p')
dir=${CLAUDE_PROJECT_DIR:-$PWD}/.sdlc
if [ -d "$dir" ] && [ ! -L "$dir/gates.jsonl" ]; then
  { printf '{"at":"%s","decision":"%s","session":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$decision" "$session" >> "$dir/gates.jsonl"; } 2>/dev/null || :
fi
[ "$decision" = allow ] && exit 0
echo "Blocked: deploying to $env_name needs a release manager's approval. Prepare the release, ask the release manager to authorize it, and resume this session with the approved change ticket: RELEASE_APPROVAL=<ticket> claude --resume." >&2
exit 2
