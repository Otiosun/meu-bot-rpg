'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    assertSqlitePhysicalStartupNoSchemaMutation,
} = require('../helpers/clover/sqliteRuntimeStartupAudit');

const root = path.join(__dirname, '..');
const sources = Object.freeze({
    connectionSource: fs.readFileSync(path.join(root, 'helpers', 'clover', 'databaseConnection.js'), 'utf8'),
    databaseSource: fs.readFileSync(path.join(root, 'database.js'), 'utf8'),
    legacySource: fs.readFileSync(path.join(root, 'database', 'legacy.js'), 'utf8'),
});

test('configuracao fisica e orquestrador nao fazem DDL silencioso; legacy permanece inventariado', () => {
    const audit = assertSqlitePhysicalStartupNoSchemaMutation(sources);
    assert.equal(audit.status, 'physical_configuration_schema_noop');
    assert.equal(audit.physicalConnectionMutatesSchema, false);
    assert.equal(audit.databaseOrchestratorMutatesSchema, false);
    assert.ok(audit.legacyRuntimeDdlInventory > 0);
});
