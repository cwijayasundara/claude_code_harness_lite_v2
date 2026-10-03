#!/usr/bin/env bash
# Live trial (spec 13.4 and 13.6): tier M with the harness vs plain Claude Code. Costs real money (about $2).
# Usage: tests/trials/run-trials.sh [outdir]. Prints cost, turns, wall time, Stop blocks and acceptance.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
SDLC="node --disable-warning=ExperimentalWarning $P/scripts/sdlc.ts"
TASK='Add optional due dates to todos: POST /todos accepts dueDate (ISO YYYY-MM-DD, validated, 400 on invalid), GET /todos?overdue=true returns only not-done todos whose dueDate is before today, and GET /todos sorts by dueDate ascending with undated todos last. Include tests.'
FLAGS=(--permission-mode acceptEdits --allowedTools "Bash(node *)" "Bash(git *)" "Bash(npm *)" --max-budget-usd 8 --output-format json)

fresh() { rm -rf "$OUT/$1"; cp -R "$P/tests/trials/todo-core" "$OUT/$1"; (cd "$OUT/$1" && git init -q -b main && git add -A && git -c user.email=t@e -c user.name=T commit -qm base); }
stat() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(round(d.get('total_cost_usd',0),3), d.get('num_turns'), round(d.get('duration_ms',0)/1000), 's')" "$1"; }
accept() { (cd "$OUT/$1" && TRIAL_ROOT="$OUT/$1" node --test "$P/tests/trials/acceptance.test.js" 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' '); }
# .sdlc/.gate is JSON: {"blocks": {"<sensor-or-key>": n, ...}}; total Stop blocks is the sum of the values.
# Prints exactly one number: the count of lines matching $2 in file $1 (0 if the file is missing or nothing matches).
count_matches() { if [ -f "$1" ]; then grep -c -- "$2" "$1" || true; else echo 0; fi; }
# Prints the single change slug under $1/.sdlc/changes, or fails with a clear message unless there is exactly one.
one_slug() {
  local d="$1/.sdlc/changes" n s
  n=$(find "$d" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" != 1 ]; then echo "run-trials: expected exactly one change under $d, found $n" >&2; return 1; fi
  s=$(find "$d" -mindepth 1 -maxdepth 1 -type d -exec basename {} \;)
  echo "$s"
}
stop_blocks() { python3 -c "import json,sys; print(sum(json.load(open(sys.argv[1])).get('blocks',{}).values()))" "$1" 2>/dev/null || echo 0; }

fresh harness
(cd "$OUT/harness" && $SDLC init >/dev/null && echo '{ "fast": { "test": "npm test" }, "full": { "test": "npm test" } }' > .sdlc/sensors.json && git add -A && git -c user.email=t@e -c user.name=T commit -qm onboard)
(cd "$OUT/harness" && claude -p "/sdlc:start \"$TASK\" — then continue into the plan stage and stop at the human gate." --plugin-dir "$P" "${FLAGS[@]}" > "$OUT/harness.A.json")
SLUG="$(one_slug "$OUT/harness")"
(cd "$OUT/harness" && SDLC_HUMAN=1 $SDLC approve "$SLUG" plan --by trial-operator >/dev/null)
(cd "$OUT/harness" && claude -p "/sdlc:build $SLUG — then continue through review and ship; commit on the branch, do not push." --plugin-dir "$P" "${FLAGS[@]}" > "$OUT/harness.B.json")
echo "harness A: $(stat "$OUT/harness.A.json") | B: $(stat "$OUT/harness.B.json") | acceptance: $(accept harness)"
echo "harness Stop blocks: $(stop_blocks "$OUT/harness/.sdlc/.gate"); skill fallbacks: $(count_matches "$OUT/harness/.sdlc/usage.jsonl" skill-load-failed)"

fresh plain
(cd "$OUT/plain" && claude -p "$TASK" "${FLAGS[@]}" > "$OUT/plain.json")
echo "plain: $(stat "$OUT/plain.json") | acceptance: $(accept plain)"
echo "artifacts in $OUT"
