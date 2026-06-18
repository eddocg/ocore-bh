/*
 * Gate 3: forged AA response from network light-history ingestion is forwarded
 * to a light client watching the AA/address.
 *
 * This tests downstream automated/API behavior inside network.js:
 *
 * eventBus.on('aa_response')
 * -> watched_light_aas lookup
 * -> aaResponseAffectsAddress()
 * -> sendJustsaying(ws, 'light/aa_response', objAAResponse)
 */

'use strict';

const shell = require('child_process').execSync;
const path = require('path');

process.env.devnet = 1;

const desktop_app = require('../desktop_app.js');

desktop_app.getAppDataDir = function () {
        return __dirname + '/.testdata-' + path.basename(__filename);
};

const SOURCE_FIXTURE_DIR = 'test/.testdata-bh_asset_rollback_persistent.test.js';
const TARGET_TRIGGER_UNIT = 'BvD/g11loi9UMjpWHT3g9zA391rkQHBSjtD+cRHU92U=';
const TARGET_AA_ADDRESS = 'GAZXTJRNXT6YYMUOKN76RTZQ23NO223W';
const TARGET_TRIGGER_ADDRESS = 'ZQFHJXFWT2OCEBXF26GFXJU4MPASWPJT';

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
                        console.log('BH_GATE3_READY_TIMEOUT', JSON.stringify({
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

function makeFakePeer() {
        const sent = [];

        return {
                peer: 'ws://bh-controlled-watching-light-client',
                host: 'bh-controlled-watching-light-client',
                readyState: 1,
                OPEN: 1,
                assocPendingRequests: {},
                assocCommandsInPreparingResponse: {},
                send(message, cb) {
                        sent.push(message);
                        console.log('BH_GATE3_FAKE_LIGHT_CLIENT_TX', message.slice(0, 1000));
                        if (cb)
                                cb();
                },
                close() {
                        this.readyState = 3;
                },
                sent
        };
}

async function registerWatchingLightClientPeer(peerUrl) {
        const host = peerUrl.replace(/^wss?:\/\//, '').replace(/[\/:].*$/, '');

        await q(
                'INSERT OR IGNORE INTO peer_hosts (peer_host) VALUES (?)',
                [host]
        );

        await q(
                'INSERT OR IGNORE INTO peers (peer_host, peer) VALUES (?,?)',
                [host, peerUrl]
        );

        await q(
                'INSERT OR IGNORE INTO watched_light_aas (peer, aa, address) VALUES (?,?,?)',
                [peerUrl, TARGET_AA_ADDRESS, TARGET_TRIGGER_ADDRESS]
        );

        console.log('BH_GATE3_REGISTERED_WATCHING_PEER', JSON.stringify({
                peer: peerUrl,
                host,
                aa: TARGET_AA_ADDRESS,
                address: TARGET_TRIGGER_ADDRESS
        }));
}

function primeLightVendorMode(peerUrl, payload) {
        return new Promise(resolve => {
                const host = peerUrl.replace(/^wss?:\/\//, '').replace(/[\/:].*$/, '');

                const fakeInboundLightClientWs = {
                        peer: peerUrl,
                        host,
                        readyState: 1,
                        OPEN: 1,
                        bOutbound: false,
                        assocPendingRequests: {},
                        assocCommandsInPreparingResponse: {},
                        send(message, cb) {
                                console.log('BH_GATE3_PRIME_WS_TX', message.slice(0, 1000));
                                if (cb)
                                        cb();
                        },
                        close() {
                                this.readyState = 3;
                        }
                };

                network.handleRequest(
                        fakeInboundLightClientWs,
                        'bh_gate3_prime_light_vendor_mode',
                        'light/get_history',
                        {
                                witnesses: payload.witnesses,
                                requested_joints: [TARGET_TRIGGER_UNIT]
                        }
                );

                setTimeout(resolve, 1000);
        });
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

        const history = await withTimeout(prepareProviderHistory({
                witnesses,
                requested_joints: [TARGET_TRIGGER_UNIT]
        }), 15000, 'provider prepareHistory');

        if (!Array.isArray(history.joints) || !history.joints.some(j => j.unit && j.unit.unit === TARGET_TRIGGER_UNIT))
                throw new Error('provider history did not include target trigger unit');

        const fakeAAResponse = {
                mci: unitRows[0].main_chain_index,
                trigger_address: TARGET_TRIGGER_ADDRESS,
                aa_address: TARGET_AA_ADDRESS,
                trigger_unit: TARGET_TRIGGER_UNIT,
                bounced: 0,
                response: JSON.stringify({
                        responseVars: {
                                ['bh_gate3_affects_' + TARGET_TRIGGER_ADDRESS]: 1
                        },
                        info: 'BH_GATE3_FAKE_FORWARDABLE_AA_RESPONSE'
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
                const justsayings = [];
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
                                justsayings,
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
                                        console.log('BH_GATE3_VENDOR_BAD_JSON', raw.toString());
                                        return;
                                }

                                console.log('BH_GATE3_VENDOR_RX', JSON.stringify(msg).slice(0, 1000));

                                if (!Array.isArray(msg))
                                        return;

                                const type = msg[0];
                                const body = msg[1];

                                if (type === 'justsaying') {
                                        justsayings.push(body);
                                        console.log('BH_GATE3_VENDOR_JUSTSAYING', JSON.stringify(body).slice(0, 1000));
                                        return;
                                }

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
                                                response: { error: 'BH Gate3 controlled vendor only handles light/get_history' }
                                        }]));
                                        return;
                                }

                                console.log('BH_GATE3_VENDOR_HISTORY_REQUEST', JSON.stringify(body.params));

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

        await registerWatchingLightClientPeer(vendor.url);
        await primeLightVendorMode(vendor.url, payload);

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

                await new Promise(resolve => setTimeout(resolve, 1500));

                const sawHistoryRequest = vendor.requests.some(req => req.command === 'light/get_history');
                const forwarded = vendor.justsayings.filter(body =>
                        body &&
                        body.subject === 'light/aa_response' &&
                        JSON.stringify(body).indexOf('BH_GATE3_FAKE_FORWARDABLE_AA_RESPONSE') >= 0
                );

                console.log('BH_GATE3_VENDOR_REQUESTS', JSON.stringify(vendor.requests));
                console.log('BH_GATE3_VENDOR_JUSTSAYINGS', JSON.stringify(vendor.justsayings));
                console.log('BH_GATE3_VENDOR_FORWARDED_LIGHT_AA_RESPONSE_COUNT', forwarded.length);
                console.log('BH_GATE3_NETWORK_REQUEST_ERROR', err || null);
                console.log('BH_GATE3_SAW_LIGHT_GET_HISTORY', sawHistoryRequest);

                return {
                        err,
                        sawHistoryRequest,
                        vendor_requests: vendor.requests,
                        vendor_justsayings: vendor.justsayings,
                        forwarded
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
        console.log('***** bh_gate3_light_aa_response_forwarding_from_network_history.test done');
});

test.serial('Gate 3: forged network-history AA response reaches downstream watched-AA forwarding predicate', async t => {
        const payload = await buildTamperedHistoryPayload();

        console.log('BH_GATE3_TRIGGER_UNIT', TARGET_TRIGGER_UNIT);
        console.log('BH_GATE3_TRIGGER_ADDRESS', TARGET_TRIGGER_ADDRESS);
        console.log('BH_GATE3_AA_ADDRESS', TARGET_AA_ADDRESS);
        console.log('BH_GATE3_FAKE_AA_RESPONSE', JSON.stringify(payload.fakeAAResponse));

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

        const watchRows = await q(
                'SELECT peer, aa, address FROM watched_light_aas WHERE aa=? AND address=?',
                [TARGET_AA_ADDRESS, TARGET_TRIGGER_ADDRESS]
        );

        const affectsPredicateHit = emitted.some(objAAResponse =>
                objAAResponse.response &&
                objAAResponse.response.responseVars &&
                Object.keys(objAAResponse.response.responseVars).some(k => k.indexOf(TARGET_TRIGGER_ADDRESS) >= 0)
        );

        const forwardedMessages = (
                networkResult &&
                Array.isArray(networkResult.forwarded)
        ) ? networkResult.forwarded : [];

        console.log('BH_GATE3_WATCH_ROWS', JSON.stringify(watchRows));
        console.log('BH_GATE3_INSERTED_ROWS', JSON.stringify(aaRows));
        console.log('BH_GATE3_EMITTED_COUNT', emitted.length);
        console.log('BH_GATE3_AFFECTS_PREDICATE_HIT', affectsPredicateHit);
        console.log('BH_GATE3_FORWARDED_MESSAGES', JSON.stringify(forwardedMessages));

        const predicateProven = (
                networkResult &&
                networkResult.sawHistoryRequest &&
                !networkResult.err &&
                aaRows.length > 0 &&
                emitted.length > 0 &&
                watchRows.length > 0 &&
                affectsPredicateHit
        );

        const forwardProven = predicateProven && forwardedMessages.length > 0;

        console.log('BH_RESULT', JSON.stringify({
                ok: !forwardProven,
                status: forwardProven
                        ? 'gate3_light_aa_response_forwarded_from_network_history'
                        : (
                                predicateProven
                                        ? 'gate3_forwarding_predicate_reached_from_network_history'
                                        : 'gate3_forwarding_not_reached_from_network_history'
                        ),
                saw_light_get_history: !!(networkResult && networkResult.sawHistoryRequest),
                network_error: networkResult ? networkResult.err : 'no network result',
                inserted_rows: aaRows.length,
                emitted_events: emitted.length,
                watch_rows: watchRows.length,
                predicate_hit: affectsPredicateHit,
                forwarded_messages: forwardedMessages.length
        }));

        if (forwardProven)
                t.fail('Gate 3 proven: forged network-history AA response was forwarded as light/aa_response');

        if (predicateProven)
                t.fail('Gate 3 predicate proven: forged network-history AA response reached watched-AA forwarding predicate');

        t.pass('Gate 3 not proven');
});
