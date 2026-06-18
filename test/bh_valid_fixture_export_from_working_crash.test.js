/*
 * BH valid restart fixture exporter.
 *
 * This exporter intentionally mirrors
 * test/bh_no_definition_rollback_cache_crash_probe.test.js up to, but not
 * including, aa_composer.handleAATriggers().  The source probe prepares its
 * trigger by inserting a fake SQL output into the last stable MC unit and then
 * calls aa_composer.handleTrigger() directly with an in-memory trigger object.
 * That is a valid in-process crash probe, but it is not a replayable fresh
 * process trigger unit because the unit object has no payment message to the
 * AA.  Creating such a message would synthesize a different unit, and appending
 * one to the canonical unit is explicitly forbidden.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const shell = require('child_process').execSync;
const test = require('ava');

process.env.devnet = 1;

const constants = require('../constants.js');
const objectHash = require('../object_hash.js');
const desktop_app = require('../desktop_app.js');

const SOURCE_TEST = path.join(__dirname, 'bh_no_definition_rollback_cache_crash_probe.test.js');
const sourceDataDir = path.join(__dirname, 'initial-testdata-aa_composer.test.js');
const exportDir = process.env.BH_VALID_FIXTURE_DIR || path.join('/tmp', 'ocore-impact-proof', 'bh-valid-fixture-export');
const metaPath = path.join(exportDir, 'bh_valid_restart_fixture.json');

shell('rm -rf ' + JSON.stringify(exportDir));
shell('cp -r ' + JSON.stringify(sourceDataDir) + '/ ' + JSON.stringify(exportDir));

desktop_app.getAppDataDir = function () {
	return exportDir;
};

const db = require('../db.js');
const kvstore = require('../kvstore.js');
const aa_validation = require('../aa_validation.js');
const aa_composer = require('../aa_composer.js');
const storage = require('../storage.js');
const eventBus = require('../event_bus.js');
require('../network.js');

process.on('unhandledRejection', up => { throw up; });

function writeJson(file, obj) {
	fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

async function snapshot(name, sql, params) {
	const rows = await db.query(sql, params || []);
	writeJson(path.join(exportDir, name), rows);
	return rows;
}

function readGetterProps(aa_address, func_name, cb) {
	storage.readAAGetterProps(db, aa_address, func_name, null, cb);
}

function validateAA(aa) {
	return new Promise(resolve => {
		aa_validation.validateAADefinition(aa, readGetterProps, Number.MAX_SAFE_INTEGER, resolve);
	});
}

async function addAA(aa) {
	const address = objectHash.getChash160(aa);
	await db.query('INSERT ' + db.getIgnore() + ' INTO addresses (address) VALUES(?)', [address]);
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
		const rows = await q(conn, 'SELECT unit, main_chain_index FROM units WHERE +is_on_main_chain=1 AND +is_stable=1 ORDER BY main_chain_index DESC LIMIT 1');
		if (rows.length !== 1)
			return reject(Error('expected one stable MC unit, got ' + rows.length));
		storage.readJoint(conn, rows[0].unit, {
			ifNotFound: function () { reject(Error('MC unit not found: ' + rows[0].unit)); },
			ifFound: function (objJoint) { resolve({ mci: rows[0].main_chain_index, objMcUnit: objJoint.unit }); }
		});
	});
}

async function preparePersistentTrigger(trigger, address) {
	const conn = await takeConn();
	try {
		await q(conn, 'BEGIN');
		const mc = await readLastStableMcUnit(conn);
		const objMcUnit = mc.objMcUnit;
		const message_index = objMcUnit.messages.length;

		trigger.unit = constants.GENESIS_UNIT;
		trigger.initial_address = trigger.address;
		trigger.initial_unit = trigger.unit;

		await q(conn, 'INSERT INTO outputs (unit, message_index, output_index, asset, address, amount) VALUES(?, ?, 0, NULL, ?, ?)', [objMcUnit.unit, message_index, address, trigger.outputs.base]);
		await q(conn, 'INSERT INTO aa_triggers (mci, unit, address) VALUES(?, ?, ?)', [mc.mci, trigger.unit, address]);
		await q(conn, 'COMMIT');
		conn.release();
		return { mci: mc.mci, mc_unit: objMcUnit.unit, trigger_unit: trigger.unit, fake_output_message_index: message_index };
	}
	catch (e) {
		await q(conn, 'ROLLBACK').catch(() => {});
		conn.release();
		throw e;
	}
}

test.before.cb(t => {
	db.query('INSERT INTO units (unit, headers_commission, payload_commission) VALUES(?, 0, 0)', [constants.GENESIS_UNIT]);
	eventBus.once('caches_ready', () => t.end());
});

test.after.always.cb(t => {
	db.close(t.end);
	console.log('***** bh_valid_fixture_export_from_working_crash.test done');
});

test.serial('BH export valid fixture from working AA rollback crash path', async t => {
	t.true(fs.existsSync(SOURCE_TEST), 'source crash probe must exist');

	const trigger_address = 'TU3Q44S6H2WXTGQO6BZAGWFKKJCF7Q3W';
	const secondary_aa = ['autonomous agent', {
		bounce_fees: { base: 10000 },
		init: `{
			bounce("BH deterministic bounce after no-definition rollback probe");
		}`,
		messages: [{
			app: 'payment',
			payload: { asset: 'base', outputs: [{ address: '{trigger.address}', amount: 1000 }] }
		}]
	}];

	let err = await validateAA(secondary_aa);
	t.deepEqual(err, null);
	const secondary_address = await addAA(secondary_aa);

	const primary_aa = ['autonomous agent', {
		bounce_fees: { base: 10000 },
		messages: [
			{ app: 'data', payload: { bh_probe_no_definition: 1 } },
			{ app: 'payment', payload: { asset: 'base', outputs: [{ address: secondary_address, amount: 30000 }] } }
		]
	}];

	err = await validateAA(primary_aa);
	t.deepEqual(err, null);
	const primary_address = await addAA(primary_aa);

	const trigger = { outputs: { base: 50000 }, data: { x: 777 }, address: trigger_address };
	const prepared = await preparePersistentTrigger(trigger, primary_address);

	const meta = {
		ok: false,
		status: 'restart_escalation_killed',
		reason: 'Source probe trigger is prepared as an in-memory trigger plus a fake SQL output on an existing MC unit, then processed by handleTrigger() directly. Fresh-process handleAATriggers() reconstructs triggers from the persisted unit messages; the canonical trigger unit has no payment output message to the primary AA. Replaying it would hit malformed-fixture markers such as "no outputs" unless we synthesize or append unit messages, which is forbidden.',
		source_test: SOURCE_TEST,
		source_data_dir: sourceDataDir,
		export_dir: exportDir,
		primary_address,
		secondary_address,
		trigger_address,
		trigger,
		prepared,
		stopped_before: 'aa_composer.handleAATriggers()',
		created_at: new Date().toISOString()
	};
	writeJson(metaPath, meta);

	await snapshot('aa_triggers.snapshot.json', 'SELECT * FROM aa_triggers ORDER BY mci, unit, address');
	await snapshot('aa_responses.snapshot.json', 'SELECT * FROM aa_responses ORDER BY aa_response_id');
	await snapshot('trigger_units.snapshot.json', 'SELECT * FROM units WHERE unit=?', [prepared.trigger_unit]);
	await snapshot('trigger_unit_authors.snapshot.json', 'SELECT * FROM unit_authors WHERE unit=? ORDER BY address', [prepared.trigger_unit]);
	await snapshot('trigger_unit_messages.snapshot.json', 'SELECT * FROM messages WHERE unit=? ORDER BY message_index', [prepared.trigger_unit]);
	await snapshot('outputs_to_triggered_aa.snapshot.json', 'SELECT * FROM outputs WHERE address=? ORDER BY unit, message_index, output_index', [primary_address]);
	await snapshot('response_units.snapshot.json', 'SELECT * FROM units WHERE is_aa_response=1 ORDER BY main_chain_index, unit');

	console.log('BH_VALID_FIXTURE_EXPORT_DIR', exportDir);
	console.log('BH_VALID_FIXTURE_EXPORT_META', metaPath);
	console.log('BH_VALID_FIXTURE_EXPORT_DONE', JSON.stringify(meta));
	t.pass();
});
