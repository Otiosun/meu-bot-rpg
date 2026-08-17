#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    assertConsolidationPreconditions,
} = require('../helpers/clover/schemaBaseConsolidationAudit');

function main() {
    const root = path.resolve(__dirname, '..');
    const legacyPath = path.join(root, 'database', 'legacy.js');
    const source = fs.readFileSync(legacyPath, 'utf8');
    const result = assertConsolidationPreconditions(source);
    const summary = {
        ok: true,
        removalGate: result.removalGate,
        requiresLegacyRepairBeforeBaseline: result.requiresLegacyRepairBeforeBaseline,
        coverage: {
            totalTargets: result.coverage.totalTargets,
            basePresent: result.coverage.basePresent,
            baseMissing: result.coverage.baseMissing,
            legacyEnsurePresent: result.coverage.legacyEnsurePresent,
        },
        dependencyMarkers: result.dependencies.map((item) => ({
            table: item.table,
            kind: item.kind,
            marker: item.marker,
            present: item.present,
        })),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error?.code || 'schema_base_audit_failed',
        message: error?.message || String(error),
        metric: error?.metric || null,
        expected: error?.expected ?? null,
        observed: error?.observed ?? null,
        marker: error?.marker || null,
    }, null, 2)}\n`);
    process.exitCode = 1;
}
