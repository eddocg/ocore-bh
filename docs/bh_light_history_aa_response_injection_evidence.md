# BH light-history AA response metadata injection evidence

## Finding

A controlled light-history provider can inject forged AA response metadata into a light client through the normal light/get_history network path.

The forged metadata is persisted in aa_responses, emits aa_response, is visible through AA-response query paths, and is surfaced in wallet transaction history as if the payment had a real AA interaction result.

## Gate 1: network ingestion

Test: test/bh_gate1_light_history_network_ingestion.test.js

Observed result:

BH_RESULT {"ok":false,"status":"gate1_network_light_history_injection_proven","inserted_rows":1,"emitted_events":1,"get_aa_responses_rows":1,"get_aa_response_chain_rows":1}

Evidence chain:

network.requestHistoryFor()
-> requestHistoryAfterMCI()
-> requestFromLightVendor('light/get_history')
-> local controlled WebSocket light vendor
-> tampered history response with forged aa_responses
-> network response handler
-> light.processHistory()
-> processAAResponses()
-> aa_responses insert
-> aa_response event emission
-> light/get_aa_responses equivalent visibility
-> light/get_aa_response_chain equivalent visibility

## Gate 2: wallet transaction history

Test: test/bh_gate2_wallet_visibility_from_network_history.test.js

Controlled target:

fixture:      test/.testdata-bh_asset_rollback_persistent.test.js
trigger_unit: BvD/g11loi9UMjpWHT3g9zA391rkQHBSjtD+cRHU92U=
payer/author: ZQFHJXFWT2OCEBXF26GFXJU4MPASWPJT
AA payee:     GAZXTJRNXT6YYMUOKN76RTZQ23NO223W

Observed result:

BH_RESULT {"ok":false,"status":"gate2_wallet_transaction_history_visible_from_network_history","saw_light_get_history":true,"network_error":null,"inserted_rows":1,"emitted_events":1,"wallet_forged_rows":1,"wallet_history_forged_rows":1}

Wallet transaction row included:

to_aa: true
bounced: 0
response: {"responseVars":{"bh_gate2_wallet_visible_response":1},"info":"BH_GATE2_FAKE_WALLET_VISIBLE_AA_RESPONSE"}
response_unit: null

## Security boundary

The attacker-controlled component is the light-history provider / light vendor response.

The light client accepts AA response metadata included in light/get_history and treats it as trusted enough to persist, emit, expose through AA-response query paths, and display in wallet transaction history.

## Constraints

No mainnet.
No public network.
No funds movement.
No forged signatures.
No direct processHistory() call as Gate-1 or Gate-2 exploit path.
No direct INSERT INTO aa_responses as exploit path.

## Impact demonstrated

A malicious light-history provider can make a light client display a forged AA response for a real transaction to an AA payee.

The forged response can set wallet-visible AA status fields:

- to_aa
- bounced
- response
- response_unit
- responseVars

## Remaining impact questions

- Whether real deployments allow an attacker to become or influence the user's selected light vendor.
- Whether wallet UX presents responseVars directly to users in a way that changes user decisions.
- Whether automated client logic reacts to aa_response events or responseVars.
- Whether missing response_unit should be rejected for non-bounced AA responses or treated as untrusted metadata.
