#!/usr/bin/env bash
set -u

MODE="${1:-vulnerable}"
N="${2:-5}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="/tmp/ocore-impact-proof/valid-fixture-${MODE}-${TS}"
FIXTURE_DIR="${OUT}/fixture"
mkdir -p "$OUT" "$FIXTURE_DIR"

SUMMARY="$OUT/summary.txt"
STATUS="$OUT/status.txt"
: > "$SUMMARY"
: > "$STATUS"

echo "mode=$MODE" | tee -a "$SUMMARY"
echo "attempts=$N" | tee -a "$SUMMARY"
echo "out=$OUT" | tee -a "$SUMMARY"
echo "fixture=$FIXTURE_DIR" | tee -a "$SUMMARY"

run_ava() {
	local test_file="$1"
	local log_file="$2"
	
	local ava_bin="${AVA_BIN:-}"
	if [ -z "$ava_bin" ]; then
		if [ -x ./node_modules/.bin/ava ]; then
			ava_bin=./node_modules/.bin/ava
		elif command -v ava >/dev/null 2>&1; then
			ava_bin=ava
		else
			echo "AVA binary not found; install dev dependencies or set AVA_BIN" > "$log_file"
			return 127
		fi
	fi
	BH_VALID_FIXTURE_DIR="$FIXTURE_DIR" $ava_bin --timeout=60s --concurrency=1 --verbose "$test_file" > "$log_file" 2>&1
	return $?
}

snapshot_db() {
	local label="$1"
	local file="$2"
	{
		echo "BH_DB_SNAPSHOT $label"
		if [ -f "$FIXTURE_DIR/byteball.sqlite" ]; then
			node - "$FIXTURE_DIR/byteball.sqlite" <<'NODE'
const sqlite3 = require('sqlite3');
const dbPath = process.argv[2];
const db = new sqlite3.Database(dbPath);
const queries = [
  ['aa_triggers', 'SELECT * FROM aa_triggers ORDER BY mci, unit, address'],
  ['aa_responses', 'SELECT aa_response_id, mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response FROM aa_responses ORDER BY aa_response_id DESC LIMIT 20'],
  ['units_recent', 'SELECT unit, main_chain_index, is_on_main_chain, is_stable, is_free, sequence, is_aa_response FROM units ORDER BY rowid DESC LIMIT 20'],
  ['messages_recent', 'SELECT unit, message_index, app FROM messages ORDER BY rowid DESC LIMIT 50'],
  ['outputs_recent', 'SELECT unit, message_index, output_index, address, amount, asset, is_spent FROM outputs ORDER BY rowid DESC LIMIT 50']
];
function all(sql){ return new Promise((resolve, reject)=>db.all(sql, (err, rows)=>err?reject(err):resolve(rows))); }
(async()=>{
 for (const [name, sql] of queries) {
   try { console.log('## '+name); console.log(JSON.stringify(await all(sql), null, 2)); }
   catch(e){ console.log('## '+name+' ERROR '+e.message); }
 }
 db.close();
})().catch(e=>{ console.error(e.stack||e); db.close(); process.exitCode=1; });
NODE
		else
			echo "no byteball.sqlite in fixture dir"
		fi
	} > "$file" 2>&1
}

grep_markers() {
	local log_file="$1"
	grep -E "BH_|different props|storage\.readUnitProps|no outputs|unit not found|uncaught|UNCAUGHT|Error:" "$log_file" || true
}

EXPORT_LOG="$OUT/export.log"
echo "running export" | tee -a "$SUMMARY"
if run_ava "test/bh_valid_fixture_export_from_working_crash.test.js" "$EXPORT_LOG"; then
	echo "export=success" | tee -a "$STATUS"
else
	echo "export=failed_or_blocked" | tee -a "$STATUS"
fi
grep_markers "$EXPORT_LOG" > "$OUT/export.markers.txt"
cat "$OUT/export.markers.txt" >> "$SUMMARY"

for i in $(seq 1 "$N"); do
	BEFORE="$OUT/db-before-attempt-${i}.txt"
	AFTER="$OUT/db-after-attempt-${i}.txt"
	LOG="$OUT/process-attempt-${i}.log"
	snapshot_db "before-attempt-${i}" "$BEFORE"
	echo "running process attempt $i" | tee -a "$SUMMARY"
	if run_ava "test/bh_valid_fixture_process_once.test.js" "$LOG"; then
		echo "attempt_${i}=success" | tee -a "$STATUS"
	else
		echo "attempt_${i}=failed" | tee -a "$STATUS"
	fi
	snapshot_db "after-attempt-${i}" "$AFTER"
	grep_markers "$LOG" > "$OUT/process-attempt-${i}.markers.txt"
	cat "$OUT/process-attempt-${i}.markers.txt" >> "$SUMMARY"
	if grep -q "no outputs" "$LOG"; then
		echo "attempt_${i}_invalid_fixture=no outputs" | tee -a "$STATUS"
	fi
	if grep -q "unit not found" "$LOG"; then
		echo "attempt_${i}_invalid_fixture=unit not found" | tee -a "$STATUS"
	fi
	done

echo "logs under $OUT" | tee -a "$SUMMARY"
