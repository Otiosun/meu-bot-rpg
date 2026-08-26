'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const legacyDatabase = require('../database/legacy');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
    CURRENT_SCHEMA_MIGRATIONS,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    F10MigrationGateError,
    assertCanonicalMigrationChain,
    assertDatabaseAtCanonicalMigrationHead,
} = require('../helpers/ci/f10MigrationGate');

function cloneMigration(migration, patch = {}) {
    return { ...migration, ...patch };
}

function makeTempDatabase(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const filename = path.join(dir, 'database.sqlite');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return filename;
}

async function closeQuietly(db) {
    if (db && typeof db.close === 'function') await db.close().catch(() => {});
}

function comparableLedger(snapshot) {
    return snapshot.applied.map(({ version, key, checksum, appliedAt }) => ({
        version, key, checksum, appliedAt,
    }));
}

async function stableRowsDigest(db, table, columns) {
    const rows = await db.all(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.join(', ')}`);
    return JSON.stringify(rows);
}

test('F10 migration chain congela exatamente 0001..0029 sem gaps, reorder ou key drift', () => {
    const canonical = assertCanonicalMigrationChain(CURRENT_SCHEMA_MIGRATIONS);
    assert.equal(canonical.total, 29);
    assert.equal(canonical.firstVersion, 1);
    assert.equal(canonical.latestVersion, 29);
    assert.equal(canonical.latestKey, '0029_prereset_character_launch_foundation');

    const missingLatest = CURRENT_SCHEMA_MIGRATIONS.slice(0, -1);
    assert.throws(
        () => assertCanonicalMigrationChain(missingLatest),
        (error) => error instanceof F10MigrationGateError && error.code === 'migration_chain_incomplete'
    );

    const gap = CURRENT_SCHEMA_MIGRATIONS.filter((migration) => migration.version !== 10);
    assert.throws(
        () => assertCanonicalMigrationChain(gap),
        (error) => error instanceof F10MigrationGateError && error.code === 'migration_chain_non_contiguous'
    );

    const reordered = [...CURRENT_SCHEMA_MIGRATIONS];
    [reordered[9], reordered[10]] = [reordered[10], reordered[9]];
    assert.throws(
        () => assertCanonicalMigrationChain(reordered),
        (error) => error instanceof F10MigrationGateError && error.code === 'migration_chain_non_contiguous'
    );

    const duplicateKey = [...CURRENT_SCHEMA_MIGRATIONS];
    duplicateKey[10] = cloneMigration(duplicateKey[10], { key: duplicateKey[9].key });
    assert.throws(
        () => assertCanonicalMigrationChain(duplicateKey),
        (error) => error instanceof F10MigrationGateError && error.code === 'migration_chain_duplicate_key'
    );

    const middleKeyDrift = [...CURRENT_SCHEMA_MIGRATIONS];
    middleKeyDrift[10] = cloneMigration(middleKeyDrift[10], { key: '0011_fake_character_identity' });
    assert.throws(
        () => assertCanonicalMigrationChain(middleKeyDrift),
        (error) => error instanceof F10MigrationGateError && error.code === 'migration_chain_key_drift'
    );
});

test('fresh DB usa database.criarBanco real, chega ao 0029 e rerun é estruturalmente idempotente', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-fresh-');
    let firstDb;
    let secondDb;
    try {
        firstDb = await database.criarBanco({ filename });
        const first = await assertDatabaseAtCanonicalMigrationHead(firstDb);
        assert.equal(first.preResetSchemaKind, 'exact');
        await closeQuietly(firstDb);
        firstDb = null;

        secondDb = await database.criarBanco({ filename });
        const second = await assertDatabaseAtCanonicalMigrationHead(secondDb);
        assert.deepEqual(comparableLedger(second), comparableLedger(first));
        assert.equal(second.currentSchemaFingerprint, first.currentSchemaFingerprint);
    } finally {
        await closeQuietly(firstDb);
        await closeQuietly(secondDb);
    }
});

test('legacy runtime atual preserva jogador existente ao migrar pelo bootstrap de produção até 0029 e rerun', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-current-legacy-');
    const sentinel = Object.freeze({
        id: 'f10-legacy-sentinel@s.whatsapp.net',
        nome: 'F10 Legacy Sentinel',
        dinheiro: 777,
        raca: 'Humano legado',
    });

    let legacyDb;
    let migratedDb;
    let rerunDb;
    try {
        legacyDb = await openCloverDatabase({ filename });
        await legacyDatabase.criarBanco(legacyDb);
        await legacyDb.run(
            'INSERT INTO jogadores (id, nome, dinheiro, raca) VALUES (?, ?, ?, ?)',
            [sentinel.id, sentinel.nome, sentinel.dinheiro, sentinel.raca]
        );
        const before = await legacyDb.get(
            'SELECT id, nome, dinheiro, raca FROM jogadores WHERE id = ?',
            [sentinel.id]
        );
        assert.deepEqual(before, sentinel);
        await closeQuietly(legacyDb);
        legacyDb = null;

        migratedDb = await database.criarBanco({ filename });
        const first = await assertDatabaseAtCanonicalMigrationHead(migratedDb);
        const after = await migratedDb.get(
            'SELECT id, nome, dinheiro, raca FROM jogadores WHERE id = ?',
            [sentinel.id]
        );
        assert.deepEqual(after, sentinel);
        await closeQuietly(migratedDb);
        migratedDb = null;

        rerunDb = await database.criarBanco({ filename });
        const second = await assertDatabaseAtCanonicalMigrationHead(rerunDb);
        const afterRerun = await rerunDb.get(
            'SELECT id, nome, dinheiro, raca FROM jogadores WHERE id = ?',
            [sentinel.id]
        );
        assert.deepEqual(afterRerun, sentinel);
        assert.deepEqual(comparableLedger(second), comparableLedger(first));
        assert.equal(second.currentSchemaFingerprint, first.currentSchemaFingerprint);
    } finally {
        await closeQuietly(legacyDb);
        await closeQuietly(migratedDb);
        await closeQuietly(rerunDb);
    }
});

test('true legacy histórico mínimo sobe pelo bootstrap real, preserva dados e reabre em no-op', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-true-legacy-');
    let legacyDb;
    let migratedDb;
    let rerunDb;
    let before;
    try {
        legacyDb = await openCloverDatabase({ filename });
        await legacyDb.exec(`
            CREATE TABLE jogadores (
                id TEXT PRIMARY KEY,
                nome TEXT,
                dinheiro INTEGER DEFAULT 0
            );
            CREATE TABLE clover_inventory_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_id TEXT NOT NULL,
                item_name TEXT NOT NULL,
                description TEXT DEFAULT NULL,
                quantity INTEGER DEFAULT 1,
                kind TEXT DEFAULT 'narrativo',
                source TEXT DEFAULT NULL,
                related_id TEXT DEFAULT NULL,
                created_by TEXT DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                metadata_json TEXT DEFAULT NULL
            );
        `);
        await legacyDb.run(
            'INSERT INTO jogadores (id, nome, dinheiro) VALUES (?, ?, ?)',
            ['f10-historical-player', 'Histórico F10', 91]
        );
        await legacyDb.run(
            'INSERT INTO clover_inventory_items (player_id, item_name) VALUES (?, ?)',
            ['f10-historical-player', 'Relíquia histórica F10']
        );
        before = {
            players: await stableRowsDigest(legacyDb, 'jogadores', ['id', 'nome', 'dinheiro']),
            inventory: await stableRowsDigest(legacyDb, 'clover_inventory_items', ['id', 'player_id', 'item_name']),
        };
        await closeQuietly(legacyDb);
        legacyDb = null;

        migratedDb = await database.criarBanco({ filename });
        const first = await assertDatabaseAtCanonicalMigrationHead(migratedDb);
        assert.equal(await stableRowsDigest(migratedDb, 'jogadores', ['id', 'nome', 'dinheiro']), before.players);
        assert.equal(
            await stableRowsDigest(migratedDb, 'clover_inventory_items', ['id', 'player_id', 'item_name']),
            before.inventory
        );
        assert.equal(
            (await migratedDb.get('SELECT seq FROM sqlite_sequence WHERE name = ?', ['clover_inventory_items'])).seq,
            1
        );
        assert.equal((await migratedDb.get('SELECT COUNT(*) AS count FROM clover_raid_monthly_ledger')).count, 0);
        assert.equal((await migratedDb.get('SELECT COUNT(*) AS count FROM clover_raid_reward_review_intents')).count, 0);
        assert.equal((await migratedDb.get('SELECT COUNT(*) AS count FROM clover_raid_reward_proposal_revisions')).count, 0);
        await closeQuietly(migratedDb);
        migratedDb = null;

        rerunDb = await database.criarBanco({ filename });
        const second = await assertDatabaseAtCanonicalMigrationHead(rerunDb);
        assert.deepEqual(comparableLedger(second), comparableLedger(first));
        assert.equal(second.currentSchemaFingerprint, first.currentSchemaFingerprint);
        assert.equal(await stableRowsDigest(rerunDb, 'jogadores', ['id', 'nome', 'dinheiro']), before.players);
        assert.equal(
            await stableRowsDigest(rerunDb, 'clover_inventory_items', ['id', 'player_id', 'item_name']),
            before.inventory
        );
    } finally {
        await closeQuietly(legacyDb);
        await closeQuietly(migratedDb);
        await closeQuietly(rerunDb);
    }
});
