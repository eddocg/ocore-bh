/*
 * BH valid AA-trigger rollback/cache crash probe.
 *
 * The previous no-definition probe is diagnostic only because it calls
 * handleTrigger() directly with an in-memory trigger and a fake SQL output.
 * This probe refuses to create a fake trigger unit.  It first searches the
 * canonical AA composer fixture for an already-valid trigger unit that can be
 * replayed through aa_composer.handleAATriggers().  If none exists, it records a
 * killed result and runs handleAATriggers() against the empty trigger queue only
 * to prove that no malformed fixture was processed.
 */
'use strict';

const path = require('path');
const shell = require('child_process').execSync;
const test = require('ava');

process.env.devnet = 1;

const constants = require('../constants.js');
const objectHash = require('../object_hash.js');
const desktop_app = require('../desktop_app.js');

desktop_app.getAppDataDir = function () {
	return path.join(__dirname, '.testdata-' + path.basename(__filename));
};

const srcDir = path.join(__dirname, 'initial-testdata-aa_composer.test.js');
const dstDir = desktop_app.getAppDataDir();
shell('rm -rf ' + JSON.stringify(dstDir));
shell('cp -r ' + JSON.stringify(srcDir) + '/ ' + JSON.stringify(dstDir));

const db = require('../db.js');
const aa_validation = require('../aa_validation.js');
const aa_composer = require('../aa_composer.js');
const storage = require('../storage.js');
const eventBus = require('../event_bus.js');
require('../network.js');

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
	const address = objectHash.getChash160(aa);
	await db.query('INSERT ' + db.getIgnore() + ' INTO addresses (address) VALUES(?)', [address]);
	await storage.insertAADefinitions(db, [{ address, definition: aa }], constants.GENESIS_UNIT, 1, false);
	return address;
}

async function findCanonicalTriggerUnit(primaryAddress) {
	return db.query(
		`SELECT units.unit, units.main_chain_index AS mci, unit_authors.address AS author_address, messages.message_index, outputs.output_index, outputs.amount
		FROM units
		JOIN unit_authors USING(unit)
		JOIN messages USING(unit)
		JOIN outputs USING(unit, message_index)
		WHERE messages.app='payment' AND outputs.address=?
		ORDER BY units.main_chain_index, units.level, units.unit, messages.message_index, outputs.output_index
		LIMIT 1`,
		[primaryAddress]
	);
}

async function queueExistingCanonicalTrigger(row, primaryAddress) {
	await db.query('INSERT INTO aa_triggers (mci, unit, address) VALUES(?, ?, ?)', [row.mci, row.unit, primaryAddress]);
}

function handleAATriggers() {
	return new Promise(resolve => {
		console.log('BH_HANDLE_AA_TRIGGERS_START');
		aa_composer.handleAATriggers(() => {
			console.log('BH_HANDLE_AA_TRIGGERS_DONE');
			resolve();
		});
	});
}

test.before.cb(t => {
	db.query('INSERT INTO units (unit, headers_commission, payload_commission) VALUES(?, 0, 0)', [constants.GENESIS_UNIT]);
	eventBus.once('caches_ready', () => t.end());
});

test.after.always.cb(t => {
	db.close(t.end);
	console.log('***** bh_valid_trigger_aa_rollback_crash.test done');
});

test.serial('valid AA trigger path attempts no-definition rollback/cache crash', async t => {
	console.log('BH_VALID_TRIGGER_PATH', 'canonical fixture unit with payment output to AA + aa_composer.handleAATriggers, or killed if absent');
	const secondaryAA = ['autonomous agent', {
		bounce_fees: { base: 10000 },
		init: `{
			bounce("BH deterministic bounce from valid trigger path");
		}`,
		messages: [{ app: 'payment', payload: { asset: 'base', outputs: [{ address: '{trigger.address}', amount: 1000 }] } }]
	}];
	let err = await validateAA(secondaryAA);
	t.deepEqual(err, null);
	const secondaryAddress = await addAA(secondaryAA);

	const primaryAA = ['autonomous agent', {
		bounce_fees: { base: 10000 },
		messages: [
			{ app: 'data', payload: { bh_valid_trigger_primary_response: 1 } },
			{ app: 'payment', payload: { asset: 'base', outputs: [{ address: secondaryAddress, amount: 30000 }] } }
		]
	}];
	err = await validateAA(primaryAA);
	t.deepEqual(err, null);
	const primaryAddress = await addAA(primaryAA);
	console.log('BH_PRIMARY_AA', primaryAddress);
	console.log('BH_SECONDARY_AA', secondaryAddress);

	const rows = await findCanonicalTriggerUnit(primaryAddress);
	if (rows.length === 0) {
		console.log('BH_TRIGGER_UNIT', null);
		await handleAATriggers();
		console.log('BH_RESULT', JSON.stringify({
			ok: false,
			status: 'valid_trigger_path_killed',
			reason: 'No existing canonical fixture unit pays to the newly-created primary AA address. Creating one here would require a synthetic/fake trigger unit, which is forbidden; direct handleTrigger() remains diagnostic only.'
		}));
		t.pass('no valid replayable trigger helper exists in the current fixture for this AA path');
		return;
	}

	const trigger = rows[0];
	console.log('BH_TRIGGER_UNIT', trigger.unit);
	await queueExistingCanonicalTrigger(trigger, primaryAddress);
	try {
		await handleAATriggers();
		const aaResponses = await db.query('SELECT aa_response_id, aa_address, trigger_unit, bounced, response_unit, response FROM aa_responses ORDER BY aa_response_id');
		console.log('BH_RESULT', JSON.stringify({ ok: true, crashed: false, responses: aaResponses.length, aa_responses: aaResponses }));
		t.pass('valid trigger path reached normal AA handling without stale-cache crash');
	}
	catch (e) {
		const message = e && e.stack ? e.stack : String(e);
		console.log('BH_RESULT', JSON.stringify({ ok: false, crashed: true, error: message }));
		if (/different props|no outputs|unit not found/.test(message))
			console.log(message);
		throw e;
	}
});
