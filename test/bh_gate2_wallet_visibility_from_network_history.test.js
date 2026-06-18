/*
 * Gate 2: wallet-visible forged AA response from proven network light-history ingestion.
 *
 * Preconditions:
 * - uses controlled local WebSocket light vendor
 * - calls network.requestHistoryFor()
 * - forged aa_responses enters through light/get_history response
 * - then wallet-equivalent lookup must see it for a real transaction payee AA
 */

'use strict';

const shell = require('child_process').execSync;
const path = require('path');

process.env.devnet = 1;

const desktop_app = require('../desktop_app.js');

desktop_app.getAppDataDir = function () {
        return __dirname + '/.testdata-' + path.basename(__filename);
};

/*
 * Replace these after bh_gate2_scan_wallet_candidate_fixtures.sh returns a candidate.
 */
const SOURCE_FIXTURE_DIR = 'test/.testdata-bh_asset_rollback_persistent.test.js';
const TARGET_TRIGGER_UNIT = 'bsKDooBCUYyoxddKUoGp1NUyKycrIcdVGfq3+77xWBc=';
const TARGET_AA_ADDRESS = 'GAZXTJRNXT6YYMUOKN76RTZQ23NO223W';

const dstDir = __dirname + '/.testdata-' + path.basename(__filename);

shell('rm -rf ' + dstDir);
shell('cp -r ' + SOURCE_FIXTURE_DIR + '/ ' + dstDir);

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

function withTimeout(promise, ms, label) {
        return Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms))
        ]);
}

function waitForStorageReady(cb) {
        const started = Date.now();

        function check() {
                const stableCount = Object.keys(storage.assocStableUnits || {}).length;
                const aaResponseReady = storage.last_aa_response_id !== null;

                if (stableCount > 0 && aaResponseReady)
                        return cb();

                if (Date.now() - started > 15000) {
                        console.log('BH_GATE2_READY_TIMEOUT', JSON.stringify({
                                stable_units: stableCount,
                                last_aa_response_id: storage.last_aa_response_id
                        }));
                        return cb();
                }

                setTimeout(check, 100);
        }

        check();
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

async function buildTamperedHistoryPayload() {
        const witnesses = storage.getOpList(Infinity);

        const unitRows = await q(
                `SELECT unit, main_chain_index
                 FROM units
                 WHERE unit=?
                   AND sequence='good'
                   AND main_chain_index IS NOT NULL`,
                [TARGET_TRIGGER_UNIT]
        );

        if (unitRows.length !== 1)
                throw new Error('target trigger unit is not canonical in fixture');

        const outputRows = await q(
                `SELECT amount
                 FROM outputs
                 WHERE unit=?
                   AND address=?`,
                [TARGET_TRIGGER_UNIT, TARGET_AA_ADDRESS]
        );

        if (outputRows.length === 0)
                throw new Error('target AA address is not a payee of target trigger unit');

        const authorRows = await q(
                'SELECT address FROM unit_authors WHERE unit=? ORDER BY address LIMIT 1',
                [TARGET_TRIGGER_UNIT]
        );

        if (authorRows.length === 0)
                throw new Error('target trigger unit has no author');

        const history = await withTimeout(prepareProviderHistory({
                witnesses,
                requested_joints: [TARGET_TRIGGER_UNIT]
        }), 15000, 'provider prepareHistory');

        if (!Array.isArray(history.joints) || !history.joints.some(j => j.unit && j.unit.unit === TARGET_TRIGGER_UNIT))
                throw new Error('provider history did not include target trigger unit');

        const fakeAAResponse = {
                mci: unitRows[0].main_chain_index,
                trigger_address: authorRows[0].address,
                aa_address: TARGET_AA_ADDRESS,
                trigger_unit: TARGET_TRIGGER_UNIT,
                bounced: 0,
                response: JSON.stringify({
                        responseVars: {
                                bh_gate2_wallet_visible_response: 1
                        },
                        info: 'BH_GATE2_FAKE_WALLET_VISIBLE_AA_RESPONSE'
                }),
                creation_date: sqlDate()
        };

        history.aa_responses = [fakeAAResponse];

        return {
                witnesses,
                history,
                fakeAAResponse
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
                                        console.log('BH_GATE2_VENDOR_BAD_JSON', raw.toString());
                                        return;
                                }

                                console.log('BH_GATE2_VENDOR_RX', JSON.stringify(msg).slice(0, 1000));

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
                                        ws.send(JSON.stringify(['response', { tag: body.tag, response: 'sleep' }]));
                                        return;
                                }

                                if (body.command === 'subscribe') {
                                        ws.send(JSON.stringify(['response', { tag: body.tag, response: 'subscribed' }]));
                                        return;
                                }

                                if (body.command === 'get_peers') {
                                        ws.send(JSON.stringify(['response', { tag: body.tag, response: [] }]));
                                        return;
                                }

                                if (body.command !== 'light/get_history') {
                                        ws.send(JSON.stringify(['response', {
                                                tag: body.tag,
                                                response: { error: 'BH Gate2 controlled vendor only handles light/get_history' }
                                        }]));
                                        return;
                                }

                                console.log('BH_GATE2_VENDOR_HISTORY_REQUEST', JSON.stringify(body.params));

                                ws.send(JSON.stringify(['response', {
                                        tag: body.tag,
                                        response: payload.history
                                }]));
                        });
                });
        });
}

async function ingestThroughNetwork(payload) {
        const vendor = await startControlledHistoryVendor(payload);
        const oldLightVendorUrl = network.light_vendor_url;

        network.light_vendor_url = vendor.url;

        try {
                const err = await withTimeout(
                        new Promise(resolve => {
                                network.requestHistoryFor([TARGET_TRIGGER_UNIT], [], err => {
                                        resolve(err || null);
                                });
                        }),
                        30000,
                        'network.requestHistoryFor'
                );

                await new Promise(resolve => setTimeout(resolve, 250));

                const sawHistoryRequest = vendor.requests.some(req => req.command === 'light/get_history');

                console.log('BH_GATE2_VENDOR_REQUESTS', JSON.stringify(vendor.requests));
                console.log('BH_GATE2_NETWORK_REQUEST_ERROR', err || null);
                console.log('BH_GATE2_SAW_LIGHT_GET_HISTORY', sawHistoryRequest);

                return {
                        err,
                        sawHistoryRequest,
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
        waitForStorageReady(() => t.end());
});

test.after.always.cb(t => {
        db.close(t.end);
        console.log('***** bh_gate2_wallet_visibility_from_network_history.test done');
});

test.serial('Gate 2: forged AA response becomes wallet-query-visible after network light-history ingestion', async t => {
        const payload = await buildTamperedHistoryPayload();

        console.log('BH_GATE2_TRIGGER_UNIT', TARGET_TRIGGER_UNIT);
        console.log('BH_GATE2_AA_ADDRESS', TARGET_AA_ADDRESS);
        console.log('BH_GATE2_FAKE_AA_RESPONSE', JSON.stringify(payload.fakeAAResponse));

        const emitted = [];
        const handler = objAAResponse => {
                if (
                        objAAResponse &&
                        objAAResponse.trigger_unit === TARGET_TRIGGER_UNIT &&
                        objAAResponse.aa_address === TARGET_AA_ADDRESS
                )
                        emitted.push(objAAResponse);
        };

        eventBus.on('aa_response', handler);

        let networkResult;

        try {
                networkResult = await ingestThroughNetwork(payload);
        }
        finally {
                eventBus.removeListener('aa_response', handler);
        }

        const aaRows = await q(
                `SELECT aa_response_id, mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response
                 FROM aa_responses
                 WHERE trigger_unit=?
                   AND aa_address=?
                 ORDER BY aa_response_id`,
                [TARGET_TRIGGER_UNIT, TARGET_AA_ADDRESS]
        );

        /*
         * Exact wallet.js consumer query shape:
         * SELECT bounced, response, response_unit
         * FROM aa_responses
         * WHERE trigger_unit=? AND aa_address=?
         */
        const walletRows = await q(
                `SELECT bounced, response, response_unit
                 FROM aa_responses
                 WHERE trigger_unit=?
                   AND aa_address=?`,
                [TARGET_TRIGGER_UNIT, TARGET_AA_ADDRESS]
        );

        const forgedWalletRows = walletRows.filter(row =>
                row.response && row.response.indexOf('BH_GATE2_FAKE_WALLET_VISIBLE_AA_RESPONSE') >= 0
        );

        console.log('BH_GATE2_INSERTED_ROWS', JSON.stringify(aaRows));
        console.log('BH_GATE2_EMITTED_COUNT', emitted.length);
        console.log('BH_GATE2_WALLET_EQUIVALENT_ROWS', JSON.stringify(walletRows));
        console.log('BH_GATE2_WALLET_FORGED_VISIBLE_COUNT', forgedWalletRows.length);

        const proven = (
                networkResult &&
                networkResult.sawHistoryRequest &&
                !networkResult.err &&
                aaRows.length > 0 &&
                emitted.length > 0 &&
                forgedWalletRows.length > 0
        );

        console.log('BH_RESULT', JSON.stringify({
                ok: !proven,
                status: proven
                        ? 'gate2_wallet_query_visible_from_network_history'
                        : 'gate2_wallet_query_not_visible_from_network_history',
                saw_light_get_history: !!(networkResult && networkResult.sawHistoryRequest),
                network_error: networkResult ? networkResult.err : 'no network result',
                inserted_rows: aaRows.length,
                emitted_events: emitted.length,
                wallet_forged_rows: forgedWalletRows.length
        }));

        if (proven)
                t.fail('Gate 2 proven: wallet-equivalent lookup sees forged AA response inserted through network light-history ingestion');

        t.pass('Gate 2 not proven');
});
