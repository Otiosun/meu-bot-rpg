#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
    assertLegacyDatabaseBypassGate,
} = require('../helpers/clover/legacyDatabaseBypassAudit');

function main() {
    const root = path.resolve(__dirname, '..');
    const result = assertLegacyDatabaseBypassGate(root);
    const payload = {
        ok: true,
        removalGate: result.removalGate,
        sourceFilesScanned: result.sourceFilesScanned,
        directImportCount: result.directImportCount,
        productionDirectImports: result.productionDirectImports,
        testDirectImports: result.testDirectImports,
        records: result.records.map((record) => ({
            path: record.path,
            directImports: record.directImports.map((item) => item.specifier),
            bridgeUses: record.bridgeUses,
            customLegacyInjections: record.customLegacyInjections,
            testFile: record.testFile,
        })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error?.code || 'legacy_database_bypass_audit_failed',
        message: error?.message || String(error),
        blockers: error?.blockers || [],
    }, null, 2)}\n`);
    process.exitCode = 1;
}
