#!/usr/bin/env bash
set -u

OUT="/tmp/ocore-impact-proof/gate2-wallet-fixture-scan-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

echo "BH_GATE2_SCAN_OUT $OUT"

find test -maxdepth 2 -type f -name 'byteball.sqlite' | sort | while read dbfile; do
  echo
  echo "===== $dbfile ====="

  sqlite3 "$dbfile" <<'SQL'
.headers on
.mode column

SELECT
  outputs.unit AS trigger_unit,
  outputs.address AS aa_address,
  outputs.amount,
  units.main_chain_index,
  units.sequence
FROM outputs
JOIN aa_addresses ON aa_addresses.address=outputs.address
JOIN units ON units.unit=outputs.unit
WHERE units.sequence='good'
  AND units.main_chain_index IS NOT NULL
ORDER BY units.main_chain_index DESC
LIMIT 20;
SQL
done | tee "$OUT/results.txt"

echo
echo "BH_GATE2_SCAN_DONE $OUT/results.txt"
