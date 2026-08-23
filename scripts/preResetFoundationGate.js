'use strict';

const fs = require('fs');
const path = require('path');
const { CURRENT_SCHEMA_MIGRATIONS, PRERESET_CHARACTER_LAUNCH_KEY } = require('../helpers/clover/schemaMigrationCatalog');
const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const { auditPreResetAuthority } = require('./auditPreResetAuthority');

function runPreResetFoundationGate(root = path.resolve(__dirname, '..')) {
    const blockers = [];
    const audit = auditPreResetAuthority(root);
    const document = fs.readFileSync(path.join(root, 'docs', 'architecture', 'f4-f5-prereset-character-launch-foundation.md'), 'utf8');
    if (CURRENT_SCHEMA_MIGRATIONS.at(-1)?.key !== PRERESET_CHARACTER_LAUNCH_KEY) blockers.push('migration_not_latest');
    if (!DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.includes(PRERESET_CHARACTER_LAUNCH_KEY)) blockers.push('prebootstrap_missing');
    if (!audit.ok) blockers.push(...audit.blockers);
    if (!document.includes('PRODUCT_DECISION_REQUIRED') || !document.includes('clover_pr_ledger')) blockers.push('discovery_incomplete');
    return Object.freeze({
        ok: blockers.length === 0,
        PRERESET_FOUNDATION_GATE: blockers.length ? 'FAIL' : 'PASS',
        MIGRATIONS_FORMAL: CURRENT_SCHEMA_MIGRATIONS.at(-1)?.key === PRERESET_CHARACTER_LAUNCH_KEY ? 'PASS' : 'FAIL',
        PREBOOTSTRAP: DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.includes(PRERESET_CHARACTER_LAUNCH_KEY) ? 'PASS' : 'FAIL',
        AUTHORITY_GUARD: audit.ok ? 'PASS' : 'FAIL',
        blockers: Object.freeze(blockers),
    });
}

if (require.main === module) {
    const result = runPreResetFoundationGate();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
}

module.exports = { runPreResetFoundationGate };
