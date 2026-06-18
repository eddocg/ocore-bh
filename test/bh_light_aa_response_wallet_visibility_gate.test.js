/*
 * BH wallet visibility gate for forged light AA response metadata.
 *
 * This is not a new injection primitive. It checks whether the existing fixture
 * has a canonical trigger unit that pays to a known AA address, which is required
 * for wallet.js to attach forged aa_responses rows to transaction history.
 *
 * No SQL output mutation.
 * No unit mutation.
 * No signature bypass.
 */

'use strict';

const shell = require('child_process').execSync;
const path = require('path');

process.env.devnet = 1;

const constants = require('../constants.js');
const desktop_app = require('../desktop_app.js');

desktop_app.getAppDataDir = function () {
        return __dirname + '/.testdata-' + path.basename(__filename);
};

const srcDir = __dirname + '/initial-testdata-aa_composer.test.js';
const dstDir = __dirname + '/.testdata-' + path.basename(__filename);

shell('rm -rf ' + dstDir);
shell('cp -r ' + srcDir + '/ ' + dstDir);

const db = require('../db.js');
const storage = require('../storage.js');
const eventBus = require('../event_bus.js');
const test = require('ava');

function q(sql, params) {
        return new Promise(resolve => db.query(sql, params || [], resolve));
}

function waitForStorageReady(cb) {
        const started = Date.now();

        function check() {
                const stableCount = Object.keys(storage.assocStableUnits || {}).length;
                const aaResponseReady = storage.last_aa_response_id !== null;

                if (stableCount > 0 && aaResponseReady)
                        return cb();

                if (Date.now() - started > 15000) {
                        console.log('BH_WALLET_GATE_READY_TIMEOUT', JSON.stringify({
                                stable_units: stableCount,
                                last_aa_response_id: storage.last_aa_response_id
                        }));
                        return cb();
                }

                setTimeout(check, 100);
        }

        check();
}

test.before.cb(t => {
        db.query(
                'INSERT ' + db.getIgnore() + ' INTO units (unit, headers_commission, payload_commission) VALUES(?, 0, 0)',
                [constants.GENESIS_UNIT],
                () => waitForStorageReady(() => t.end())
        );
});

test.after.always.cb(t => {
        db.close(t.end);
        console.log('***** bh_light_aa_response_wallet_visibility_gate.test done');
});

test.serial('wallet visibility gate for forged AA response metadata', async t => {
        const rows = await q(
                `SELECT
                        outputs.unit AS trigger_unit,
                        outputs.address AS aa_address,
                        outputs.amount,
                        units.main_chain_index,
                        units.sequence
                 FROM outputs
                 JOIN aa_addresses ON aa_addresses.address=outputs.address
                 JOIN units ON units.unit=outputs.unit
                 WHERE units.sequence='good'
                 ORDER BY units.main_chain_index DESC
                 LIMIT 20`
        );

        console.log('BH_WALLET_GATE_CANONICAL_OUTPUTS_TO_KNOWN_AA', JSON.stringify(rows));

        if (rows.length === 0) {
                console.log('BH_RESULT', JSON.stringify({
                        ok: true,
                        status: 'wallet_visibility_bridge_killed_current_fixture',
                        reason: 'No canonical fixture output pays to a known AA address. wallet.js only attaches AA response metadata when transaction payee equals aa_response.aa_address.'
                }));
                t.pass('wallet bridge killed for current fixture');
                return;
        }

        const target = rows[0];

        const fakeResponse = JSON.stringify({
                responseVars: {
                        bh_wallet_visible_injected_response: 1
                },
                info: 'BH_FAKE_WALLET_VISIBLE_AA_RESPONSE'
        });

        await q(
                `INSERT INTO aa_responses
                 (mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                        target.main_chain_index,
                        target.aa_address,
                        target.aa_address,
                        target.trigger_unit,
                        0,
                        null,
                        fakeResponse
                ]
        );

        const walletEquivalentRows = await q(
                `SELECT bounced, response, response_unit
                 FROM aa_responses
                 WHERE trigger_unit=?
                   AND aa_address=?`,
                [target.trigger_unit, target.aa_address]
        );

        console.log('BH_WALLET_GATE_TARGET', JSON.stringify(target));
        console.log('BH_WALLET_GATE_WALLET_EQUIVALENT_ROWS', JSON.stringify(walletEquivalentRows));

        const visible = walletEquivalentRows.some(row =>
                row.response && row.response.indexOf('BH_FAKE_WALLET_VISIBLE_AA_RESPONSE') >= 0
        );

        console.log('BH_RESULT', JSON.stringify({
                ok: !visible,
                status: visible
                        ? 'wallet_visibility_bridge_query_visible'
                        : 'wallet_visibility_bridge_not_visible',
                trigger_unit: target.trigger_unit,
                aa_address: target.aa_address,
                rows: walletEquivalentRows.length
        }));

        if (visible)
                t.fail('forged aa_response is visible to wallet.js equivalent lookup');

        t.pass('forged aa_response not visible to wallet equivalent lookup');
});
