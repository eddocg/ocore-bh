#!/usr/bin/env bash
set -u

OUT="/tmp/ocore-impact-proof/gate1-light-history-callgraph-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

echo "BH_GATE1_CALLGRAPH_OUT $OUT"

rg -n --hidden --glob '!node_modules' --glob '!.git' \
  -e "light/get_history" \
  -e "processHistory\\(" \
  -e "requestHistory" \
  -e "requestFromLightVendor" \
  -e "sendRequest\\(" \
  -e "sendResponse\\(" \
  -e "prepareHistory\\(" \
  -e "processAAResponses\\(" \
  -e "aa_response_to_unit" \
  -e "aa_response_from_aa" \
  -e "aa_response_to_address" \
  network.js light.js wallet.js test \
  | tee "$OUT/rg-callgraph.txt"

node <<'NODE' | tee "$OUT/network-light-exports.txt"
process.env.devnet = 1;
const network = require('./network.js');
const light = require('./light.js');

console.log('BH_NETWORK_EXPORTS', Object.keys(network).sort().join('\nBH_NETWORK_EXPORT '));
console.log('BH_LIGHT_EXPORTS', Object.keys(light).sort().join('\nBH_LIGHT_EXPORT '));

process.exit(0);
NODE

echo "BH_GATE1_NEXT inspect $OUT/rg-callgraph.txt and $OUT/network-light-exports.txt"
