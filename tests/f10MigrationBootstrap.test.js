'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const legacyDatabase = require('../database/legacy');
const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
    CURRENT_SCHEMA_MIGRATIONS,
} = require('../helpers/clover/schemaMigrationPlan');
const {
    GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS,
} = require('../helpers/clover/globalResetJournalFreezeMigration');
const {
    ensureCloverScriptSchema,
} = require('../helpers/clover/cloverScriptService');
const {
    ensureGlobalPlayerResetSchema,
    planGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');
const {
    ensurePlayerResetSchema,
} = require('../helpers/clover/playerResetService');
const {
    F10MigrationGateError,
    assertCanonicalMigrationChain,
    assertDatabaseAtCanonicalMigrationHead,
} = require('../helpers/ci/f10MigrationGate');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;
const MIGRATIONS_THROUGH_0029 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 29));
const MIGRATIONS_THROUGH_0030 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 30));
const MIGRATIONS_THROUGH_0031 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 31));

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

function triggerRejectedWith(code) {
    return (error) => String(error?.message || error).includes(code);
}

test('F10 migration chain congela exatamente 0001..0032 sem gaps, reorder ou key drift', () => {
    const canonical = assertCanonicalMigrationChain(CURRENT_SCHEMA_MIGRATIONS);
    assert.equal(canonical.total, 32);
    assert.equal(canonical.firstVersion, 1);
    assert.equal(canonical.latestVersion, 32);
    assert.equal(canonical.latestKey, '0032_global_reset_journal_freeze');

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

test('fresh DB usa database.criarBanco real, chega ao 0032 e rerun é estruturalmente idempotente', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-fresh-');
    let firstDb;
    let secondDb;
    try {
        firstDb = await database.criarBanco({ filename });
        const first = await assertDatabaseAtCanonicalMigrationHead(firstDb);
        assert.equal(first.preResetSchemaKind, 'exact');
        assert.equal(first.resetJournalSchemaKind, 'exact');
        assert.equal(first.cloverScriptJournalSchemaKind, 'exact');
        assert.equal(first.globalResetFreezeSchemaKind, 'exact');
        assert.equal(first.schemaFingerprintMatchesLatest, true);
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

test('legacy runtime atual preserva jogador existente ao migrar pelo bootstrap de produção até 0032 e rerun', async (t) => {
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

test('true legacy histórico mínimo sobe pelo bootstrap real até 0032, preserva dados e reabre em no-op', async (t) => {
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

test('0030 adota journals runtime exatos já existentes e preserva dados sem recriar lineage', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-reset-journal-adopt-');
    let head29Db;
    let migratedDb;
    try {
        head29Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0029 });
        await ensureGlobalPlayerResetSchema(head29Db);
        await head29Db.run(
            `INSERT INTO clover_player_reset_events
             (operation_code, player_id, reason, before_json, after_json)
             VALUES (?, ?, ?, ?, ?)`,
            ['RS-F10-LEGACY-ADOPT', 'f10-reset-adopt-player', 'sentinel migration 0030', '{}', '{}']
        );
        await closeQuietly(head29Db);
        head29Db = null;

        migratedDb = await database.criarBanco({ filename });
        const state = await assertDatabaseAtCanonicalMigrationHead(migratedDb);
        assert.equal(state.userVersion, 32);
        assert.equal(state.resetJournalSchemaKind, 'exact');
        assert.equal(state.cloverScriptJournalSchemaKind, 'exact');
        assert.equal(state.globalResetFreezeSchemaKind, 'exact');
        const sentinel = await migratedDb.get(
            'SELECT operation_code, player_id, reason FROM clover_player_reset_events WHERE operation_code = ?',
            ['RS-F10-LEGACY-ADOPT']
        );
        assert.deepEqual(sentinel, {
            operation_code: 'RS-F10-LEGACY-ADOPT',
            player_id: 'f10-reset-adopt-player',
            reason: 'sentinel migration 0030',
        });
    } finally {
        await closeQuietly(head29Db);
        await closeQuietly(migratedDb);
    }
});

test('0030 aceita somente prefixo runtime seguro: player journal exato + global ausente', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-reset-journal-prefix-');
    let head29Db;
    let migratedDb;
    try {
        head29Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0029 });
        await ensurePlayerResetSchema(head29Db);
        await head29Db.run(
            `INSERT INTO clover_player_reset_events
             (operation_code, player_id, reason, before_json, after_json)
             VALUES (?, ?, ?, ?, ?)`,
            ['RS-F10-PLAYER-PREFIX', 'f10-reset-prefix-player', 'sentinel prefix migration 0030', '{}', '{}']
        );
        await closeQuietly(head29Db);
        head29Db = null;

        migratedDb = await database.criarBanco({ filename });
        const state = await assertDatabaseAtCanonicalMigrationHead(migratedDb);
        assert.equal(state.resetJournalSchemaKind, 'exact');
        assert.equal(state.globalResetFreezeSchemaKind, 'exact');
        assert.equal(
            (await migratedDb.get(
                'SELECT COUNT(*) AS count FROM clover_player_reset_events WHERE operation_code = ?',
                ['RS-F10-PLAYER-PREFIX']
            )).count,
            1
        );
        assert.equal(
            (await migratedDb.get(
                "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='clover_global_player_reset_operations'"
            )).count,
            1
        );
    } finally {
        await closeQuietly(head29Db);
        await closeQuietly(migratedDb);
    }
});

test('0030 falha fechado em journal parcial/divergente sem reparar nem avançar ledger', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-reset-journal-drift-');
    let head29Db;
    let verifyDb;
    try {
        head29Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0029 });
        await ensureGlobalPlayerResetSchema(head29Db);
        await head29Db.exec('DROP INDEX idx_global_player_reset_items_status');
        await closeQuietly(head29Db);
        head29Db = null;

        await assert.rejects(
            () => database.criarBanco({ filename }),
            (error) => error?.code === 'reset_journal_schema_mapping_required'
        );

        verifyDb = await openCloverDatabase({ filename });
        const userVersionRow = await verifyDb.get('PRAGMA user_version');
        assert.equal(Number(Object.values(userVersionRow || {})[0] || 0), 29);
        assert.equal(
            (await verifyDb.get('SELECT COUNT(*) AS count FROM clover_schema_migrations')).count,
            29
        );
        assert.equal(
            (await verifyDb.get(
                "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='index' AND name='idx_global_player_reset_items_status'"
            )).count,
            0
        );
    } finally {
        await closeQuietly(head29Db);
        await closeQuietly(verifyDb);
    }
});

test('0031 adota journal CloverScript runtime exato e preserva runs/actions existentes', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-script-journal-adopt-');
    let head30Db;
    let migratedDb;
    try {
        head30Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0030 });
        await ensureCloverScriptSchema(head30Db);
        const inserted = await head30Db.run(
            `INSERT INTO clover_script_runs
             (code, batch_id, script_hash, script_text, plan_json, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['CS-F10-LEGACY-ADOPT', 'batch-f10-adopt', 'hash-f10', 'ALVO teste', '{}', 'simulated']
        );
        await head30Db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status)
             VALUES (?, ?, ?, ?, ?)`,
            [inserted.lastID, 'f10-script-player', 'probe', 'sentinel 0031', 'pending']
        );
        await closeQuietly(head30Db);
        head30Db = null;

        migratedDb = await database.criarBanco({ filename });
        const state = await assertDatabaseAtCanonicalMigrationHead(migratedDb);
        assert.equal(state.userVersion, 32);
        assert.equal(state.cloverScriptJournalSchemaKind, 'exact');
        assert.equal(state.globalResetFreezeSchemaKind, 'exact');
        assert.equal(state.schemaFingerprintMatchesLatest, true);
        assert.deepEqual(
            await migratedDb.get(
                'SELECT code, batch_id, script_hash, status FROM clover_script_runs WHERE code = ?',
                ['CS-F10-LEGACY-ADOPT']
            ),
            {
                code: 'CS-F10-LEGACY-ADOPT',
                batch_id: 'batch-f10-adopt',
                script_hash: 'hash-f10',
                status: 'simulated',
            }
        );
        assert.equal(
            (await migratedDb.get(
                "SELECT COUNT(*) AS count FROM clover_script_actions WHERE summary='sentinel 0031'"
            )).count,
            1
        );
    } finally {
        await closeQuietly(head30Db);
        await closeQuietly(migratedDb);
    }
});

test('0031 falha fechado em journal CloverScript parcial/divergente sem avançar ledger', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-script-journal-drift-');
    let head30Db;
    let verifyDb;
    try {
        head30Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0030 });
        await ensureCloverScriptSchema(head30Db);
        await head30Db.exec('DROP INDEX idx_clover_script_runs_batch_applied');
        await closeQuietly(head30Db);
        head30Db = null;

        await assert.rejects(
            () => database.criarBanco({ filename }),
            (error) => error?.code === 'clover_script_schema_mapping_required'
        );

        verifyDb = await openCloverDatabase({ filename });
        const userVersionRow = await verifyDb.get('PRAGMA user_version');
        assert.equal(Number(Object.values(userVersionRow || {})[0] || 0), 30);
        assert.equal(
            (await verifyDb.get('SELECT COUNT(*) AS count FROM clover_schema_migrations')).count,
            30
        );
        assert.equal(
            (await verifyDb.get(
                "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='index' AND name='idx_clover_script_runs_batch_applied'"
            )).count,
            0
        );
    } finally {
        await closeQuietly(head30Db);
        await closeQuietly(verifyDb);
    }
});

test('0032 sobe de head 0031 limpo e instala exatamente os triggers de freeze', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-reset-freeze-upgrade-');
    let head31Db;
    let migratedDb;
    try {
        head31Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0031 });
        assert.equal(Number(Object.values((await head31Db.get('PRAGMA user_version')) || {})[0] || 0), 31);
        assert.equal(
            (await head31Db.get(
                "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='trigger' AND name LIKE 'trg_global_player_reset_%'"
            )).count,
            0
        );
        await closeQuietly(head31Db);
        head31Db = null;

        migratedDb = await database.criarBanco({ filename });
        const state = await assertDatabaseAtCanonicalMigrationHead(migratedDb);
        assert.equal(state.userVersion, 32);
        assert.equal(state.globalResetFreezeSchemaKind, 'exact');
        assert.equal(state.schemaFingerprintMatchesLatest, true);
        assert.equal(
            (await migratedDb.get(
                "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='trigger' AND name IN (?, ?, ?, ?, ?, ?)",
                GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS.map((entry) => entry.name)
            )).count,
            GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS.length
        );
    } finally {
        await closeQuietly(head31Db);
        await closeQuietly(migratedDb);
    }
});

test('0032 falha fechado se já existir apenas parte dos triggers de freeze', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-reset-freeze-partial-');
    let head31Db;
    let verifyDb;
    try {
        head31Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0031 });
        await head31Db.exec(GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS[0].sql);
        await closeQuietly(head31Db);
        head31Db = null;

        await assert.rejects(
            () => database.criarBanco({ filename }),
            (error) => error?.code === 'global_reset_journal_freeze_mapping_required'
        );

        verifyDb = await openCloverDatabase({ filename });
        assert.equal(Number(Object.values((await verifyDb.get('PRAGMA user_version')) || {})[0] || 0), 31);
        assert.equal((await verifyDb.get('SELECT COUNT(*) AS count FROM clover_schema_migrations')).count, 31);
        assert.equal(
            (await verifyDb.get("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='trigger' AND name=?", [GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS[0].name])).count,
            1
        );
    } finally {
        await closeQuietly(head31Db);
        await closeQuietly(verifyDb);
    }
});

test('0032 bloqueia adulteração/destruição do plano e permite somente progresso dinâmico', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-reset-freeze-behavior-');
    let db;
    try {
        db = await database.criarBanco({ filename });
        await db.run(
            `INSERT INTO jogadores (id,nome,personagem_nome,dinheiro,raca)
             VALUES ('freeze@lid','Freeze','Personagem Freeze',123,'Humano')`
        );
        const plan = await planGlobalPlayerReset(db, {
            actorId: OWNER,
            reason: 'Plano sintético para provar journal imutável',
            playerIds: ['freeze@lid'],
            selectionSource: 'fixture migration 0032',
            operationId: 'GR-F10-FREEZE-0032',
            metadata: { sentinel: 'frozen' },
        });
        const item = plan.items[0];

        await assert.rejects(
            db.run("UPDATE clover_global_player_reset_operations SET reason='adulterado' WHERE operation_id=?", [plan.operationId]),
            triggerRejectedWith('global_reset_operation_frozen')
        );
        await assert.rejects(
            db.run('UPDATE clover_global_player_reset_items SET ordinal=99 WHERE operation_id=? AND player_id=?', [plan.operationId, item.playerId]),
            triggerRejectedWith('global_reset_item_frozen')
        );
        await assert.rejects(
            db.run('DELETE FROM clover_global_player_reset_items WHERE operation_id=? AND player_id=?', [plan.operationId, item.playerId]),
            triggerRejectedWith('global_reset_item_delete_forbidden')
        );
        await assert.rejects(
            db.run(
                `INSERT INTO clover_global_player_reset_items
                 (operation_id,player_id,ordinal,status,reset_operation_code,planned_snapshot_sha256,preview_json)
                 VALUES (?,?,2,'pending','RS-G-F10-LATE','deadbeef','{}')`,
                [plan.operationId, 'late@lid']
            ),
            triggerRejectedWith('global_reset_population_sealed')
        );
        await assert.rejects(
            db.run('UPDATE clover_global_player_reset_lock SET operation_id=? WHERE operation_id=?', ['GR-F10-OTHER', plan.operationId]),
            triggerRejectedWith('global_reset_lock_update_forbidden')
        );
        await assert.rejects(
            db.run('DELETE FROM clover_global_player_reset_operations WHERE operation_id=?', [plan.operationId]),
            triggerRejectedWith('global_reset_operation_delete_forbidden')
        );

        await db.run(
            `UPDATE clover_global_player_reset_operations
             SET status='running',applied_count=1,reconciled_count=1,execution_token='GX-F10-DYNAMIC'
             WHERE operation_id=?`,
            [plan.operationId]
        );
        await db.run(
            `UPDATE clover_global_player_reset_items
             SET status='processing',attempt_count=1,result_json='{"ok":true}',started_at=CURRENT_TIMESTAMP
             WHERE operation_id=? AND player_id=?`,
            [plan.operationId, item.playerId]
        );
        const operation = await db.get(
            `SELECT status,applied_count,reconciled_count,execution_token,reason,selection_source
             FROM clover_global_player_reset_operations WHERE operation_id=?`,
            [plan.operationId]
        );
        assert.deepEqual(operation, {
            status: 'running',
            applied_count: 1,
            reconciled_count: 1,
            execution_token: 'GX-F10-DYNAMIC',
            reason: 'Plano sintético para provar journal imutável',
            selection_source: 'fixture migration 0032',
        });
        assert.equal(
            (await db.get(
                'SELECT status,attempt_count FROM clover_global_player_reset_items WHERE operation_id=? AND player_id=?',
                [plan.operationId, item.playerId]
            )).status,
            'processing'
        );
        assert.equal((await assertDatabaseAtCanonicalMigrationHead(db)).globalResetFreezeSchemaKind, 'exact');
    } finally {
        await closeQuietly(db);
    }
});

test('runtime reset ensures são no-op estrutural no head 0032 e não alteram fingerprint', async (t) => {
    const filename = makeTempDatabase(t, 'clover-f10-reset-runtime-no-ddl-');
    let db;
    try {
        db = await database.criarBanco({ filename });
        const before = await assertDatabaseAtCanonicalMigrationHead(db);
        await ensureCloverScriptSchema(db);
        await ensurePlayerResetSchema(db);
        await ensureGlobalPlayerResetSchema(db);
        const after = await assertDatabaseAtCanonicalMigrationHead(db);
        assert.equal(after.schemaFingerprintMatchesLatest, true);
        assert.equal(after.currentSchemaFingerprint, before.currentSchemaFingerprint);
        assert.deepEqual(comparableLedger(after), comparableLedger(before));
    } finally {
        await closeQuietly(db);
    }
});
