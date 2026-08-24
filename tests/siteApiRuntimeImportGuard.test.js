'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
    ROUTER_FILES,
    auditEvidenceOnlyRuntimeImports,
} = require('../helpers/clover/routeSourceAudit');

const root = path.join(__dirname, '..');

test('production runtime graph does not import F7 evidence-only helpers', () => {
    assert.deepEqual(auditEvidenceOnlyRuntimeImports(), []);
});

test('evidence-only import guard rejects a synthetic production entry', () => {
    const entry = path.join(root, 'tests', 'fixtures', 'siteApiRuntimeImportGuard', 'syntheticProductionEntry.js');
    assert.deepEqual(auditEvidenceOnlyRuntimeImports([entry]), [{
        importer: 'tests/fixtures/siteApiRuntimeImportGuard/syntheticProductionEntry.js',
        evidence: 'helpers/clover/preResetSiteApiEvidenceFixture.js',
    }]);
    assert.deepEqual(ROUTER_FILES, ['helpers/clover/siteApiServer.js', 'helpers/clover/siteApiServerLegacy.js']);
});
