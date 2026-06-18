#!/usr/bin/env bash
set -u
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="/tmp/ocore-impact-proof/restart-loop-gate-$STAMP"
mkdir -p "$OUT"

cd "$ROOT" || exit 2

SUMMARY="$OUT/summary.txt"
STATUS="$OUT/status.txt"

log() {
  echo "$*" | tee -a "$SUMMARY"
}

run_cmd() {
  local name="$1"
  shift
  local log_file="$OUT/$name.log"

  log "BH_RUN $name"
  "$@" >"$log_file" 2>&1
  local rc=$?

  echo "BH_EXIT_$name=$rc" | tee -a "$STATUS"
  grep -nE "BH_|different props|no outputs|unit not found|canonical_created_trigger_path_killed|valid_trigger_path_killed|restart_escalation_killed|SQLITE_ERROR|Uncaught exception|Error:" "$log_file" \
    | tee "$OUT/$name.markers.txt" \
    | tee -a "$SUMMARY" >/dev/null || true

  return 0
}

classify_log() {
  local log_file="$1"

  if grep -q "different props" "$log_file" && ! grep -qE "no outputs|unit not found|SQLITE_ERROR" "$log_file"; then
    echo "different_props_clean"
  elif grep -qE "no outputs|unit not found|SQLITE_ERROR" "$log_file"; then
    echo "invalid_or_harness_error"
  elif grep -qE "restart_escalation_killed|canonical_created_trigger_path_killed|valid_trigger_path_killed" "$log_file"; then
    echo "killed"
  else
    echo "no_crash"
  fi
}

log "BH_RESTART_LOOP_GATE_OUT $OUT"
log "BH_RESTART_LOOP_GATE_BRANCH $(git branch --show-current)"
log "BH_RESTART_LOOP_GATE_HEAD $(git rev-parse --short HEAD)"

git checkout -- aa_composer.js >/dev/null 2>&1 || true

if [ ! -f test/bh_no_definition_rollback_cache_crash_probe.test.js ]; then
  log "BH_DIRECT_PRIMITIVE missing_source_probe"
  echo "DIRECT_PRIMITIVE=missing" | tee -a "$STATUS"
else
  run_cmd direct_primitive yarn ava --timeout=60s --concurrency=1 --fail-fast --verbose test/bh_no_definition_rollback_cache_crash_probe.test.js
  DIRECT_CLASS="$(classify_log "$OUT/direct_primitive.log")"
  echo "DIRECT_PRIMITIVE=$DIRECT_CLASS" | tee -a "$STATUS"
fi

if [ -x test/bh_valid_fixture_replay_matrix.sh ]; then
  run_cmd valid_fixture_matrix test/bh_valid_fixture_replay_matrix.sh vulnerable 3
  VALID_FIXTURE_CLASS="$(classify_log "$OUT/valid_fixture_matrix.log")"
  echo "VALID_FIXTURE_REPLAY=$VALID_FIXTURE_CLASS" | tee -a "$STATUS"

  LATEST_FIXTURE_OUT="$(grep -m1 '^out=' "$OUT/valid_fixture_matrix.log" | cut -d= -f2- || true)"
  if [ -n "$LATEST_FIXTURE_OUT" ] && [ -d "$LATEST_FIXTURE_OUT" ]; then
    grep -RInE "BH_|different props|no outputs|unit not found|restart_escalation_killed|Error:" "$LATEST_FIXTURE_OUT" \
      > "$OUT/valid_fixture_nested_markers.txt" 2>/dev/null || true

    if grep -q "different props" "$OUT/valid_fixture_nested_markers.txt" && ! grep -qE "no outputs|unit not found|SQLITE_ERROR" "$OUT/valid_fixture_nested_markers.txt"; then
      VALID_FIXTURE_CLASS="different_props_clean"
      echo "VALID_FIXTURE_REPLAY_NESTED=different_props_clean" | tee -a "$STATUS"
    elif grep -qE "restart_escalation_killed|no outputs|unit not found" "$OUT/valid_fixture_nested_markers.txt"; then
      VALID_FIXTURE_CLASS="killed"
      echo "VALID_FIXTURE_REPLAY_NESTED=killed" | tee -a "$STATUS"
    fi
  fi
else
  echo "VALID_FIXTURE_REPLAY=missing" | tee -a "$STATUS"
fi

if [ -f test/bh_valid_trigger_aa_rollback_crash.test.js ]; then
  run_cmd existing_canonical_trigger yarn ava --timeout=60s --concurrency=1 --fail-fast --verbose test/bh_valid_trigger_aa_rollback_crash.test.js
  EXISTING_CANONICAL_CLASS="$(classify_log "$OUT/existing_canonical_trigger.log")"
  echo "EXISTING_CANONICAL_TRIGGER=$EXISTING_CANONICAL_CLASS" | tee -a "$STATUS"
else
  echo "EXISTING_CANONICAL_TRIGGER=missing" | tee -a "$STATUS"
fi

if [ -f test/bh_canonical_created_trigger_aa_rollback_crash.test.js ]; then
  run_cmd created_canonical_trigger yarn ava --timeout=60s --concurrency=1 --fail-fast --verbose test/bh_canonical_created_trigger_aa_rollback_crash.test.js
  CREATED_CANONICAL_CLASS="$(classify_log "$OUT/created_canonical_trigger.log")"
  echo "CREATED_CANONICAL_TRIGGER=$CREATED_CANONICAL_CLASS" | tee -a "$STATUS"
else
  echo "CREATED_CANONICAL_TRIGGER=missing" | tee -a "$STATUS"
fi

if grep -qE "VALID_FIXTURE_REPLAY(_NESTED)?=different_props_clean|EXISTING_CANONICAL_TRIGGER=different_props_clean|CREATED_CANONICAL_TRIGGER=different_props_clean" "$STATUS"; then
  FINAL="RESTART_LOOP_PROVEN_OR_REOPENED"
elif grep -q "DIRECT_PRIMITIVE=different_props_clean" "$STATUS" \
  && grep -qE "VALID_FIXTURE_REPLAY(_NESTED)?=killed|VALID_FIXTURE_REPLAY=killed|VALID_FIXTURE_REPLAY=no_crash" "$STATUS" \
  && grep -qE "EXISTING_CANONICAL_TRIGGER=killed|EXISTING_CANONICAL_TRIGGER=no_crash|EXISTING_CANONICAL_TRIGGER=missing" "$STATUS" \
  && grep -qE "CREATED_CANONICAL_TRIGGER=killed|CREATED_CANONICAL_TRIGGER=no_crash|CREATED_CANONICAL_TRIGGER=missing" "$STATUS"; then
  FINAL="RESTART_LOOP_KILLED_CURRENT_EVIDENCE"
else
  FINAL="RESTART_LOOP_INCONCLUSIVE"
fi

echo "FINAL=$FINAL" | tee -a "$STATUS" | tee -a "$SUMMARY"
echo "BH_RESTART_LOOP_GATE_DONE {\"out\":\"$OUT\",\"final\":\"$FINAL\"}" | tee -a "$SUMMARY"

echo
echo "===== OUT ====="
echo "$OUT"
echo
echo "===== STATUS ====="
cat "$STATUS"
echo
echo "===== SUMMARY MARKERS ====="
sed -n '1,320p' "$SUMMARY"
