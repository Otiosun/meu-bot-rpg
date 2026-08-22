'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    RAID_IDEMPOTENCY_REQUESTS_KEY,
    RAID_IDEMPOTENCY_REQUESTS_TABLES,
    RAID_REWARD_PROPOSAL_HISTORY_KEY,
    inspectRaidIdempotencyRequestsSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS,
    prebootstrapCloverSchemaBeforeLegacy,
} = require('../helpers/clover/schemaBasePrebootstrapService');
const { MIGRATION_TABLE, tableExists } = require('../helpers/clover/schemaMigrationService');
const {
    OWNERS,
    assertRaidIdempotencyRequestsRuntimeCleanupState,
    findFunctionRange,
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

test('cleanup 0026 deixa os dois wrappers no-op e preserva exports e callsites', () => {
    const gate = assertRaidIdempotencyRequestsRuntimeCleanupState(
        CREATION_SOURCE,
        MUTATION_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.creation.cleanupGate, 'passed_no_runtime_0026_ddl');
    assert.equal(gate.mutation.cleanupGate, 'passed_no_runtime_0026_ddl');
    for (const [source, owner] of [[CREATION_SOURCE, OWNERS[0]], [MUTATION_SOURCE, OWNERS[1]]]) {
        const fn = findFunctionRange(source, owner.functionName)?.source || '';
        assert.equal(fn.includes('CREATE TABLE'), false, owner.id);
        assert.equal(fn.includes('CREATE INDEX'), false, owner.id);
        assert.equal(fn.includes('db.exec('), false, owner.id);
    }
});

test('wrappers 0026 limpos executam depois do pre-bootstrap real sem recriar schema', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-cleanup-0026-'));
    const filename = path.join(dir, 'cleanup.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const prebootstrap = await prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(prebootstrap.transientMigrationCount, 27);
    assert.equal(prebootstrap.transientMigrations.at(-1)?.key, RAID_REWARD_PROPOSAL_HISTORY_KEY);
    await loadFromSource(CREATION_PATH, CREATION_SOURCE).ensureRaidCreationIdempotencySchema(db);
    await loadFromSource(MUTATION_PATH, MUTATION_SOURCE).ensureRaidClaimedMutationSchema(db);
    assert.equal((await inspectRaidIdempotencyRequestsSchemaState(db)).exact, true);
    for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
        assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n), 0, table.name);
    }
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('cleanup 0026 falha fechado se export, callsite ou DDL for alterado', () => {
    const noExport = CREATION_SOURCE.replace(/(\r?\n)\s*ensureRaidCreationIdempotencySchema,\r?\n/, '$1');
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeCleanupState(noExport, MUTATION_SOURCE, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_idempotency_requests_runtime_dependency_missing'
    );
    const noCallsite = MUTATION_SOURCE.replace('await ensureRaidClaimedMutationSchema(db);', 'void db;');
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeCleanupState(CREATION_SOURCE, noCallsite, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_idempotency_requests_runtime_dependency_missing'
    );
    const reintroduced = CREATION_SOURCE.replace('    void db;', '    await db.exec(`CREATE TABLE clover_raid_creation_requests (id TEXT PRIMARY KEY)`);');
    assert.throws(
        () => assertRaidIdempotencyRequestsRuntimeCleanupState(reintroduced, MUTATION_SOURCE, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),
        (error) => error?.code === 'raid_idempotency_requests_runtime_cleanup_mismatch'
    );
});
