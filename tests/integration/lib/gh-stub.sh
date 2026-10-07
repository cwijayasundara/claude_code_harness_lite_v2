#!/bin/sh
# Stands in for the GitHub CLI in a sandbox whose origin is a local bare repo. Every call is logged to $RIG_GH_LOG.
# It answers each call the harness makes, the way a repo with no CI workflows would.
[ -n "$RIG_GH_LOG" ] && printf '%s\n' "$*" >> "$RIG_GH_LOG"
case "$1 $2" in
  "pr create"|"pr view") echo "https://github.com/rig-sandbox/app/pull/1" ;;
  "pr checks") echo "[]" ;;
  "pr comment") echo "https://github.com/rig-sandbox/app/pull/1#issuecomment-1" ;;
  "pr list"|"api "*) echo "[]" ;;
  "issue view") echo "no issues in the sandbox" >&2; exit 1 ;;
  *) echo "gh stub: unhandled: $*" >&2; exit 1 ;;
esac
