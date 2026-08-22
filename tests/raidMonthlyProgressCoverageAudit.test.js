'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { EXPECTED_COVERAGE } = require('../helpers/clover/schemaBaseConsolidationAudit');
const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    RAID_MONTHLY_PROGRESS_KEY,
    RAID_MONTHLY_PROGRESS_VERSION,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    CLEAN_RUNTIME_FUNCTION,
    assertRaidMonthlyProgressRuntimeCleanupState,
    runtimeMonthlyFunctionSource,
    runtimeOperationalCallsiteCount,
} = require('../helpers/clover/raidMonthlyProgressCoverageAudit');

const RUNTIME_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'helpers', 'clover', 'raidMonthlyProgressService.js'),
    'utf8'
);

test('cleanup 0024 deixa ensureRaidMonthlyProgressSchema no estado no-op provado pelo coverage', () => {
    const gate = assertRaidMonthlyProgressRuntimeCleanupState(
        RUNTIME_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.cleanupGate, 'passed_no_runtime_monthly_ddl');
    assert.equal(gate.exported, true);
    assert.equal(gate.operationalCallsiteCount, 2);
    assert.equal(RAID_MONTHLY_PROGRESS_VERSION, 24);
    assert.equal(RAID_MONTHLY_PROGRESS_KEY, '0024_raid_monthly_progress');
});

test('cleanup 0024 remove somente DDL Monthly e preserva wrapper, export e dois callsites operacionais', () => {
    const fn = runtimeMonthlyFunctionSource(RUNTIME_SOURCE);
    assert.equal(
        fn.replace(/\s+/g, ' ').trim(),
        CLEAN_RUNTIME_FUNCTION.replace(/\s+/g, ' ').trim()
    );
    for (const forbidden of [
        'CREATE TABLE',
        'CREATE INDEX',
        'clover_raid_monthly_reservations',
        'clover_raid_monthly_ledger',
        'db.exec(',
    ]) {
        assert.equal(fn.includes(forbidden), false, forbidden);
    }
    assert.match(
        RUNTIME_SOURCE,
        /module\.exports\s*=\s*\{[\s\S]*\bensureRaidMonthlyProgressSchema\b[\s\S]*\};/
    );
    assert.equal(runtimeOperationalCallsiteCount(RUNTIME_SOURCE), 2);
});

test('cleanup 0024 falha fechado se DDL Monthly for reintroduzido', () => {
    const reintroduced = RUNTIME_SOURCE.replace(
        '    void db;',
        "    await db.exec(`CREATE TABLE IF NOT EXISTS clover_raid_monthly_reservations (id INTEGER PRIMARY KEY)`);"
    );
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeCleanupState(
            reintroduced,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_monthly_runtime_cleanup_mismatch'
    );
});

test('cleanup 0024 falha fechado sem pre-bootstrap 0024 ou sem export publico', () => {
    const no0024 = DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter(
        (key) => key !== RAID_MONTHLY_PROGRESS_KEY
    );
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeCleanupState(RUNTIME_SOURCE, no0024),
        (error) => error?.code === 'raid_monthly_prebootstrap_missing'
    );

    const noExport = RUNTIME_SOURCE.replace(
        /(\r?\n)\s*ensureRaidMonthlyProgressSchema,\r?\n/,
        '$1'
    );
    assert.notEqual(noExport, RUNTIME_SOURCE);
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeCleanupState(
            noExport,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_monthly_runtime_dependency_missing'
            && error?.marker === 'ensureRaidMonthlyProgressSchema_export'
    );
});

test('cleanup table-shape 0024 nao adultera auditor de colunas 156/56/100/1', () => {
    assert.deepEqual(EXPECTED_COVERAGE, {
        totalTargets: 156,
        basePresent: 56,
        baseMissing: 100,
        legacyEnsurePresent: 1,
    });
});

test('contrato de cleanup Monthly esperado pelo coverage continua congelado', () => {
    assert.equal(
        CLEAN_RUNTIME_FUNCTION,
        "async function ensureRaidMonthlyProgressSchema(db) {\n"
            + "    void db;\n"
            + "}"
    );
    assert.equal(runtimeOperationalCallsiteCount(RUNTIME_SOURCE), 2);
});
