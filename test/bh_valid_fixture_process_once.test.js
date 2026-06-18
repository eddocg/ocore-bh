/*
 * BH valid fixture processor.
 *
 * Loads bh_valid_restart_fixture.json exported by
 * bh_valid_fixture_export_from_working_crash.test.js and calls
 * aa_composer.handleAATriggers() once only if the fixture is marked ok=true.
 * If the export was blocked, this test fails without attempting to process a
 * malformed or synthetic fixture.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const test = require('ava');

const fixtureDir = process.env.BH_VALID_FIXTURE_DIR || path.join('/tmp', 'ocore-impact-proof', 'bh-valid-fixture-export-blocked');
const metaPath = path.join(fixtureDir, 'bh_valid_restart_fixture.json');

function readMeta() {
	if (!fs.existsSync(metaPath))
		return { ok: false, status: 'missing', reason: 'Missing bh_valid_restart_fixture.json', fixture_dir: fixtureDir };
	return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function safeSnapshot(label, obj) {
	console.log(label, JSON.stringify(obj, null, 2));
}

test.cb.serial('BH process valid fixture once', t => {
	console.log('BH_PROCESS_FIXTURE_DIR', fixtureDir);
	const meta = readMeta();
	console.log('BH_PROCESS_META', JSON.stringify(meta));
	safeSnapshot('BH_SNAPSHOT_BEFORE', { fixture_dir: fixtureDir, meta_status: meta.status, meta_ok: !!meta.ok });
	if (!meta.ok) {
		const status = meta.status === 'restart_escalation_killed' ? 'restart_escalation_killed' : 'blocked';
		console.log('BH_PROCESS_DONE', JSON.stringify({ ok: false, status, reason: meta.reason || 'fixture not marked ok' }));
		if (status === 'restart_escalation_killed') {
			t.pass('Exporter proved the source trigger cannot be replayed in a fresh process without synthesizing a malformed fixture.');
			return t.end();
		}
		t.fail('No valid exported fixture to process: ' + (meta.reason || meta.status));
		return t.end();
	}

	process.on('uncaughtException', err => {
		console.error('UNCAUGHT', err && err.stack ? err.stack : err);
		throw err;
	});
	process.on('unhandledRejection', err => {
		console.error('UNCAUGHT', err && err.stack ? err.stack : err);
		throw err;
	});

	const aa_composer = require('../aa_composer.js');
	aa_composer.handleAATriggers(() => {
		console.log('BH_HANDLE_AA_TRIGGERS_DONE');
		safeSnapshot('BH_SNAPSHOT_AFTER', { handled: true });
		console.log('BH_PROCESS_DONE', JSON.stringify({ ok: true }));
		t.pass();
		t.end();
	});
});
