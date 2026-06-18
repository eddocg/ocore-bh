/*
 * BH light-client AA response metadata injection probe.
 *
 * Objective:
 * Determine whether light.processHistory() accepts externally supplied
 * aa_responses metadata that is only syntactically valid and references a
 * trigger_unit present in the supplied joints, without proving that the AA
 * response was actually produced by that AA/trigger.
 *
 * Doctrine:
 * - No mainnet.
 * - No public infra.
 * - No SQL mutation to fake the imported AA response.
 * - No direct private processAAResponses() call.
 * - Use exported light.processHistory() as the trust-boundary entry.
 */

'use strict';

const shell = require('child_process').execSync;
const path = require('path');

process.env.devnet = 1;

const constants = require('../constants.js');
const objectHash = require('../object_hash.js');
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
const light = require('../light.js');
const eventBus = require('../event_bus.js');
const network = require('../network.js');
const test = require('ava');

process.on('unhandledRejection', err => { throw err; });

function q(sql, params) {
        return new Promise(resolve => db.query(sql, params || [], resolve));
}

function prepareHistory(historyRequest) {
        return new Promise((resolve, reject) => {
                light.prepareHistory(historyRequest, {
                        ifError: reject,
                        ifOk: resolve
                });
        });
}

function processHistory(objResponse, witnesses) {
        return new Promise((resolve, reject) => {
                light.processHistory(objResponse, witnesses, {
                        ifError: reject,
                        ifOk: resolve
                });
        });
}

function sqlDate() {
        return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function waitForStorageReady(cb) {
        const started = Date.now();

        function check() {
                const stableCount = Object.keys(storage.assocStableUnits || {}).length;
                const aaResponseReady = storage.last_aa_response_id !== null;

                if (stableCount > 0 && aaResponseReady)
                        return cb();

                if (Date.now() - started > 15000) {
                        console.log('BH_LIGHT_READY_TIMEOUT', JSON.stringify({
                                stable_units: stableCount,
                                last_aa_response_id: storage.last_aa_response_id
                        }));
                        return cb();
                }

                setTimeout(check, 100);
        }

        check();
}

function withTimeout(promise, ms, label) {
        return Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms))
        ]);
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
        console.log('***** bh_light_aa_response_injection_probe.test done');
});

test.serial('light history accepts injected AA response metadata for included trigger unit', async t => {
        const witnesses = storage.getOpList(Infinity);

        const candidateRows = await q(
                `SELECT unit, main_chain_index
                 FROM units
                 WHERE unit != ?
                   AND sequence='good'
                   AND main_chain_index IS NOT NULL
                 ORDER BY main_chain_index DESC
                 LIMIT 1`,
                [constants.GENESIS_UNIT]
        );

        t.true(candidateRows.length > 0, 'need one canonical existing unit');
        const triggerUnit = candidateRows[0].unit;
        const mci = candidateRows[0].main_chain_index;

        const authorRows = await q(
                'SELECT address FROM unit_authors WHERE unit=? ORDER BY address LIMIT 1',
                [triggerUnit]
        );

        t.true(authorRows.length > 0, 'candidate trigger unit must have an author');
        const triggerAddress = authorRows[0].address;

        console.log('BH_LIGHT_TRIGGER_UNIT', triggerUnit);
        console.log('BH_LIGHT_TRIGGER_MCI', mci);
        console.log('BH_LIGHT_TRIGGER_ADDRESS', triggerAddress);

        const history = await prepareHistory({
                witnesses,
                requested_joints: [triggerUnit]
        });

        t.true(Array.isArray(history.joints), 'prepareHistory must return joints');
        t.true(history.joints.some(j => j.unit && j.unit.unit === triggerUnit), 'history must include trigger unit');

        let aaRows = await q(
                'SELECT address FROM aa_addresses ORDER BY address LIMIT 1'
        );

        if (aaRows.length === 0) {
                const seededAA = ['autonomous agent', {
                        messages: [
                                {
                                        app: 'data',
                                        payload: {
                                                bh_seeded_known_aa_for_light_response_probe: 1
                                        }
                                }
                        ]
                }];

                const seededAAAddress = objectHash.getChash160(seededAA);

                await storage.insertAADefinitions(
                        db,
                        [{ address: seededAAAddress, definition: seededAA }],
                        constants.GENESIS_UNIT,
                        1,
                        false
                );

                console.log('BH_LIGHT_SEEDED_AA_FOR_FK', seededAAAddress);

                aaRows = await q(
                        'SELECT address FROM aa_addresses ORDER BY address LIMIT 1'
                );
        }

        t.true(aaRows.length > 0, 'fixture must contain at least one known AA address after seeding');

        /*
         * Use a known local AA address to satisfy aa_responses.aa_address FK.
         * The injected response is still fake because processHistory has not
         * proven this AA produced this response for this trigger_unit.
         */
        const fakeAAAddress = aaRows[0].address;

        const fakeAAResponse = {
                mci,
                trigger_address: triggerAddress,
                aa_address: fakeAAAddress,
                trigger_unit: triggerUnit,
                bounced: 0,
                response: JSON.stringify({
                        responseVars: {
                                bh_light_injected_response: 1
                        },
                        info: 'BH_FAKE_LIGHT_AA_RESPONSE_ACCEPTANCE_PROBE'
                }),
                creation_date: sqlDate()
        };

        console.log('BH_LIGHT_EXISTING_AA_USED_FOR_FAKE_RESPONSE', fakeAAAddress);
        console.log('BH_LIGHT_FAKE_AA_RESPONSE', JSON.stringify(fakeAAResponse));

        let emitted = [];
        const handler = objAAResponse => {
                if (objAAResponse && objAAResponse.trigger_unit === triggerUnit && objAAResponse.aa_address === fakeAAAddress)
                        emitted.push(objAAResponse);
        };
        eventBus.on('aa_response', handler);

        history.aa_responses = [fakeAAResponse];

        let accepted = false;
        let error = null;

        try {
                await processHistory(history, witnesses);
                accepted = true;
        }
        catch (e) {
                error = e && e.stack ? e.stack : String(e);
        }
        finally {
                eventBus.removeListener('aa_response', handler);
        }

        const rows = await q(
                `SELECT aa_response_id, mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response
                 FROM aa_responses
                 WHERE trigger_unit=?
                   AND aa_address=?
                 ORDER BY aa_response_id`,
                [triggerUnit, fakeAAAddress]
        );

        console.log('BH_LIGHT_PROCESS_ACCEPTED', accepted);
        console.log('BH_LIGHT_PROCESS_ERROR', error || null);
        console.log('BH_LIGHT_INSERTED_ROWS', JSON.stringify(rows));
        console.log('BH_LIGHT_EMITTED_COUNT', emitted.length);

        if (!accepted) {
                console.log('BH_RESULT', JSON.stringify({
                        ok: true,
                        status: 'light_aa_response_injection_rejected',
                        error
                }));
                t.pass('tampered AA response metadata rejected');
                return;
        }

        if (rows.length > 0) {
                let visibleHistory = null;
                let visibleError = null;

                try {
                        visibleHistory = await withTimeout(prepareHistory({
                                witnesses,
                                addresses: [fakeAAAddress]
                        }), 15000, 'prepareHistoryAfterInjection');
                }
                catch (e) {
                        visibleError = e && e.stack ? e.stack : String(e);
                }

                const visibleAAResponses = (
                        visibleHistory &&
                        Array.isArray(visibleHistory.aa_responses)
                )
                        ? visibleHistory.aa_responses.filter(row =>
                                row.trigger_unit === triggerUnit &&
                                row.aa_address === fakeAAAddress
                        )
                        : [];

                const getAAResponsesRows = await q(
                        `SELECT mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response
                         FROM aa_responses
                         CROSS JOIN units ON trigger_unit=unit
                         WHERE aa_address=?
                           AND mci>=?
                           AND mci<=?
                         ORDER BY mci DESC, aa_response_id DESC
                         LIMIT 100`,
                        [fakeAAAddress, 0, 1000000000000000]
                );

                const chainRows = await q(
                        `SELECT mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response
                         FROM aa_responses
                         CROSS JOIN units ON trigger_unit=unit
                         WHERE trigger_unit=?
                         ORDER BY aa_address`,
                        [triggerUnit]
                );

                const apiVisibleRows = getAAResponsesRows.filter(row =>
                        row.trigger_unit === triggerUnit &&
                        row.aa_address === fakeAAAddress
                );

                const chainVisibleRows = chainRows.filter(row =>
                        row.trigger_unit === triggerUnit &&
                        row.aa_address === fakeAAAddress
                );

                console.log('BH_LIGHT_VISIBLE_HISTORY_ERROR', visibleError || null);
                console.log('BH_LIGHT_VISIBLE_AA_RESPONSES', JSON.stringify(visibleAAResponses));
                console.log('BH_LIGHT_VISIBLE_AA_RESPONSE_COUNT', visibleAAResponses.length);
                console.log('BH_LIGHT_GET_AA_RESPONSES_ROWS', JSON.stringify(getAAResponsesRows));
                console.log('BH_LIGHT_GET_AA_RESPONSES_VISIBLE_COUNT', apiVisibleRows.length);
                console.log('BH_LIGHT_GET_AA_RESPONSE_CHAIN_ROWS', JSON.stringify(chainRows));
                console.log('BH_LIGHT_GET_AA_RESPONSE_CHAIN_VISIBLE_COUNT', chainVisibleRows.length);

                const status = (apiVisibleRows.length > 0 || chainVisibleRows.length > 0)
                        ? 'light_aa_response_injection_api_visible'
                        : (
                                visibleAAResponses.length > 0
                                        ? 'light_aa_response_injection_visible'
                                        : 'light_aa_response_injection_accepted'
                        );

                console.log('BH_RESULT', JSON.stringify({
                        ok: false,
                        status,
                        inserted_rows: rows.length,
                        emitted_events: emitted.length,
                        visible_history_rows: visibleAAResponses.length,
                        get_aa_responses_rows: apiVisibleRows.length,
                        get_aa_response_chain_rows: chainVisibleRows.length,
                        impact_question: 'False AA response metadata was accepted through light.processHistory(), persisted/emitted, and is query-visible through light AA-response API-equivalent paths.'
                }));

                t.fail('light.processHistory accepted and persisted injected AA response metadata');
                return;
        }

        console.log('BH_RESULT', JSON.stringify({
                ok: true,
                status: 'light_aa_response_injection_no_persist',
                accepted,
                inserted_rows: rows.length,
                emitted_events: emitted.length
        }));

        t.pass('tampered metadata did not persist');
});
