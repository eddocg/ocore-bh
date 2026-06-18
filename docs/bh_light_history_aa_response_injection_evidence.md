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


## Gate 3: watched-AA downstream forwarding

Test: test/bh_gate3_light_aa_response_forwarding_from_network_history.test.js

Controlled target:

fixture:      test/.testdata-bh_asset_rollback_persistent.test.js
trigger_unit: BvD/g11loi9UMjpWHT3g9zA391rkQHBSjtD+cRHU92U=
trigger addr: ZQFHJXFWT2OCEBXF26GFXJU4MPASWPJT
AA address:   GAZXTJRNXT6YYMUOKN76RTZQ23NO223W

Observed result:

BH_RESULT {"ok":false,"status":"gate3_light_aa_response_forwarded_from_network_history","saw_light_get_history":true,"network_error":null,"inserted_rows":1,"emitted_events":1,"watch_rows":1,"predicate_hit":true,"forwarded_messages":1}

Forwarded message:

subject: light/aa_response
trigger_unit: BvD/g11loi9UMjpWHT3g9zA391rkQHBSjtD+cRHU92U=
aa_address: GAZXTJRNXT6YYMUOKN76RTZQ23NO223W
bounced: 0
response.info: BH_GATE3_FAKE_FORWARDABLE_AA_RESPONSE
responseVars: bh_gate3_affects_ZQFHJXFWT2OCEBXF26GFXJU4MPASWPJT

Impact demonstrated:

A forged AA response injected by a controlled light-history provider is not only stored locally. It can also be forwarded by the node as light/aa_response to a light client that watches the AA/address.

This shows downstream propagation of forged AA response metadata through normal light-client notification behavior.


## Gate 4: wallet decision-field impact

Test: test/bh_gate4_wallet_decision_fields_from_network_history.test.js

Controlled target:

fixture:      test/.testdata-bh_asset_rollback_persistent.test.js
trigger_unit: BvD/g11loi9UMjpWHT3g9zA391rkQHBSjtD+cRHU92U=
trigger addr: ZQFHJXFWT2OCEBXF26GFXJU4MPASWPJT
AA address:   GAZXTJRNXT6YYMUOKN76RTZQ23NO223W

Observed result:

BH_RESULT {"ok":false,"status":"gate4_wallet_decision_fields_visible_from_network_history","saw_light_get_history":true,"network_error":null,"inserted_rows":1,"emitted_events":1,"wallet_forged_rows":1,"wallet_history_forged_rows":1,"wallet_decisions":1}

Wallet decision fields exposed through wallet.readTransactionHistory():

to_aa: true
bounced: 0
decision_status: filled
release: approved
settlement_reference: BH_FORGED_SETTLEMENT_REFERENCE
consumer_decision: settle_or_release

Impact demonstrated:

The forged AA response is not only visible as raw metadata. It can control wallet-history fields that downstream consumers can reasonably interpret as AA success, settlement, or release state.

This proves decision-affecting potential for consumers that rely on wallet.readTransactionHistory(), aa_response, light/aa_response, light/get_aa_responses, or light/get_aa_response_chain as trusted AA outcome sources.

Boundary:

This does not prove automatic funds movement by a production exchange or bot. It proves attacker-controlled AA outcome data reaches official wallet history and can drive a realistic decision predicate.
