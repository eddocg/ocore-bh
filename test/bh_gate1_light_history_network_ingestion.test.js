/*
 * Gate 1: AA response metadata injection through real light-history ingestion path.
 *
 * This test must prove or kill network/light-history ingestion.
 *
 * Forbidden as exploit path:
 * - direct light.processHistory() call from the test
 * - direct DB insertion of forged aa_responses
 * - mutation of consensus objects
 *
 * Allowed:
 * - local controlled provider payload construction
 * - mocked local light vendor/hub callback, if it is reached through network.js
 *   request/response plumbing
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
const network = require('../network.js');
const eventBus = require('../event_bus.js');
const test = require('ava');
const WebSocket = require('ws');

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
                        console.log('BH_GATE1_READY_TIMEOUT', JSON.stringify({
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

function prepareProviderHistory(historyRequest) {
        return new Promise((resolve, reject) => {
                light.prepareHistory(historyRequest, {
                        ifError: reject,
                        ifOk: resolve
                });
        });
}

function sqlDate() {
        return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function seedKnownAAIfNeeded() {
        let rows = await q('SELECT address FROM aa_addresses ORDER BY address LIMIT 1');

        if (rows.length > 0)
                return rows[0].address;

        const seededAA = ['autonomous agent', {
                messages: [
                        {
                                app: 'data',
                                payload: {
                                        bh_seeded_known_aa_for_gate1_network_probe: 1
                                }
                        }
                ]
        }];

        const address = objectHash.getChash160(seededAA);

        await storage.insertAADefinitions(
                db,
                [{ address, definition: seededAA }],
                constants.GENESIS_UNIT,
                1,
                false
        );

        console.log('BH_GATE1_SEEDED_AA_FOR_FK', address);
        return address;
}

async function buildTamperedHistoryPayload() {
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

        if (candidateRows.length === 0)
                throw new Error('no canonical trigger unit candidate');

        const triggerUnit = candidateRows[0].unit;
        const mci = candidateRows[0].main_chain_index;

        const authorRows = await q(
                'SELECT address FROM unit_authors WHERE unit=? ORDER BY address LIMIT 1',
                [triggerUnit]
        );

        if (authorRows.length === 0)
                throw new Error('trigger unit has no author');

        const triggerAddress = authorRows[0].address;
        const fakeAAAddress = await seedKnownAAIfNeeded();

        const history = await withTimeout(prepareProviderHistory({
                witnesses,
                requested_joints: [triggerUnit]
        }), 15000, 'provider prepareHistory');

        if (!Array.isArray(history.joints) || !history.joints.some(j => j.unit && j.unit.unit === triggerUnit))
                throw new Error('provider history did not include trigger unit');

        const fakeAAResponse = {
                mci,
                trigger_address: triggerAddress,
                aa_address: fakeAAAddress,
                trigger_unit: triggerUnit,
                bounced: 0,
                response: JSON.stringify({
                        responseVars: {
                                bh_gate1_network_injected_response: 1
                        },
                        info: 'BH_GATE1_FAKE_NETWORK_LIGHT_HISTORY_AA_RESPONSE'
                }),
                creation_date: sqlDate()
        };

        history.aa_responses = [fakeAAResponse];

        return {
                witnesses,
                triggerUnit,
                triggerAddress,
                fakeAAAddress,
                fakeAAResponse,
                history
        };
}

function startControlledHistoryVendor(payload) {
        return new Promise((resolve, reject) => {
                const requests = [];
                const sockets = new Set();
                const server = new WebSocket.Server({
                        host: '127.0.0.1',
                        port: 0
                });

                server.on('error', reject);

                server.on('listening', () => {
                        const addr = server.address();
                        resolve({
                                server,
                                requests,
                                sockets,
                                url: `ws://127.0.0.1:${addr.port}`
                        });
                });

                server.on('connection', ws => {
                        sockets.add(ws);

                        ws.on('close', () => sockets.delete(ws));
                        ws.on('error', () => sockets.delete(ws));

                        ws.on('message', raw => {
                                let msg;
                                try {
                                        msg = JSON.parse(raw.toString());
                                }
                                catch (e) {
                                        console.log('BH_GATE1_VENDOR_BAD_JSON', raw.toString());
                                        return;
                                }

                                console.log('BH_GATE1_VENDOR_RX', JSON.stringify(msg).slice(0, 1000));

                                if (!Array.isArray(msg))
                                        return;

                                const type = msg[0];
                                const body = msg[1];

                                if (type !== 'request' || !body)
                                        return;

                                requests.push({
                                        command: body.command,
                                        params: body.params,
                                        tag: body.tag
                                });

                                if (body.command === 'heartbeat') {
                                        ws.send(JSON.stringify(['response', {
                                                tag: body.tag,
                                                response: 'sleep'
                                        }]));
                                        return;
                                }

                                if (body.command === 'subscribe') {
                                        ws.send(JSON.stringify(['response', {
                                                tag: body.tag,
                                                response: 'subscribed'
                                        }]));
                                        return;
                                }

                                if (body.command === 'get_peers') {
                                        ws.send(JSON.stringify(['response', {
                                                tag: body.tag,
                                                response: []
                                        }]));
                                        return;
                                }

                                if (body.command !== 'light/get_history') {
                                        ws.send(JSON.stringify(['response', {
                                                tag: body.tag,
                                                response: { error: 'BH controlled vendor only handles light/get_history' }
                                        }]));
                                        return;
                                }

                                console.log('BH_GATE1_VENDOR_HISTORY_REQUEST', JSON.stringify(body.params));

                                ws.send(JSON.stringify(['response', {
                                        tag: body.tag,
                                        response: payload.history
                                }]));
                        });
                });
        });
}

/*
 * Real Gate-1 ingress:
 * test -> network.requestHistoryFor()
 *      -> requestHistoryAfterMCI()
 *      -> requestFromLightVendor('light/get_history', ...)
 *      -> WebSocket request to controlled local vendor
 *      -> controlled local vendor returns tampered history response
 *      -> network callback calls light.processHistory()
 *
 * The test does not call light.processHistory() directly.
 */
async function requestHistoryThroughNetwork(payload) {
        const exported = Object.keys(network).sort();
        console.log('BH_GATE1_NETWORK_EXPORTS', JSON.stringify(exported));

        if (typeof network.requestHistoryFor !== 'function') {
                return {
                        ok: false,
                        status: 'gate1_killed_no_requestHistoryFor_export'
                };
        }

        const vendor = await startControlledHistoryVendor(payload);
        const oldLightVendorUrl = network.light_vendor_url;

        console.log('BH_GATE1_CONTROLLED_VENDOR_URL', vendor.url);

        network.light_vendor_url = vendor.url;

        try {
                const err = await withTimeout(
                        new Promise(resolve => {
                                network.requestHistoryFor([payload.triggerUnit], [], err => {
                                        resolve(err || null);
                                });
                        }),
                        30000,
                        'network.requestHistoryFor'
                );

                await new Promise(resolve => setTimeout(resolve, 250));

                const sawHistoryRequest = vendor.requests.some(req => req.command === 'light/get_history');

                console.log('BH_GATE1_VENDOR_REQUESTS', JSON.stringify(vendor.requests));
                console.log('BH_GATE1_NETWORK_REQUEST_ERROR', err || null);
                console.log('BH_GATE1_SAW_LIGHT_GET_HISTORY', sawHistoryRequest);

                if (!sawHistoryRequest) {
                        return {
                                ok: false,
                                status: 'gate1_killed_no_light_get_history_request_seen',
                                vendor_requests: vendor.requests
                        };
                }

                if (err) {
                        return {
                                ok: false,
                                status: 'gate1_killed_real_history_ingestion_rejected_metadata',
                                error: err,
                                vendor_requests: vendor.requests
                        };
                }

                return {
                        ok: true,
                        status: 'gate1_network_request_path_completed',
                        vendor_requests: vendor.requests
                };
        }
        catch (e) {
                return {
                        ok: false,
                        status: 'gate1_killed_network_request_exception',
                        error: e && e.stack ? e.stack : String(e),
                        vendor_requests: vendor.requests
                };
        }
        finally {
                network.light_vendor_url = oldLightVendorUrl;

                if (typeof network.closeAllWsConnections === 'function')
                        network.closeAllWsConnections();

                for (const ws of vendor.sockets) {
                        try {
                                ws.terminate();
                        }
                        catch (e) {
                        }
                }

                await new Promise(resolve => {
                        vendor.server.close(() => resolve());
                        setTimeout(resolve, 1000);
                });
        }
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
        console.log('***** bh_gate1_light_history_network_ingestion.test done');
});

test.serial('Gate 1: forged AA response metadata through real light-history network ingestion', async t => {
        const payload = await buildTamperedHistoryPayload();

        console.log('BH_GATE1_TRIGGER_UNIT', payload.triggerUnit);
        console.log('BH_GATE1_TRIGGER_ADDRESS', payload.triggerAddress);
        console.log('BH_GATE1_FAKE_AA_ADDRESS', payload.fakeAAAddress);
        console.log('BH_GATE1_FAKE_AA_RESPONSE', JSON.stringify(payload.fakeAAResponse));

        const emitted = [];
        const handler = objAAResponse => {
                if (
                        objAAResponse &&
                        objAAResponse.trigger_unit === payload.triggerUnit &&
                        objAAResponse.aa_address === payload.fakeAAAddress
                )
                        emitted.push(objAAResponse);
        };

        eventBus.on('aa_response', handler);

        let gateResult;
        try {
                gateResult = await requestHistoryThroughNetwork(payload);
        }
        finally {
                eventBus.removeListener('aa_response', handler);
        }

        if (!gateResult || gateResult.ok === false) {
                console.log('BH_RESULT', JSON.stringify(gateResult || {
                        ok: false,
                        status: 'gate1_killed_no_result'
                }));

                t.pass('Gate 1 not proven by this harness version');
                return;
        }

        const rows = await q(
                `SELECT aa_response_id, mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response
                 FROM aa_responses
                 WHERE trigger_unit=?
                   AND aa_address=?
                 ORDER BY aa_response_id`,
                [payload.triggerUnit, payload.fakeAAAddress]
        );

        const apiRows = await q(
                `SELECT mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response
                 FROM aa_responses
                 CROSS JOIN units ON trigger_unit=unit
                 WHERE aa_address=?
                 ORDER BY mci DESC, aa_response_id DESC
                 LIMIT 100`,
                [payload.fakeAAAddress]
        );

        const chainRows = await q(
                `SELECT mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response
                 FROM aa_responses
                 CROSS JOIN units ON trigger_unit=unit
                 WHERE trigger_unit=?
                 ORDER BY aa_address`,
                [payload.triggerUnit]
        );

        const apiVisible = apiRows.filter(row =>
                row.trigger_unit === payload.triggerUnit &&
                row.aa_address === payload.fakeAAAddress
        );

        const chainVisible = chainRows.filter(row =>
                row.trigger_unit === payload.triggerUnit &&
                row.aa_address === payload.fakeAAAddress
        );

        console.log('BH_GATE1_INSERTED_ROWS', JSON.stringify(rows));
        console.log('BH_GATE1_EMITTED_COUNT', emitted.length);
        console.log('BH_GATE1_GET_AA_RESPONSES_VISIBLE_COUNT', apiVisible.length);
        console.log('BH_GATE1_GET_AA_RESPONSE_CHAIN_VISIBLE_COUNT', chainVisible.length);

        const proven = rows.length > 0 && emitted.length > 0 && apiVisible.length > 0 && chainVisible.length > 0;

        console.log('BH_RESULT', JSON.stringify({
                ok: !proven,
                status: proven
                        ? 'gate1_network_light_history_injection_proven'
                        : 'gate1_network_light_history_injection_not_proven',
                inserted_rows: rows.length,
                emitted_events: emitted.length,
                get_aa_responses_rows: apiVisible.length,
                get_aa_response_chain_rows: chainVisible.length
        }));

        if (proven)
                t.fail('Gate 1 proven: forged AA response entered through real network light-history ingestion path');

        t.pass('Gate 1 not proven');
});
