/*
 * BH valid restart fixture exporter.
 *
 * This test is intentionally blocked in this checkout because the requested
 * source probe, test/bh_no_definition_rollback_cache_crash_probe.test.js, is
 * not present in the repository.  The user explicitly disallowed reusing the
 * previous malformed restart harnesses and required derivation from the known
 * working crash path.  Rather than fake a fixture by mutating canonical unit
 * data, this test emits blocker metadata and fails.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const test = require('ava');

const SOURCE_TEST = path.join(__dirname, 'bh_no_definition_rollback_cache_crash_probe.test.js');
const exportDir = process.env.BH_VALID_FIXTURE_DIR || path.join('/tmp', 'ocore-impact-proof', 'bh-valid-fixture-export-blocked');
const metaPath = path.join(exportDir, 'bh_valid_restart_fixture.json');

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, obj) {
	fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function writeSnapshot(name, rows) {
	fs.writeFileSync(path.join(exportDir, name), typeof rows === 'string' ? rows : JSON.stringify(rows, null, 2));
}

test.cb.serial('BH export valid fixture from working AA rollback crash path', t => {
	ensureDir(exportDir);
	const sourceExists = fs.existsSync(SOURCE_TEST);
	const meta = {
		ok: false,
		status: 'blocked',
		reason: 'Required source test test/bh_no_definition_rollback_cache_crash_probe.test.js is absent in this checkout; refusing to synthesize a trigger or mutate canonical unit data.',
		source_test: SOURCE_TEST,
		export_dir: exportDir,
		created_at: new Date().toISOString(),
		kill_criteria: 'No valid persisted fixture derived from known working crash path; restart escalation killed until the source probe is available.'
	};
	writeJson(metaPath, meta);
	writeSnapshot('aa_triggers.snapshot.json', []);
	writeSnapshot('aa_responses.snapshot.json', []);
	writeSnapshot('trigger_units.snapshot.json', []);
	writeSnapshot('trigger_unit_authors.snapshot.json', []);
	writeSnapshot('trigger_unit_messages.snapshot.json', []);
	writeSnapshot('outputs_to_triggered_aa.snapshot.json', []);
	writeSnapshot('response_units.snapshot.json', []);
	console.log('BH_VALID_FIXTURE_EXPORT_DIR', exportDir);
	console.log('BH_VALID_FIXTURE_EXPORT_META', metaPath);
	console.log('BH_VALID_FIXTURE_EXPORT_DONE', JSON.stringify(meta));
	if (!sourceExists)
		t.fail(meta.reason);
	else
		t.fail('Source test exists but exporter implementation must be filled by copying its valid setup exactly; not implemented to avoid accidental invalid fixture creation.');
	t.end();
});
