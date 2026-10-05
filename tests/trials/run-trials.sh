#!/usr/bin/env bash
# Live trial (spec 13.4, 13.6 and v0.3 section 9). Costs real money: mode M about $2, mode L about $15.
# Usage: tests/trials/run-trials.sh [M|L] [outdir]. M: harness vs plain on a tier M task. L: native, sdd and plain arms on a tier L task.
# Prints cost, turns, wall time, Stop blocks and acceptance (L also prints the per-agent cost split).
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-M}"; shift || true
case "$MODE" in M|L|I|S|C) ;; *) echo "usage: run-trials.sh [M|L|I|S|C] [outdir]" >&2; exit 2 ;; esac
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
  printf '{"enabledPlugins":{"superpowers@claude-plugins-official":%s,"security-guidance@claude-plugins-official":false,"financial-analysis@claude-for-financial-services":false,"private-equity@claude-for-financial-services":false,"aws-serverless@claude-plugins-official":false,"harness@harness-local":false,"harness-eng-v2@harness-eng-v2":false},"model":"claude-sonnet-5-5","env":{"CLAUDE_CODE_DISABLE_ADVISOR_TOOL":"true"}}\n' "$2" > "$1/.claude/settings.json"
}
# --max-budget-usd is a per-call runaway guard; arms are compared on actual spend.
FLAGS_L=(--permission-mode acceptEdits --allowedTools "Bash(node *)" "Bash(git *)" "Bash(npm *)" "Bash(bash *)" --max-budget-usd 12 --output-format json)
harness_arm() { # $1 arm name, $2 superpowers true|false
  local d="$OUT/$1"; fresh "$1"; settings "$d" "$2"
  local build=native; [ "$2" = true ] && build=sdd
  (cd "$d" && $SDLC init >/dev/null && echo "{ \"fast\": { \"test\": \"npm test\" }, \"full\": { \"test\": \"npm test\" }, \"build\": \"$build\" }" > .sdlc/sensors.json && git add -A && git -c user.email=t@e -c user.name=T commit -qm onboard)
  (cd "$d" && claude -p "/rig:start \"$TASK_L\" — this is tier L; continue into the spec stage and stop at the human gate." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/$1.A.json")
  local slug; slug="$(one_slug "$d")"
  (cd "$d" && SDLC_HUMAN=1 $SDLC approve "$slug" spec --by trial-operator >/dev/null)
  (cd "$d" && claude -p "/rig:plan $slug — stop at the human gate." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/$1.B.json")
  (cd "$d" && SDLC_HUMAN=1 $SDLC approve "$slug" plan --by trial-operator >/dev/null)
  (cd "$d" && claude -p "/rig:build $slug — then continue through verify, review and ship; commit on the branch, do not push." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/$1.C.json")
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
# Shared by S and C. drive <dir> <tag> <first prompt>: the operator approves human gates, up to $SESSIONS (default 10) sessions.
FLAGS_S=(--permission-mode acceptEdits --allowedTools "Bash(node *)" "Bash(git *)" "Bash(npm *)" "Bash(bash *)" --max-budget-usd "${BUDGET:-6}" --output-format json)
NEXT="/rig:next — continue through ship; commit on the branch, do not push."
# drive <dir> <tag> <first prompt>: run, approve any human gate as the operator, continue, up to 5 sessions.
drive() {
  local d="$1" tag="$2" n=1 cmd
  (cd "$d" && claude -p "$3" --plugin-dir "$P" "${FLAGS_S[@]}" < /dev/null > "$OUT/$tag.1.json") || true
  while [ "$n" -lt "${SESSIONS:-10}" ]; do
    cmd=$(cd "$d" && $SDLC status --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); a=d.get("active"); c=[x for x in d.get("changes",[]) if x["slug"]==a]
print(c[0]["command"] if c else "")' || true)
    case "$cmd" in
      "human gate"*)
        set -- $(printf '%s' "$cmd" | sed -E 's|.*/rig-approve ([^ ]+) ([^ ]+).*|\1 \2|')
        (cd "$d" && SDLC_HUMAN=1 $SDLC approve "$1" "$2" --by scenario-operator >/dev/null) || true
        echo "$tag: operator approved $2" ;;
      done*) break ;;
      "") echo "$tag: no active change"; break ;;
      *) : ;;
    esac
    n=$((n + 1))
    (cd "$d" && claude -p "$NEXT" --plugin-dir "$P" "${FLAGS_S[@]}" < /dev/null > "$OUT/$tag.$n.json") || true
  done
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
  # SDD=0 skips the opt-in SDD arm (it alone ran past 20 minutes in the second v0.3 trial).
  ARMS="native"; P2=""; if [ "${SDD:-1}" != 0 ]; then harness_arm sdd true & P2=$!; ARMS="native sdd"; fi
  ( fresh plain; settings "$OUT/plain" false; cd "$OUT/plain" && claude -p "$TASK_L" "${FLAGS_L[@]}" > "$OUT/plain.json" ) & P3=$!
  S1=0; S2=0; S3=0
  wait "$P1" || S1=$?
  [ -z "$P2" ] || wait "$P2" || S2=$?
  wait "$P3" || S3=$?
  for a in $ARMS; do
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
  # Lean tier M: one harness session from /rig:start to ship (no gate), against plain Claude Code, in parallel.
  ( fresh harness; settings "$OUT/harness" false
    cd "$OUT/harness" && $SDLC init >/dev/null && echo '{ "fast": { "test": "npm test" }, "full": { "test": "npm test" } }' > .sdlc/sensors.json \
      && git add -A && git -c user.email=t@e -c user.name=T commit -qm onboard \
      && claude -p "/rig:start \"$TASK\" — then continue through ship; commit on the branch, do not push." --plugin-dir "$P" "${FLAGS[@]}" > "$OUT/harness.A.json" ) & P1=$!
  ( fresh plain; settings "$OUT/plain" false; cd "$OUT/plain" && claude -p "$TASK" "${FLAGS[@]}" > "$OUT/plain.json" ) & P2=$!
  S1=0; S2=0; wait "$P1" || S1=$?; wait "$P2" || S2=$?
  arm_flag "$S1" "$OUT/harness.A.json"
  echo "harness: ${ARM_FLAG:+$ARM_FLAG | }$(sum "$OUT/harness.A.json") | acceptance: $(accept harness) | stop blocks: $(stop_blocks "$OUT/harness/.sdlc/.gate") | shipped: $(cd "$OUT/harness" && git log --oneline -1 2>/dev/null || echo n/a)"
  node "$P/tests/trials/split.mjs" "$OUT/harness.A.json" || true
  arm_flag "$S2" "$OUT/plain.json"
  echo "plain: ${ARM_FLAG:+$ARM_FLAG | }$(sum "$OUT/plain.json") | acceptance: $(accept plain)"
  echo "artifacts in $OUT"
  [ "$ANY_BAD" = 0 ] || { echo "run-trials: an arm crashed or errored" >&2; exit 1; }
fi

if [ "$MODE" = I ]; then
  # Integration test: /rig:init on a four-module app, then one internal change through ship; every artifact is
  # checked deterministically by assert-integration.mjs. LIVE and PAID (about $2).
  TASK_I='Add a bestSellers(orders, n) function exported from src/orders/report.js. orders is an array of { lines: [{ sku, qty }] }. It returns an array of the n SKU strings with the highest total quantity sold, most first, ties broken by SKU ascending; [] for no orders. It is internal: no HTTP route. Include tests.'
  rm -rf "$OUT/app"; cp -R "$P/tests/trials/shop-app" "$OUT/app"
  (cd "$OUT/app" && git init -q -b main && git add -A && git -c user.email=t@e -c user.name=T commit -qm base)
  settings "$OUT/app" false
  (cd "$OUT/app" && git add -A && git -c user.email=t@e -c user.name=T commit -qm settings)
  (cd "$OUT/app" && claude -p "/rig:init — this is an existing codebase; answer your own questions with the recommended defaults, decline CI and settings changes, and commit the onboarding files on main." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/onboard.json") || true
  echo "onboard: $(sum "$OUT/onboard.json")"
  R1=0; node "$P/tests/trials/assert-integration.mjs" onboard "$OUT/app" "$P" || R1=$?
  (cd "$OUT/app" && git add -A && git -c user.email=t@e -c user.name=T commit -qm "onboarding leftovers" >/dev/null 2>&1 || true)
  (cd "$OUT/app" && claude -p "/rig:start \"$TASK_I\" — then continue through ship; commit on the branch, do not push." --plugin-dir "$P" "${FLAGS_L[@]}" > "$OUT/change.json") || true
  echo "change: $(sum "$OUT/change.json")"
  R2=0; node "$P/tests/trials/assert-integration.mjs" change "$OUT/app" "$P" || R2=$?
  node "$P/tests/trials/split.mjs" "$OUT/onboard.json" "$OUT/change.json" || true
  echo "artifacts in $OUT/app"
  [ "$R1" = 0 ] && [ "$R2" = 0 ] || { echo "run-trials: integration checks failed" >&2; exit 1; }
fi

if [ "$MODE" = S ]; then
  # Scenario suite: greenfield, tier L bugfix and tier M refactor (the shop is onboarded with the unit, integration and acceptance levels a tier L change requires, as a trunk commit), in parallel, each driven to ship with the person's
  # gates approved by the operator, then checked by assert-scenarios.mjs. LIVE and PAID (about $5).
  shop() { # $1 dir: the shop app with sdlc initialised (sensors set, no onboarding session)
    rm -rf "$1"; cp -R "$P/tests/trials/shop-app" "$1"; settings "$1" false
    (cd "$1" && git init -q -b main && $SDLC init >/dev/null && echo '{ "fast": { "test": "npm test" }, "full": { "test": "npm test" }, "levels": { "unit": "npm test", "integration": "npm test", "acceptance": "npm test" } }' > .sdlc/sensors.json \
      && printf '# shop-app\n\nsdlc routes all work in this repo: start with /rig:start; use superpowers skills only when an sdlc skill names one.\n' > CLAUDE.md \
      && git add -A && git -c user.email=t@e -c user.name=T commit -qm base)
  }
  scenario() { # $1 name: run it under an 18-minute stop, then check it
    ( set -m; "$1"_run & pid=$!
      ( sleep 1080 & s=$!; trap "kill $s" TERM; wait $s && { echo "$1: WATCHDOG 18 min" >&2; kill -TERM -$pid; } ) & w=$!
      wait $pid; kill -TERM $w 2>/dev/null; wait $w 2>/dev/null ) || true
    R=0; node "$P/tests/trials/assert-scenarios.mjs" "$1" "$OUT/$1" "$P" > "$OUT/$1.check.txt" 2>&1 || R=$?
    echo "$R" > "$OUT/$1.rc"
  }
  greenfield_run() {
    local d="$OUT/greenfield"; rm -rf "$d"; mkdir -p "$d"; settings "$d" false
    (cd "$d" && git init -q -b main && git add -A && git -c user.email=t@e -c user.name=T commit -qm empty)
    (cd "$d" && claude -p "/rig:init greenfield \"Node.js 22 ESM library, no dependencies, tests with node --test: unit conversion for lengths\" — answer your own questions with the recommended defaults, decline CI and settings changes, and commit the scaffold on main." --plugin-dir "$P" "${FLAGS_S[@]}" < /dev/null > "$OUT/greenfield.0.json") || true
    (cd "$d" && git add -A && git -c user.email=t@e -c user.name=T commit -qm "onboarding leftovers" >/dev/null 2>&1 || true)
    drive "$d" greenfield "/rig:start \"Add convert(value, from, to) exported from src/convert.js. Units: mm, cm, m, km, in, ft, yd, mi (1 in = 2.54 cm, 1 ft = 12 in, 1 yd = 3 ft, 1 mi = 1760 yd). It returns a number rounded to 6 decimal places and throws a RangeError for an unknown unit. This is the library's first public API. Include tests.\" — continue through ship; commit on the branch, do not push."
  }
  bugfix_run() {
    local d="$OUT/bugfix"; shop "$d"
    (cd "$d" && sed -i.bak 's/SAVE20: 0.2/SAVE20: 0.02/' src/orders/orders.js && rm src/orders/orders.js.bak && git -c user.email=t@e -c user.name=T commit -qam "pricing update")
    drive "$d" bugfix "/rig:start \"Bug in payments: checkout with discount code SAVE20 takes only 2% off instead of 20%. Customers are being overcharged.\" — continue through ship; commit on the branch, do not push."
  }
  refactor_run() {
    local d="$OUT/refactor"; shop "$d"
    drive "$d" refactor "/rig:start \"Refactor: move the discount codes out of src/orders/orders.js into a new src/orders/discounts.js that exports DISCOUNTS and rateFor(code) (returns the rate, or undefined for an unknown code). Checkout behaviour must not change.\" — continue through ship; commit on the branch, do not push."
  }
  scenario greenfield & G=$!; scenario bugfix & B=$!; scenario refactor & F=$!
  wait $G; wait $B; wait $F
  BAD=0
  for sc in greenfield bugfix refactor; do
    echo "== $sc: $(sum "$OUT/$sc".*.json)"
    cat "$OUT/$sc.check.txt"
    node "$P/tests/trials/split.mjs" "$OUT/$sc".*.json 2>/dev/null | tail -n +2 || true
    [ "$(cat "$OUT/$sc.rc" 2>/dev/null || echo 1)" = 0 ] || BAD=1
  done
  echo "artifacts in $OUT"
  [ "$BAD" = 0 ] || { echo "run-trials: a scenario failed its checks" >&2; exit 1; }
fi

if [ "$MODE" = C ]; then
  # Cart lifecycle: ONE repo, three changes in sequence, every human gate approved by the operator, each checked by assert-cart.mjs.
  #   1 greenfield: empty dir -> /rig:init greenfield -> first feature (Cart)      2 brownfield feature: coupons
  #   3 brownfield behaviour change: bulk discount alters existing totals (old tests must be updated, old promises must still hold)
  # LIVE and PAID (about $8-12). Usage: tests/trials/run-trials.sh C [outdir]; BUDGET=<usd per claude call> overrides the cap of 6.
  d="$OUT/cart"; rm -rf "$d"; mkdir -p "$d"; settings "$d" false
  (cd "$d" && git init -q -b main && git add -A && git -c user.email=t@e -c user.name=T commit -qm empty)
  # The operator plays the person who merges the PR: fast-forward main to the change branch, so the next change starts from shipped code.
  merge_ship() {
    local b; b=$(cd "$d" && git rev-parse --abbrev-ref HEAD)
    (cd "$d" && git add -A && git -c user.email=t@e -c user.name=T commit -qm "operator: leftovers" >/dev/null 2>&1 || true)
    [ "$b" = main ] || (cd "$d" && git checkout -q main && git merge -q --ff-only "$b") || echo "cart: merge of $b failed"
  }
  check_phase() { # $1 phase name
    local rc=0; node "$P/tests/trials/assert-cart.mjs" "$1" "$d" "$P" > "$OUT/cart.$1.check.txt" 2>&1 || rc=$?
    echo "$rc" > "$OUT/cart.$1.rc"; echo "== $1: $(sum "$OUT/cart.$1".*.json)"; cat "$OUT/cart.$1.check.txt"
  }
  (cd "$d" && claude -p "/rig:init --defaults greenfield \"Node.js 22 ESM library, no dependencies, tests with node --test: an in-memory shopping cart\" — commit the scaffold on main." --plugin-dir "$P" "${FLAGS_S[@]}" < /dev/null > "$OUT/cart.scaffold.0.json") || true
  (cd "$d" && git add -A && git -c user.email=t@e -c user.name=T commit -qm "onboarding leftovers" >/dev/null 2>&1 || true)
  check_phase scaffold
  [ "$(cat "$OUT/cart.scaffold.rc")" = 0 ] || { echo "run-trials: scaffold failed; not spending on the changes" >&2; exit 1; }
  drive "$d" cart.cart "/rig:start \"Add a Cart class exported from src/cart.js. add(sku, priceCents, qty = 1) adds qty of a SKU (a repeat add of the same SKU sums the quantity). remove(sku) deletes the whole line and throws an Error for a SKU not in the cart. lines() returns [{ sku, qty, priceCents }] sorted by sku ascending. totalCents() returns the sum of priceCents * qty. qty must be a positive integer and priceCents a non-negative integer, otherwise add throws a RangeError. This is the library's first public API. Include tests.\" — continue through ship; commit on the branch, do not push."
  check_phase cart; merge_ship
  drive "$d" cart.coupon "/rig:start \"Add Cart.applyCoupon(code). SAVE10 takes 10% off the cart total, any other code throws an Error whose message contains 'unknown coupon'. totalCents() then returns the discounted total rounded DOWN to a whole cent; applying a coupon twice keeps a single 10% discount (it does not stack). Everything that worked before must behave the same when no coupon is applied. Include tests.\" — continue through ship; commit on the branch, do not push."
  check_phase coupon; merge_ship
  drive "$d" cart.bulk "/rig:start \"Behaviour change: a line with qty of 10 or more now gets 5% off that line (line total = floor(priceCents * qty * 95 / 100)), applied before any coupon. This deliberately changes totalCents() for carts that were previously priced at full price, so update the tests that pinned the old totals. Lines under 10 and the coupon rules are unchanged.\" — continue through ship; commit on the branch, do not push."
  check_phase bulk
  BAD=0; for p in scaffold cart coupon bulk; do [ "$(cat "$OUT/cart.$p.rc" 2>/dev/null || echo 1)" = 0 ] || BAD=1; done
  node "$P/tests/trials/split.mjs" "$OUT"/cart.*.json 2>/dev/null | tail -n +2 || true
  echo "artifacts in $d"
  [ "$BAD" = 0 ] || { echo "run-trials: a cart phase failed its checks" >&2; exit 1; }
fi
