'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    CLEAN_RUNTIME_FUNCTION,
    analyzeRaidMonthlyProgressRuntimeCoverage,
    assertRaidMonthlyProgressRuntimeCleanupState,
    assertRaidMonthlyProgressRuntimeRemovalPreconditions,
    makeSyntheticCleanRuntimeSource,
    runtimeMonthlyFunctionSource,
    runtimeOperationalCallsiteCount,
} = require('../helpers/clover/raidMonthlyProgressCoverageAudit');

const runtimePath = path.join(__dirname, '..', 'helpers', 'clover', 'raidMonthlyProgressService.js');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');

function replaceRequired(source, before, after) {
    assert.ok(source.includes(before), `fixture marker ausente: ${before}`);
    return source.replace(before, after);
}

function removeMonthlyExportRequired(source) {
    const pattern = /(\r?\n)\s*ensureRaidMonthlyProgressSchema,\r?\n/;
    assert.match(source, pattern, 'fixture export Monthly ausente');
    return source.replace(pattern, '$1');
}

test('coverage 0024 prova 2 tabelas + 4 indices runtime contra formal e pre-bootstrap', () => {
    const result = assertRaidMonthlyProgressRuntimeRemovalPreconditions(
        runtimeSource,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(result.migrationKey, '0024_raid_monthly_progress');
    assert.equal(result.prebootstrapPromoted, true);
    assert.equal(result.runtimeExecCount, 6);
    assert.equal(result.runtimeTableCount, 2);
    assert.equal(result.runtimeIndexCount, 4);
    assert.equal(result.tablesMatch, true);
    assert.equal(result.indexesMatch, true);
    assert.equal(result.exported, true);
    assert.ok(result.operationalCallsiteCount >= 2);
});

test('coverage 0024 falha fechado sem promocao pre-bootstrap', () => {
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeRemovalPreconditions(runtimeSource, []),
        (error) => error?.code === 'raid_monthly_prebootstrap_missing'
    );
});

test('coverage 0024 detecta divergencia na tabela reservations', () => {
    const mutated = replaceRequired(
        runtimeSource,
        "status TEXT NOT NULL DEFAULT 'active'",
        "status TEXT NOT NULL DEFAULT 'released'"
    );
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeRemovalPreconditions(mutated, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_monthly_runtime_shape_mismatch'
    );
});

test('coverage 0024 detecta divergencia na tabela ledger', () => {
    const mutated = replaceRequired(
        runtimeSource,
        "amount INTEGER NOT NULL CHECK (amount != 0)",
        "amount INTEGER NOT NULL CHECK (amount > 0)"
    );
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeRemovalPreconditions(mutated, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_monthly_runtime_shape_mismatch'
    );
});

test('coverage 0024 detecta divergencia de indice e ordem', () => {
    const mutated = replaceRequired(
        runtimeSource,
        'ON clover_raid_monthly_ledger (raid_id, created_at DESC, id DESC)',
        'ON clover_raid_monthly_ledger (raid_id, id DESC, created_at DESC)'
    );
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeRemovalPreconditions(mutated, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_monthly_runtime_index_mismatch'
    );
});

test('coverage 0024 confirma garantias formais fail-closed e nao retroativas', () => {
    const analysis = analyzeRaidMonthlyProgressRuntimeCoverage(runtimeSource, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS);
    assert.deepEqual(
        analysis.formalSafety.map((entry) => [entry.marker, entry.present]),
        [
            ['schema_fail_closed', true],
            ['index_fail_closed', true],
            ['stored_state_fail_closed', true],
            ['non_retroactive_invariant', true],
            ['no_historical_raid_reads', true],
        ]
    );
});

test('coverage 0024 sintetiza cleanup sem DDL preservando API', () => {
    const clean = makeSyntheticCleanRuntimeSource(runtimeSource);
    const result = assertRaidMonthlyProgressRuntimeCleanupState(clean, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS);
    assert.equal(result.cleanupGate, 'passed_no_runtime_monthly_ddl');
    assert.equal(result.exported, true);
    assert.ok(result.operationalCallsiteCount >= 2);
    assert.equal(runtimeMonthlyFunctionSource(clean).replace(/\s+/g, ' ').trim(), CLEAN_RUNTIME_FUNCTION.replace(/\s+/g, ' ').trim());
});

test('cleanup sintetico preserva exatamente os callsites operacionais fora do wrapper', () => {
    const before = runtimeOperationalCallsiteCount(runtimeSource);
    const clean = makeSyntheticCleanRuntimeSource(runtimeSource);
    const after = runtimeOperationalCallsiteCount(clean);
    assert.ok(before >= 2);
    assert.equal(after, before);
});

test('gate pos-cleanup falha se DDL Monthly for reintroduzido', () => {
    const clean = makeSyntheticCleanRuntimeSource(runtimeSource);
    const mutated = replaceRequired(
        clean,
        '    void db;',
        "    await db.exec(`CREATE TABLE IF NOT EXISTS clover_raid_monthly_reservations (id INTEGER PRIMARY KEY)`);"
    );
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeCleanupState(mutated, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_monthly_runtime_cleanup_mismatch'
    );
});

test('gate pos-cleanup falha se export Monthly desaparecer', () => {
    const clean = makeSyntheticCleanRuntimeSource(runtimeSource);
    const mutated = removeMonthlyExportRequired(clean);
    assert.throws(
        () => assertRaidMonthlyProgressRuntimeCleanupState(mutated, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_monthly_runtime_dependency_missing'
            && error?.marker === 'ensureRaidMonthlyProgressSchema_export'
    );
});
