#!/usr/bin/env bash
# Live trial (spec 13.4, 13.6 and v0.3 section 9). Costs real money: mode M about $2, mode L about $15.
# Usage: tests/trials/run-trials.sh [M|L] [outdir]. M: harness vs plain on a tier M task. L: native, sdd and plain arms on a tier L task.
# Prints cost, turns, wall time, Stop blocks and acceptance (L also prints the per-agent cost split).
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-M}"; shift || true
case "$MODE" in M|L) ;; *) echo "usage: run-trials.sh [M|L] [outdir]" >&2; exit 2 ;; esac
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
SDLC="node --disable-warning=ExperimentalWarning $P/scripts/sdlc.ts"
TASK='Add optional due dates to todos: POST /todos accepts dueDate (ISO YYYY-MM-DD, validated, 400 on invalid), GET /todos?overdue=true returns only not-done todos whose dueDate is before today, and GET /todos sorts by dueDate ascending with undated todos last. Include tests. The handler stays synchronous (it returns { status, body } directly).'
FLAGS=(--permission-mode acceptEdits --allowedTools "Bash(node *)" "Bash(git *)" "Bash(npm *)" --max-budget-usd 8 --output-format json)

fresh() { rm -rf "$OUT/$1"; cp -R "$P/tests/trials/todo-core" "$OUT/$1"; (cd "$OUT/$1" && git init -q -b main && git add -A && git -c user.email=t@e -c user.name=T commit -qm base); }
stat() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(round(d.get('total_cost_usd',0),3), d.get('num_turns'), round(d.get('duration_ms',0)/1000), 's')" "$1"; }
accept() { local o; o=$(cd "$OUT/$1" && TRIAL_ROOT="$OUT/$1" node --test "$P/tests/trials/acceptance.test.js" 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' ' || true); echo "${o:-n/a}"; }
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

TASK_L='Add API-key authentication, per-user todos, pagination and a file-backed store to todo-core. createHandler(service, { users }) takes users as [{ id, apiKey }]. Requests gain headers; every request must carry header x-api-key (lowercase key in the headers object); a missing or unknown key is 401 { error }. Todos belong to the user who created them: GET /todos and PATCH /todos/:id/complete only see the caller'"'"'s todos (another user'"'"'s id is 404). GET /todos returns { items, total } and accepts query limit (default 50, 1..100) and offset (default 0, >= 0); any other value is 400. new TodoService(store) keeps its signature. Add FileTodoStore(path) in src/file-store.js with the same methods as TodoStore that persists to a JSON file, loads it on construction, and writes atomically (write a temp file, then rename). Include tests.'
settings() { # $1 dir, $2 superpowers true|false
  mkdir -p "$1/.claude"
  printf '{"enabledPlugins":{"superpowers@claude-plugins-official":%s,"security-guidance@claude-plugins-official":false,"financial-analysis@claude-for-financial-services":false,"private-equity@claude-for-financial-services":false,"aws-serverless@claude-plugins-official":false,"harness@harness-local":false,"harness-eng-v2@harness-eng-v2":false},"model":"claude-sonnet-5-5","advisorModel":"claude-opus-5-5"}\n' "$2" > "$1/.claude/settings.json"
}
# --max-budget-usd is a per-call runaway guard; arms are compared on actual spend.
FLAGS_L=(--permission-mode acceptEdits --allowedTools "Bash(node *)" "Bash(git *)" "Bash(npm *)" "Bash(bash *)" --max-budget-usd 12 --output-format json)
harness_arm() { # $1 arm name, $2 superpowers true|false
  local d="$OUT/$1"; fresh "$1"; settings "$d" "$2"
  (cd "$d" && $SDLC init >/dev/null && echo '{ "fast": { "test": "npm test" }, "full": { "test": "npm test" } }' > .sdlc/sensors.json && git add -A && git -c user.email=t@e -c user.name=T commit -qm onboard)
  (cd "$d" && claude -p "/sdlc:start \"$TASK_L\" — this is tier L; continue into the spec stage and stop at the human gate." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/$1.A.json")
  local slug; slug="$(one_slug "$d")"
  (cd "$d" && SDLC_HUMAN=1 $SDLC approve "$slug" spec --by trial-operator >/dev/null)
  (cd "$d" && claude -p "/sdlc:plan $slug — stop at the human gate." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/$1.B.json")
  (cd "$d" && SDLC_HUMAN=1 $SDLC approve "$slug" plan --by trial-operator >/dev/null)
  (cd "$d" && claude -p "/sdlc:build $slug — then continue through verify, review and ship; commit on the branch, do not push." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/$1.C.json")
}
acceptL() { local o; o=$(cd "$OUT/$1" && TRIAL_ROOT="$OUT/$1" node --test "$P/tests/trials/acceptance-L.test.js" 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' ' || true); echo "${o:-n/a}"; }
sum() { python3 - "$@" <<'PY'
import json,sys,os
d=[];miss=[]
for f in sys.argv[1:]:
    if os.path.isfile(f):
        try: d.append(json.load(open(f)))
        except Exception: miss.append(os.path.basename(f)+" (unreadable)")
    else: miss.append(os.path.basename(f))
print(round(sum(x.get('total_cost_usd',0) for x in d),3), sum(x.get('num_turns',0) for x in d), round(sum(x.get('duration_ms',0) for x in d)/1000), 's', ("[missing: "+", ".join(miss)+"]") if miss else "")
PY
}
ANY_BAD=0; ARM_FLAG=""
# arm_flag <exit status> <result files...>: sets ARM_FLAG to the first problem found (empty if none) and ANY_BAD=1 on a problem.
arm_flag() {
  local st="$1" f e; shift; ARM_FLAG=""
  [ "$st" != 0 ] && ARM_FLAG="CRASHED (exit $st)"
  for f in "$@"; do
    if [ ! -f "$f" ]; then [ -z "$ARM_FLAG" ] && ARM_FLAG="CRASHED (missing $(basename "$f"))"; continue; fi
    e=$(python3 -c "import json,sys; print(1 if json.load(open(sys.argv[1])).get('is_error') else 0)" "$f" 2>/dev/null || echo 1)
    [ "$e" != 0 ] && [ -z "$ARM_FLAG" ] && ARM_FLAG="ERROR (is_error in $(basename "$f"))"
  done
  [ -n "$ARM_FLAG" ] && ANY_BAD=1
  return 0
}
if [ "$MODE" = L ]; then
  harness_arm native false & P1=$!
  harness_arm sdd true & P2=$!
  ( fresh plain; settings "$OUT/plain" false; cd "$OUT/plain" && claude -p "$TASK_L" "${FLAGS_L[@]}" > "$OUT/plain.json" ) & P3=$!
  S1=0; S2=0; S3=0
  wait "$P1" || S1=$?
  wait "$P2" || S2=$?
  wait "$P3" || S3=$?
  for a in native sdd; do
    if [ "$a" = native ]; then st=$S1; else st=$S2; fi
    arm_flag "$st" "$OUT/$a.A.json" "$OUT/$a.B.json" "$OUT/$a.C.json"
    ledger=0; ls "$OUT/$a"/.superpowers/sdd/*/progress.md >/dev/null 2>&1 && ledger=1
    if [ "$a" = sdd ] && [ "$ledger" = 0 ]; then ARM_FLAG="${ARM_FLAG:+$ARM_FLAG; }SDD NOT EXERCISED"; ANY_BAD=1; fi
    if [ "$a" = native ] && [ "$ledger" = 1 ]; then ARM_FLAG="${ARM_FLAG:+$ARM_FLAG; }SDD UNEXPECTEDLY USED"; fi
    echo "$a: ${ARM_FLAG:+$ARM_FLAG | }$(sum "$OUT/$a".?.json) | acceptance: $(acceptL "$a") | stop blocks: $(stop_blocks "$OUT/$a/.sdlc/.gate") | fallbacks: $(count_matches "$OUT/$a/.sdlc/usage.jsonl" skill-load-failed) | shipped: $(cd "$OUT/$a" && git log --oneline -1 2>/dev/null || echo n/a)"
    node "$P/tests/trials/split.mjs" "$OUT/$a".?.json || true
  done
  arm_flag "$S3" "$OUT/plain.json"
  echo "plain: ${ARM_FLAG:+$ARM_FLAG | }$(sum "$OUT/plain.json") | acceptance: $(acceptL plain)"; node "$P/tests/trials/split.mjs" "$OUT/plain.json" || true
  echo "artifacts in $OUT"
  [ "$ANY_BAD" = 0 ] || { echo "run-trials: at least one arm crashed or errored" >&2; exit 1; }
  exit 0
fi

if [ "$MODE" = M ]; then
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
fi
