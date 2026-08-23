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
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
    inspectRaidSupportSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS,
    prebootstrapCloverSchemaBeforeLegacy,
} = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    assertRaidSupportLegacyCleanupState,
    legacyRaidFunctionRange,
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

test('cleanup 0025 deixa ownership auxiliar fora do legacy e preserva API publica Raid', () => {
    const gate = assertRaidSupportLegacyCleanupState(
        LEGACY_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.cleanupGate, 'passed_no_legacy_raid_support_ddl');
    assert.equal(gate.exported, true);
    assert.equal(gate.supportExecCount, 0);
    assert.equal(RAID_SUPPORT_TABLES_VERSION, 25);
    assert.equal(RAID_SUPPORT_TABLES_KEY, '0025_raid_support_tables');
    assert.equal(DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.includes(RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
});

test('cleanup 0025 preserva ensureCloverRaidSchema, core Raid e remove somente os 12 owners auxiliares', () => {
    const fn = legacyRaidFunctionRange(LEGACY_SOURCE)?.source || '';
    assert.match(fn, /await ensureCloverInventorySchema\(db\);/);
    assert.match(fn, /CREATE TABLE IF NOT EXISTS clover_raids/);
    assert.match(fn, /CREATE TABLE IF NOT EXISTS clover_raid_participants/);
    assert.match(fn, /CREATE INDEX IF NOT EXISTS idx_clover_raids_status/);
    assert.match(
        LEGACY_SOURCE,
        /module\.exports\s*=\s*\{[\s\S]*\bensureCloverRaidSchema\b[\s\S]*\};/
    );
    for (const spec of [...RAID_SUPPORT_TABLES, ...RAID_SUPPORT_INDEXES]) {
        assert.equal(
            new RegExp(`CREATE[\\s\\S]{0,80}\\b${spec.name}\\b`).test(fn),
            false,
            spec.name
        );
    }
});

test('cleanup 0025 falha fechado se DDL auxiliar for reintroduzido', () => {
    const reintroduced = LEGACY_SOURCE.replace(
        'async function ensureCloverRaidSchema(db) {',
        'async function ensureCloverRaidSchema(db) {\n'
            + '    await db.exec(`CREATE TABLE IF NOT EXISTS clover_raid_hosts (id INTEGER PRIMARY KEY)`);'
    );
    assert.notEqual(reintroduced, LEGACY_SOURCE);
    assert.throws(
        () => assertRaidSupportLegacyCleanupState(
            reintroduced,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_support_legacy_cleanup_mismatch'
    );
});

test('cleanup 0025 falha fechado sem pre-bootstrap 0025 ou sem export publico', () => {
    const without0025 = DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter(
        (key) => key !== RAID_SUPPORT_TABLES_KEY
    );
    assert.throws(
        () => assertRaidSupportLegacyCleanupState(LEGACY_SOURCE, without0025),
        (error) => error?.code === 'raid_support_prebootstrap_missing'
    );

    const noExport = LEGACY_SOURCE.replace(
        /(\r?\n)\s*ensureCloverRaidSchema,\r?\n/,
        '$1'
    );
    assert.notEqual(noExport, LEGACY_SOURCE);
    assert.throws(
        () => assertRaidSupportLegacyCleanupState(
            noExport,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_support_legacy_dependency_missing'
            && error?.marker === 'ensureCloverRaidSchema_export'
    );
});

test('legacy limpo executa depois do pre-bootstrap real sem recriar ownership auxiliar', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-cleanup-0025-'));
    const filename = path.join(dir, 'cleanup.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const prebootstrap = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });
    assert.equal(prebootstrap.transientMigrationCount, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length);
    assert.equal(prebootstrap.transientMigrations.some((item) => item.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);

    const legacy = loadLegacyFromSource(LEGACY_SOURCE);
    assert.equal(typeof legacy.ensureCloverRaidSchema, 'function');
    await legacy.ensureCloverRaidSchema(db);

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

test('cleanup 0025 nao adultera auditor de colunas 156/56/100/1', () => {
    assert.deepEqual(EXPECTED_COVERAGE, {
        totalTargets: 156,
        basePresent: 56,
        baseMissing: 100,
        legacyEnsurePresent: 1,
    });
});

test('contrato formal/pre-bootstrap 0025 permanece congelado apos cleanup legacy', () => {
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.some((migration) => migration.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    assert.equal(DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.includes(RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    assert.equal(RAID_SUPPORT_TABLES.length, 6);
    assert.equal(RAID_SUPPORT_INDEXES.length, 6);
});
