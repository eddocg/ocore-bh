var shell = require('child_process').execSync;
var path = require('path');

process.env.devnet = 1;

var constants = require("../constants.js");
var objectHash = require("../object_hash.js");
var desktop_app = require('../desktop_app.js');

desktop_app.getAppDataDir = function () {
        return __dirname + '/.testdata-' + path.basename(__filename);
};

var src_dir = __dirname + '/initial-testdata-aa_composer.test.js';
var dst_dir = __dirname + '/.testdata-' + path.basename(__filename);

shell('rm -rf ' + dst_dir);
shell('cp -r ' + src_dir + '/ ' + dst_dir);

var db = require('../db.js');
var kvstore = require('../kvstore.js');
var aa_validation = require('../aa_validation.js');
var aa_composer = require('../aa_composer.js');
var storage = require('../storage.js');
var eventBus = require('../event_bus.js');
var network = require('../network.js');
var objectHash = require('../object_hash.js');
var test = require('ava');

process.on('unhandledRejection', up => { throw up; });

function readGetterProps(aa_address, func_name, cb) {
        storage.readAAGetterProps(db, aa_address, func_name, null, cb);
}

function validateAA(aa) {
        return new Promise(resolve => {
                aa_validation.validateAADefinition(aa, readGetterProps, Number.MAX_SAFE_INTEGER, resolve);
        });
}

async function addAA(aa) {
        var address = objectHash.getChash160(aa);
        await db.query("INSERT " + db.getIgnore() + " INTO addresses (address) VALUES(?)", [address]);
        await storage.insertAADefinitions(db, [{ address, definition: aa }], constants.GENESIS_UNIT, 1, false);
        return address;
}

function takeConn() {
        return new Promise(resolve => db.takeConnectionFromPool(resolve));
}

function q(conn, sql, params) {
        return new Promise((resolve, reject) => {
                try {
                        if (params)
                                conn.query(sql, params, resolve);
                        else
                                conn.query(sql, resolve);
                }
                catch (e) {
                        reject(e);
                }
        });
}

function readLastStableMcUnit(conn) {
        return new Promise(async (resolve, reject) => {
                var rows = await q(conn, "SELECT unit, main_chain_index FROM units WHERE +is_on_main_chain=1 AND +is_stable=1 ORDER BY main_chain_index DESC LIMIT 1");
                if (rows.length !== 1)
                        return reject(Error("expected one stable MC unit, got " + rows.length));

                storage.readJoint(conn, rows[0].unit, {
                        ifNotFound: function () {
                                reject(Error("MC unit not found: " + rows[0].unit));
                        },
                        ifFound: function (objJoint) {
                                resolve({
                                        mci: rows[0].main_chain_index,
                                        objMcUnit: objJoint.unit
                                });
                        }
                });
        });
}

async function runPersistentTrigger(trigger, address, aa) {
        var conn = await takeConn();

        return new Promise(async (resolve, reject) => {
                try {
                        await q(conn, "BEGIN");

                        var batch = kvstore.batch();
                        var mc = await readLastStableMcUnit(conn);
                        var objMcUnit = mc.objMcUnit;
                        var mci = mc.mci;

                        trigger.unit = constants.GENESIS_UNIT;
                        trigger.initial_address = trigger.address;
                        trigger.initial_unit = trigger.unit;

                        var message_index = objMcUnit.messages.length;

                        await q(
                                conn,
                                "INSERT INTO outputs (unit, message_index, output_index, asset, address, amount) VALUES(?, ?, 0, NULL, ?, ?)",
                                [objMcUnit.unit, message_index, address, trigger.outputs.base]
                        );

                        var arrResponses = [];

                        aa_composer.handleTrigger(
                                conn,
                                batch,
                                trigger,
                                {},
                                {},
                                aa,
                                address,
                                mci,
                                objMcUnit,
                                false,
                                arrResponses,
                                function () {
                                        batch.write(function (err) {
                                                if (err) {
                                                        return conn.query("ROLLBACK", function () {
                                                                conn.release();
                                                                reject(err);
                                                        });
                                                }

                                                conn.query("COMMIT", function () {
                                                        conn.release();
                                                        resolve(arrResponses);
                                                });
                                        });
                                }
                        );
                }
                catch (e) {
                        conn.query("ROLLBACK", function () {
                                conn.release();
                                reject(e);
                        });
                }
        });
}

function waitTick() {
        return new Promise(resolve => setImmediate(resolve));
}

async function countAADefinition(address) {
        var rows = await db.query("SELECT COUNT(*) AS count FROM aa_addresses WHERE address=?", [address]);
        return rows[0].count;
}

test.before.cb(t => {
        db.query("INSERT INTO units (unit, headers_commission, payload_commission) VALUES(?, 0, 0)", [constants.GENESIS_UNIT]);
        eventBus.once('caches_ready', () => {
                t.end();
        });
});

test.after.always.cb(t => {
        db.close(t.end);
        console.log('***** bh_no_definition_rollback_cache_crash_probe.test done');
});

test.serial('rollback cache crash probe without AA definition message', async t => {
        var trigger_address = "TU3Q44S6H2WXTGQO6BZAGWFKKJCF7Q3W";

        var secondary_aa = ['autonomous agent', {
                bounce_fees: { base: 10000 },
                init: `{
                        bounce("BH deterministic bounce after no-definition rollback probe");
                }`,
                messages: [
                        {
                                app: 'payment',
                                payload: {
                                        asset: 'base',
                                        outputs: [
                                                { address: "{trigger.address}", amount: 1000 }
                                        ]
                                }
                        }
                ]
        }];

        var err = await validateAA(secondary_aa);
        t.deepEqual(err, null);

        var secondary_address = await addAA(secondary_aa);

        var primary_aa = ['autonomous agent', {
                bounce_fees: { base: 10000 },
                messages: [
                        {
                                app: 'data',
                                payload: {
                                        bh_probe_no_definition: 1
                                }
                        },
                        {
                                app: 'payment',
                                payload: {
                                        asset: 'base',
                                        outputs: [
                                                { address: secondary_address, amount: 30000 }
                                        ]
                                }
                        }
                ]
        }];

        err = await validateAA(primary_aa);
        t.deepEqual(err, null);

        var primary_address = await addAA(primary_aa);


        var trigger = {
                outputs: { base: 50000 },
                data: { x: 777 },
                address: trigger_address
        };

        var arrResponses = await runPersistentTrigger(trigger, primary_address, primary_aa);
        await waitTick();


        t.is(arrResponses.length, 1);
        t.is(arrResponses[0].aa_address, primary_address);
        t.is(arrResponses[0].bounced, true);
        t.truthy(arrResponses[0].response.error);

});
