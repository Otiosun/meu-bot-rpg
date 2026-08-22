'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const { EXPECTED_COVERAGE } = require('../helpers/clover/schemaBaseConsolidationAudit');
const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    RAID_SUPPORT_INDEXES,
    RAID_SUPPORT_TABLES,
    RAID_SUPPORT_TABLES_KEY,
    RAID_SUPPORT_TABLES_VERSION,
    inspectRaidSupportSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS,
    prebootstrapCloverSchemaBeforeLegacy,
} = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    analyzeRaidSupportLegacyCoverage,
    assertRaidSupportLegacyCleanupState,
    assertRaidSupportLegacyRemovalPreconditions,
    legacyRaidFunctionRange,
    makeSyntheticCleanLegacySource,
    normalizeSql,
} = require('../helpers/clover/raidSupportCoverageAudit');
const { MIGRATION_TABLE, tableExists } = require('../helpers/clover/schemaMigrationService');

const LEGACY_PATH = path.join(__dirname, '..', 'database', 'legacy.js');
const LEGACY_SOURCE = fs.readFileSync(LEGACY_PATH, 'utf8');

function loadLegacyFromSource(source) {
    const compiled = new Module(LEGACY_PATH, module);
    compiled.filename = LEGACY_PATH;
    compiled.paths = Module._nodeModulePaths(path.dirname(LEGACY_PATH));
    compiled._compile(source, LEGACY_PATH);
    return compiled.exports;
}

test('coverage 0025 prova ownership formal/pre-bootstrap exato de 6 tabelas + 6 indices legacy', () => {
    const gate = assertRaidSupportLegacyRemovalPreconditions(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.removalGate, 'passed_raid_support_0025_prebootstrap');
    assert.equal(gate.prebootstrapPromoted, true);
    assert.equal(gate.legacyFunctionPresent, true);
    assert.equal(gate.exported, true);
    assert.equal(gate.formalTableCount, 6);
    assert.equal(gate.formalIndexCount, 6);
    assert.equal(gate.legacySupportExecCount, 12);
    assert.equal(RAID_SUPPORT_TABLES_VERSION, 25);
    assert.equal(RAID_SUPPORT_TABLES_KEY, '0025_raid_support_tables');
    assert.equal(DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.at(-1), RAID_SUPPORT_TABLES_KEY);
    assert.equal(DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length, 24);
});

test('coverage 0025 compara as seis CREATE TABLE legacy 1:1 com o catalogo formal', () => {
    const analysis = analyzeRaidSupportLegacyCoverage(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(analysis.tablesMatch, true);
    assert.deepEqual(
        analysis.tableMatches.map((entry) => entry.name),
        RAID_SUPPORT_TABLES.map((entry) => entry.name)
    );
    for (const entry of analysis.tableMatches) {
        assert.equal(entry.occurrences, 1, entry.name);
        assert.equal(entry.matched, true, entry.name);
        assert.equal(entry.legacySql, entry.formalSql, entry.name);
    }
});

test('coverage 0025 compara os seis CREATE INDEX legacy 1:1 com o catalogo formal', () => {
    const analysis = analyzeRaidSupportLegacyCoverage(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(analysis.indexesMatch, true);
    assert.deepEqual(
        analysis.indexMatches.map((entry) => entry.name),
        RAID_SUPPORT_INDEXES.map((entry) => entry.name)
    );
    for (const entry of analysis.indexMatches) {
        assert.equal(entry.occurrences, 1, entry.name);
        assert.equal(entry.matched, true, entry.name);
        assert.equal(entry.legacySql, entry.formalSql, entry.name);
    }
});

test('coverage 0025 congela fail-closed formal e ausencia de retroatividade', () => {
    const analysis = analyzeRaidSupportLegacyCoverage(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.deepEqual(
        analysis.formalSafety.map((entry) => [entry.marker, entry.present]),
        [
            ['schema_fail_closed', true],
            ['index_fail_closed', true],
            ['stored_state_fail_closed', true],
            ['no_historical_raid_reads', true],
            ['no_retroactive_dml', true],
        ]
    );
});

test('coverage 0025 sintetiza cleanup de exatamente 12 DDL e preserva ensure/export/core Raid', () => {
    const before = analyzeRaidSupportLegacyCoverage(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    const cleaned = makeSyntheticCleanLegacySource(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.notEqual(cleaned, LEGACY_SOURCE);
    const cleanup = assertRaidSupportLegacyCleanupState(
        cleaned,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(cleanup.cleanupGate, 'passed_no_legacy_raid_support_ddl');
    assert.equal(cleanup.exported, true);
    assert.equal(cleanup.supportExecCount, 0);
    assert.equal(before.totalRaidExecBlocks - cleanup.totalRaidExecBlocks, 12);
    const fn = legacyRaidFunctionRange(cleaned)?.source || '';
    assert.match(fn, /CREATE TABLE IF NOT EXISTS clover_raids/);
    assert.match(fn, /CREATE TABLE IF NOT EXISTS clover_raid_participants/);
    assert.match(fn, /CREATE INDEX IF NOT EXISTS idx_clover_raids_status/);
});

test('coverage 0025 falha fechado se DDL auxiliar for reintroduzido apos cleanup', () => {
    const cleaned = makeSyntheticCleanLegacySource(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    const reintroduced = cleaned.replace(
        'async function ensureCloverRaidSchema(db) {',
        'async function ensureCloverRaidSchema(db) {\n'
            + '    await db.exec(`CREATE TABLE IF NOT EXISTS clover_raid_hosts (id INTEGER PRIMARY KEY)`);'
    );
    assert.throws(
        () => assertRaidSupportLegacyCleanupState(
            reintroduced,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_support_legacy_cleanup_mismatch'
    );
});

test('coverage 0025 falha fechado sem pre-bootstrap ou se o shape legacy divergir do formal', () => {
    const without0025 = DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter(
        (key) => key !== RAID_SUPPORT_TABLES_KEY
    );
    assert.throws(
        () => assertRaidSupportLegacyRemovalPreconditions(LEGACY_SOURCE, without0025),
        (error) => error?.code === 'raid_support_prebootstrap_missing'
    );

    const mutated = LEGACY_SOURCE.replace(
        "role TEXT NOT NULL CHECK (role IN ('owner', 'co_host'))",
        "role TEXT DEFAULT NULL CHECK (role IN ('owner', 'co_host'))"
    );
    assert.notEqual(mutated, LEGACY_SOURCE);
    assert.throws(
        () => assertRaidSupportLegacyRemovalPreconditions(
            mutated,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_support_legacy_shape_mismatch'
    );
});

test('cleanup sintetico 0025 executa ensureCloverRaidSchema apos pre-bootstrap real sem recriar ownership auxiliar', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-coverage-0025-clean-'));
    const filename = path.join(dir, 'coverage.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const prebootstrap = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });
    assert.equal(prebootstrap.transientMigrationCount, 24);
    assert.equal(prebootstrap.transientMigrations.at(-1)?.key, RAID_SUPPORT_TABLES_KEY);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);

    const cleanedSource = makeSyntheticCleanLegacySource(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    const cleanedLegacy = loadLegacyFromSource(cleanedSource);
    assert.equal(typeof cleanedLegacy.ensureCloverRaidSchema, 'function');
    await cleanedLegacy.ensureCloverRaidSchema(db);

    const support = await inspectRaidSupportSchemaState(db);
    assert.equal(support.kind, 'exact');
    assert.equal(support.indexValid, true);
    for (const table of support.tables) {
        const row = await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`);
        assert.equal(Number(row.n), 0, table.name);
    }
    assert.equal(await tableExists(db, 'clover_raids'), true);
    assert.equal(await tableExists(db, 'clover_raid_participants'), true);
});

test('coverage table-shape 0025 nao adultera auditor de colunas 156/56/100/0', () => {
    assert.deepEqual(EXPECTED_COVERAGE, {
        totalTargets: 156,
        basePresent: 56,
        baseMissing: 100,
        legacyEnsurePresent: 0,
    });
    assert.equal(RAID_SUPPORT_TABLES.length, 6);
    assert.equal(RAID_SUPPORT_INDEXES.length, 6);
    assert.ok(normalizeSql(RAID_SUPPORT_TABLES[0].sql).startsWith('CREATE TABLE '));
});
