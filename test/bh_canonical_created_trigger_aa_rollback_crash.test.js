/*
 * BH canonical-created AA-trigger rollback/cache crash probe.
 *
 * This probe investigates whether repo test helpers can create a new canonical
 * payment unit to an AA through normal wallet/composer/writer code and then
 * replay it with aa_composer.handleAATriggers().  It intentionally does not
 * mutate outputs/messages SQL, append to existing units, or call handleTrigger()
 * directly.  If the normal creation path cannot be assembled from available
 * fixture wallet data and signing helpers, the path is marked killed.
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

async function inspectNormalCreationInputs() {
	const wallets = await db.query('SELECT wallet FROM wallets ORDER BY wallet');
	const myAddresses = await db.query('SELECT address, wallet, account, is_change, address_index, definition FROM my_addresses ORDER BY address');
	const spendableOutputs = await db.query(
		`SELECT outputs.unit, outputs.message_index, outputs.output_index, outputs.address, outputs.amount
		FROM outputs
		JOIN my_addresses ON outputs.address=my_addresses.address
		WHERE outputs.asset IS NULL AND outputs.is_spent=0
		ORDER BY outputs.amount DESC`
	);
	const signingPaths = await db.query('SELECT wallet, signing_path, device_address FROM wallet_signing_paths ORDER BY wallet, signing_path');
	return { wallets, myAddresses, spendableOutputs, signingPaths };
}

function hasLocalPrivateKeyHelper(inputs) {
	/*
	 * wallet/composer can create and save a canonical payment unit only if the
	 * test supplies signWithLocalPrivateKey for the fixture address.  The AA
	 * composer fixture contains funded wallet metadata and xpub/signing path
	 * rows, but it does not include a private-key fixture or helper that can sign
	 * for the existing funded address.  Guessing or bypassing the signature would
	 * leave the normal validation/writer path.
	 */
	return inputs.myAddresses.some(row => row.sign_with_local_private_key_helper === true);
}

function handleAATriggers() {
	return new Promise(resolve => {
		aa_composer.handleAATriggers(() => resolve());
	});
}

test.before.cb(t => {
	db.query('INSERT INTO units (unit, headers_commission, payload_commission) VALUES(?, 0, 0)', [constants.GENESIS_UNIT]);
	eventBus.once('caches_ready', () => t.end());
});

test.after.always.cb(t => {
	db.close(t.end);
	console.log('***** bh_canonical_created_trigger_aa_rollback_crash.test done');
});

test.serial('canonical-created AA trigger attempts rollback/cache crash', async t => {
	const secondaryAA = ['autonomous agent', {
		bounce_fees: { base: 10000 },
		init: `{
			bounce("BH deterministic bounce from canonical-created trigger path");
		}`,
		messages: [{ app: 'payment', payload: { asset: 'base', outputs: [{ address: '{trigger.address}', amount: 1000 }] } }]
	}];
	let err = await validateAA(secondaryAA);
	t.deepEqual(err, null);
	const secondaryAddress = await addAA(secondaryAA);

	const primaryAA = ['autonomous agent', {
		bounce_fees: { base: 10000 },
		messages: [
			{ app: 'data', payload: { bh_canonical_created_trigger_primary_response: 1 } },
			{ app: 'payment', payload: { asset: 'base', outputs: [{ address: secondaryAddress, amount: 30000 }] } }
		]
	}];
	err = await validateAA(primaryAA);
	t.deepEqual(err, null);
	const primaryAddress = await addAA(primaryAA);

	console.log('BH_PRIMARY_AA', primaryAddress);
	console.log('BH_SECONDARY_AA', secondaryAddress);

	const inputs = await inspectNormalCreationInputs();
	if (!hasLocalPrivateKeyHelper(inputs)) {
		console.log('BH_CANONICAL_TRIGGER_UNIT', null);
		await handleAATriggers();
		console.log('BH_RESULT', JSON.stringify({
			ok: false,
			status: 'canonical_created_trigger_path_killed',
			reason: 'The fixture has funded wallet/address metadata but no normal test helper or private-key fixture that can sign a new wallet/composer payment unit to the primary AA. Creating the trigger would require SQL mutation, signature bypass, direct writer state fabrication, or direct handleTrigger(), all forbidden.',
			wallets: inputs.wallets.length,
			my_addresses: inputs.myAddresses.length,
			spendable_outputs: inputs.spendableOutputs.length,
			signing_paths: inputs.signingPaths.length
		}));
		t.pass('normal canonical trigger creation path is killed without a signer/helper');
		return;
	}

	throw Error('Unexpected signer helper discovered; implement composer/wallet payment creation here before claiming impact.');
});
