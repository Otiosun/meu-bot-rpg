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
    RAID_IDEMPOTENCY_REQUESTS_INDEXES,
    RAID_IDEMPOTENCY_REQUESTS_KEY,
    RAID_IDEMPOTENCY_REQUESTS_TABLES,
    RAID_IDEMPOTENCY_REQUESTS_VERSION,
    inspectRaidIdempotencyRequestsSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS,
    prebootstrapCloverSchemaBeforeLegacy,
} = require('../helpers/clover/schemaBasePrebootstrapService');
const { MIGRATED_BASE_TABLES } = require('../helpers/clover/schemaBaseCatalog');
const { MIGRATION_TABLE, tableExists } = require('../helpers/clover/schemaMigrationService');
const {
    OWNERS,
    analyzeRaidIdempotencyRequestsRuntimeCoverage,
    assertRaidIdempotencyRequestsRuntimeCleanupState,
    assertRaidIdempotencyRequestsRuntimeRemovalPreconditions,
    findFunctionRange,
    makeSyntheticCleanRuntimeSource,
} = require('../helpers/clover/raidIdempotencyRequestsCoverageAudit');

const CREATION_PATH = path.join(__dirname, '..', 'helpers', 'clover', 'raidCreationIdempotency.js');
const MUTATION_PATH = path.join(__dirname, '..', 'helpers', 'clover', 'raidClaimedMutationIdempotency.js');
const CREATION_SOURCE = fs.readFileSync(CREATION_PATH, 'utf8');
const MUTATION_SOURCE = fs.readFileSync(MUTATION_PATH, 'utf8');

function loadFromSource(filename, source) {
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(source, filename);
    return compiled.exports;
}

function withoutExport(source, functionName) {
    const replaced = source.replace(new RegExp(`(\\r?\\n)\\s*${functionName},\\r?\\n`), '$1');
    assert.notEqual(replaced, source);
    return replaced;
}

function withFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-coverage-0026-'));
    const filename = path.join(dir, 'coverage.sqlite');
    return openCloverDatabase({ filename }).then((db) => {
        t.after(async () => {
            await db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        });
        return db;
    });
}

test('coverage 0026 prova ownership runtime 1:1 e gate formal/pre-bootstrap', () => {
    const gate = assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(
        CREATION_SOURCE,
        MUTATION_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.removalGate, 'passed_raid_idempotency_requests_0026_prebootstrap');
    assert.equal(gate.runtimeTableCount, 2);
    assert.equal(gate.runtimeIndexCount, 2);
    assert.equal(gate.tablesExact, true);
    assert.equal(gate.indexesExact, true);
    assert.equal(RAID_IDEMPOTENCY_REQUESTS_VERSION, 26);
    assert.equal(RAID_IDEMPOTENCY_REQUESTS_KEY, '0026_raid_idempotency_requests');
    assert.equal(DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length, 25);
    assert.equal(DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.at(-1), RAID_IDEMPOTENCY_REQUESTS_KEY);
    for (const owner of gate.owners) {
        assert.equal(owner.functionPresent, true, owner.owner);
        assert.equal(owner.exported, true, owner.owner);
        assert.equal(owner.operationalCallsiteCount, 1, owner.owner);
        assert.equal(owner.prepareCallsEnsure, true, owner.owner);
        assert.equal(owner.tableOccurrences, 1, owner.owner);
        assert.equal(owner.indexOccurrences, 1, owner.owner);
    }
    assert.equal(gate.formalSafety.every((entry) => entry.present), true);
});

test('coverage 0026 pre-bootstrap real cria somente os dois owners vazios sem ledger', async (t) => {
    const db = await withFixture(t);
    const prebootstrap = await prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(prebootstrap.baseTablesCreatedOrPresent, 19);
    assert.equal(prebootstrap.transientMigrationCount, 25);
    assert.equal(prebootstrap.transientMigrations.at(-1)?.key, RAID_IDEMPOTENCY_REQUESTS_KEY);
    assert.equal(MIGRATED_BASE_TABLES.length, 19);
    const state = await inspectRaidIdempotencyRequestsSchemaState(db);
    assert.equal(state.kind, 'exact');
    assert.equal(state.indexValid, true);
    assert.equal(state.tables.length, 2);
    assert.equal(state.indexes.length, 2);
    for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
        assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n), 0, table.name);
    }
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('coverage 0026 cleanup sintético preserva wrappers, exports, callsites e schema pre-bootstrap', async (t) => {
    const cleanedCreation = makeSyntheticCleanRuntimeSource(CREATION_SOURCE, OWNERS[0]);
    const cleanedMutation = makeSyntheticCleanRuntimeSource(MUTATION_SOURCE, OWNERS[1]);
    const cleanup = assertRaidIdempotencyRequestsRuntimeCleanupState(
        cleanedCreation,
        cleanedMutation,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(cleanup.creation.cleanupGate, 'passed_no_runtime_0026_ddl');
    assert.equal(cleanup.mutation.cleanupGate, 'passed_no_runtime_0026_ddl');
    assert.equal(findFunctionRange(cleanedCreation, OWNERS[0].functionName)?.source.includes('CREATE TABLE'), false);
    assert.equal(findFunctionRange(cleanedMutation, OWNERS[1].functionName)?.source.includes('CREATE INDEX'), false);

    const db = await withFixture(t);
    await prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    const creation = loadFromSource(CREATION_PATH, cleanedCreation);
    const mutation = loadFromSource(MUTATION_PATH, cleanedMutation);
    await creation.ensureRaidCreationIdempotencySchema(db);
    await mutation.ensureRaidClaimedMutationSchema(db);
    const state = await inspectRaidIdempotencyRequestsSchemaState(db);
    assert.equal(state.exact, true);
    for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
        assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n), 0, table.name);
    }
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('coverage 0026 falha fechado sem pre-bootstrap, wrappers, exports, DDL ou callsites', () => {
    const without0026 = DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter((key) => key !== RAID_IDEMPOTENCY_REQUESTS_KEY);
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(CREATION_SOURCE, MUTATION_SOURCE, without0026),
        (error) => error?.code === 'raid_idempotency_requests_prebootstrap_missing'
    );
    for (const [source, owner] of [[CREATION_SOURCE, OWNERS[0]], [MUTATION_SOURCE, OWNERS[1]]]) {
        const missingWrapper = source.replace(`async function ${owner.functionName}(db) {`, `async function removed${owner.functionName}(db) {`);
        assert.throws(
            () => assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(
                owner.id === 'creation' ? missingWrapper : CREATION_SOURCE,
                owner.id === 'mutation' ? missingWrapper : MUTATION_SOURCE,
                DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
            ),
            (error) => error?.code === 'raid_idempotency_requests_runtime_dependency_missing'
        );
        const missingExport = withoutExport(source, owner.functionName);
        assert.throws(
            () => assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(
                owner.id === 'creation' ? missingExport : CREATION_SOURCE,
                owner.id === 'mutation' ? missingExport : MUTATION_SOURCE,
                DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
            ),
            (error) => error?.code === 'raid_idempotency_requests_runtime_dependency_missing'
        );
        const missingCallsite = source.replace(`await ${owner.functionName}(db);`, 'void db;');
        assert.throws(
            () => assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(
                owner.id === 'creation' ? missingCallsite : CREATION_SOURCE,
                owner.id === 'mutation' ? missingCallsite : MUTATION_SOURCE,
                DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
            ),
            (error) => error?.code === 'raid_idempotency_requests_runtime_dependency_missing'
        );
    }
});

test('coverage 0026 falha fechado para SQL divergente, DDL faltando e DDL reintroduzido', () => {
    const divergentTable = CREATION_SOURCE.replace('actor_id TEXT NOT NULL', 'actor_id TEXT DEFAULT NULL');
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(divergentTable, MUTATION_SOURCE, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_idempotency_requests_runtime_shape_mismatch'
    );
    const divergentIndex = MUTATION_SOURCE.replace('(status, lease_expires_at, updated_at)', '(updated_at, status, lease_expires_at)');
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(CREATION_SOURCE, divergentIndex, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_idempotency_requests_runtime_index_mismatch'
    );
    const missingDdl = CREATION_SOURCE.replace('await db.exec(`', 'await db.query(`');
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(missingDdl, MUTATION_SOURCE, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_idempotency_requests_runtime_precleanup_state_mismatch'
    );
    const cleanedCreation = makeSyntheticCleanRuntimeSource(CREATION_SOURCE, OWNERS[0]);
    const cleanedMutation = makeSyntheticCleanRuntimeSource(MUTATION_SOURCE, OWNERS[1]);
    const reintroduced = cleanedCreation.replace('    void db;', '    await db.exec(`CREATE TABLE clover_raid_creation_requests (id TEXT PRIMARY KEY)`);');
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeCleanupState(reintroduced, cleanedMutation, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_idempotency_requests_runtime_cleanup_mismatch'
    );
});

test('coverage 0026 congela formal, não-retroatividade e auditor 156/56/100/0', () => {
    const analysis = analyzeRaidIdempotencyRequestsRuntimeCoverage(
        CREATION_SOURCE,
        MUTATION_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(analysis.formalSafety.every((entry) => entry.present), true);
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.length, 26);
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.at(-1)?.key, RAID_IDEMPOTENCY_REQUESTS_KEY);
    assert.equal(RAID_IDEMPOTENCY_REQUESTS_TABLES.length, 2);
    assert.equal(RAID_IDEMPOTENCY_REQUESTS_INDEXES.length, 2);
    assert.deepEqual(EXPECTED_COVERAGE, {
        totalTargets: 156,
        basePresent: 56,
        baseMissing: 100,
        legacyEnsurePresent: 0,
    });
});