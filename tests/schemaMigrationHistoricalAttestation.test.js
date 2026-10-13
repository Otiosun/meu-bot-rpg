'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    computeSchemaFingerprint,
    ensureMigrationLedger,
    migrationChecksum,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');

async function makeDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

function migration(version, key, sql) {
    return Object.freeze({
        version,
        key,
        description: key,
        async up(db) {
            if (sql) await db.exec(sql);
        },
    });
}

async function seedAttestedRow(db, attestation) {
    await ensureMigrationLedger(db);
    const fingerprint = await computeSchemaFingerprint(db);
    await db.run(
        `INSERT INTO clover_schema_migrations
         (version, migration_key, checksum, schema_fingerprint, metadata_json)
         VALUES (?, ?, ?, ?, '{}')`,
        [attestation.version, attestation.key, attestation.checksum, fingerprint]
    );
    await db.exec(`PRAGMA user_version = ${attestation.version}`);
}

test('histórico aplicado atestado pode preencher gap sem virar migration executável', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const m1 = migration(1, '0001_test', 'CREATE TABLE one (id INTEGER PRIMARY KEY)');
    const m3 = migration(3, '0003_new', 'CREATE TABLE three (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: [m1] });

    const attestation = Object.freeze({
        version: 2,
        key: '0002_external_history',
        checksum: 'a'.repeat(64),
    });
    await seedAttestedRow(db, attestation);

    const result = await runCloverSchemaMigrations(db, {
        migrations: [m1, m3],
        historicalAttestations: [attestation],
    });
    assert.equal(result.latestVersion, 3);
    assert.equal(result.appliedCount, 1);
    const table = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='three'");
    assert.equal(table.name, 'three');
    const uv = await db.get('PRAGMA user_version');
    assert.equal(Number(Object.values(uv)[0]), 3);
});

test('checksum histórico divergente bloqueia antes de qualquer migration nova', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const m1 = migration(1, '0001_test', 'CREATE TABLE one (id INTEGER PRIMARY KEY)');
    const m3 = migration(3, '0003_new', 'CREATE TABLE three (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: [m1] });
    await seedAttestedRow(db, {
        version: 2,
        key: '0002_external_history',
        checksum: 'b'.repeat(64),
    });

    await assert.rejects(
        runCloverSchemaMigrations(db, {
            migrations: [m1, m3],
            historicalAttestations: [{
                version: 2,
                key: '0002_external_history',
                checksum: 'a'.repeat(64),
            }],
        }),
        (error) => error?.code === 'migration_checksum_mismatch'
    );
    const table = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='three'");
    assert.equal(table, undefined);
});

test('migration executável ausente abaixo de histórico aplicado é bloqueada', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const m1 = migration(1, '0001_test', 'CREATE TABLE one (id INTEGER PRIMARY KEY)');
    const m2 = migration(2, '0002_required', 'CREATE TABLE two (id INTEGER PRIMARY KEY)');
    const m4 = migration(4, '0004_new', 'CREATE TABLE four (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: [m1] });
    const historical = {
        version: 3,
        key: '0003_external_history',
        checksum: 'c'.repeat(64),
    };
    await seedAttestedRow(db, historical);

    await assert.rejects(
        runCloverSchemaMigrations(db, {
            migrations: [m1, m2, m4],
            historicalAttestations: [historical],
        }),
        (error) => error?.code === 'missing_migration_below_applied_history'
    );
    const table = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='two'");
    assert.equal(table, undefined);
});

test('release Clover Multicolor publica somente 55-58 acima do catálogo legado', () => {
    const { CANONICAL_SCHEMA_MIGRATIONS } = require('../database');
    const release = CANONICAL_SCHEMA_MIGRATIONS.slice(-4);
    assert.deepEqual(release.map((item) => item.version), [55, 56, 57, 58]);
    assert.deepEqual(release.map((item) => item.key), [
        '0055_scene_evaluation_integrity',
        '0056_scene_evaluation_void_accounting',
        '0057_universal_evaluation_queue',
        '0058_human_prototype_evaluation',
    ]);
    assert.equal(migrationChecksum(release[0]).length, 64);
});
