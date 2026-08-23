'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const legacyDatabase = require('../database/legacy');
const { observeCloverDatabaseConnection } = require('../helpers/clover/databaseConnection');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationCatalog');
const {
    computeSchemaFingerprint,
    inspectCloverMigrationState,
} = require('../helpers/clover/schemaMigrationService');
const { columnExists } = require('../helpers/clover/schemaMigrationService');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { prebootstrapCloverSchemaBeforeLegacy } = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    ITEM_TEMPLATES_TARGETS,
    INVENTORY_ITEMS_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');
const { assertSqliteOwnership } = require('../helpers/clover/sqliteOwnershipAudit');

function temporaryFilename(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-phase2-final-gate-'));
    const filename = path.join(directory, 'database.sqlite');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return filename;
}

async function startup(filename) {
    const db = await database.criarBanco({ filename });
    const observed = await observeCloverDatabaseConnection(db);
    const state = await inspectCloverMigrationState(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    const fingerprint = await computeSchemaFingerprint(db);
    return { db, observed, state, fingerprint };
}

async function assertPhysicalIntegrity(db) {
    const quick = await db.get('PRAGMA quick_check');
    const integrity = await db.get('PRAGMA integrity_check');
    assert.equal(Object.values(quick)[0], 'ok');
    assert.equal(Object.values(integrity)[0], 'ok');
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    await db.all('PRAGMA wal_checkpoint(PASSIVE)');
}

async function stableRowsDigest(db, table, columns) {
    const rows = await db.all(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.join(', ')}`);
    return JSON.stringify(rows);
}

function normalizedTableDigest(rows) {
    return JSON.stringify(rows.map((row) => Object.fromEntries(
        Object.entries(row).filter(([key]) => !/(?:^|_)(?:created|updated|completed|reviewed|released|consumed)_at$/.test(key)),
    )));
}

test('gate final: fresh, repeticao e fixture legada preservam schema, ledger e dados', async (t) => {
    const filename = temporaryFilename(t);
    const first = await startup(filename);
    try {
        assert.equal(first.observed.journalMode, 'wal');
        assert.equal(first.observed.busyTimeoutMs, 10_000);
        assert.equal(first.observed.foreignKeys, 1);
        assert.equal(first.state.userVersion, CURRENT_SCHEMA_MIGRATIONS.at(-1).version);
        assert.equal(first.state.applied.length, CURRENT_SCHEMA_MIGRATIONS.length);
        assert.equal(first.state.schemaFingerprintMatchesLatest, true);
        await assertPhysicalIntegrity(first.db);

        await first.db.run('INSERT INTO jogadores (id, nome, dinheiro) VALUES (?, ?, ?)', ['player-final', 'Final Gate', 77]);
        await first.db.run('INSERT INTO player_progress (player_id, ph_total, ph_bonus) VALUES (?, ?, ?)', ['player-final', 12, 3]);
        await first.db.run(`
            INSERT INTO clover_raids (raid_key, name, owner_player_id, status, scope_type, counts_monthly)
            VALUES (?, ?, ?, ?, ?, ?)
        `, ['final-gate-raid', 'Final gate raid', 'player-final', 'lobby', 'global', 0]);
    } finally {
        await first.db.close();
    }

    const second = await startup(filename);
    try {
        assert.equal(second.fingerprint, first.fingerprint);
        assert.deepEqual(
            await second.db.get('SELECT nome, dinheiro FROM jogadores WHERE id = ?', ['player-final']),
            { nome: 'Final Gate', dinheiro: 77 },
        );
        assert.deepEqual(
            await second.db.get('SELECT ph_total, ph_bonus FROM player_progress WHERE player_id = ?', ['player-final']),
            { ph_total: 12, ph_bonus: 3 },
        );
        assert.equal((await second.db.get('SELECT COUNT(*) AS count FROM clover_raids WHERE raid_key = ?', ['final-gate-raid'])).count, 1);
    } finally {
        await second.db.close();
    }

    const third = await startup(filename);
    try {
        assert.equal(third.fingerprint, first.fingerprint);
        assert.equal(third.state.userVersion, CURRENT_SCHEMA_MIGRATIONS.at(-1).version);
        assert.equal(third.state.applied.at(-1).migration_key, CURRENT_SCHEMA_MIGRATIONS.at(-1).key);
        assert.equal((await third.db.get('SELECT COUNT(*) AS count FROM jogadores WHERE id = ?', ['player-final'])).count, 1);
        assert.equal((await third.db.get('SELECT COUNT(*) AS count FROM player_progress WHERE player_id = ?', ['player-final'])).count, 1);
        assert.equal((await third.db.get('SELECT COUNT(*) AS count FROM clover_raids WHERE raid_key = ?', ['final-gate-raid'])).count, 1);
        await assertPhysicalIntegrity(third.db);
    } finally {
        await third.db.close();
    }
});

test('gate final: ownership do runtime continua deterministico e fail-closed', () => {
    const audit = assertSqliteOwnership(path.join(__dirname, '..'));
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.blockers, []);
});

test('prebootstrap canonico torna legacy schema-no-op na mesma conexao injetada', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prebootstrap-legacy-noop-'));
    const filename = path.join(directory, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    for (const target of ITEM_TEMPLATES_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of INVENTORY_ITEMS_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    const beforeFingerprint = await computeSchemaFingerprint(db);
    const beforeObjects = await db.all(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`);
    const beforeVersion = await db.get('PRAGMA user_version');
    const beforeLedger = await db.get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'clover_schema_migrations'");

    await legacyDatabase.criarBanco(db);

    const afterObjects = await db.all(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`);
    assert.deepEqual(afterObjects.map((item) => item.name), beforeObjects.map((item) => item.name));
    assert.equal(await computeSchemaFingerprint(db), beforeFingerprint);
    assert.deepEqual(afterObjects, beforeObjects);
    assert.deepEqual(await db.get('PRAGMA user_version'), beforeVersion);
    assert.deepEqual(await db.get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'clover_schema_migrations'"), beforeLedger);
});

test('upgrade legado real preserva dados anteriores e reabre em no-op', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-true-legacy-upgrade-'));
    const filename = path.join(directory, 'database.sqlite');
    const legacy = await openCloverDatabase({ filename });
    await legacy.exec(`
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, nome TEXT, dinheiro INTEGER DEFAULT 0);
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
    await legacy.run('INSERT INTO jogadores (id, nome, dinheiro) VALUES (?, ?, ?)', ['legacy-player', 'Histórico', 91]);
    await legacy.run('INSERT INTO clover_inventory_items (player_id, item_name) VALUES (?, ?)', ['legacy-player', 'Relíquia histórica']);
    const before = {
        players: await stableRowsDigest(legacy, 'jogadores', ['id', 'nome', 'dinheiro']),
        inventory: await stableRowsDigest(legacy, 'clover_inventory_items', ['id', 'player_id', 'item_name']),
    };
    await legacy.close();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const upgraded = await startup(filename);
    try {
        assert.equal(upgraded.state.userVersion, CURRENT_SCHEMA_MIGRATIONS.at(-1).version);
        assert.deepEqual(upgraded.state.applied.map((row) => row.version), CURRENT_SCHEMA_MIGRATIONS.map((migration) => migration.version));
        assert.equal(await stableRowsDigest(upgraded.db, 'jogadores', ['id', 'nome', 'dinheiro']), before.players);
        assert.equal(await stableRowsDigest(upgraded.db, 'clover_inventory_items', ['id', 'player_id', 'item_name']), before.inventory);
        assert.equal((await upgraded.db.get('SELECT seq FROM sqlite_sequence WHERE name = ?', ['clover_inventory_items'])).seq, 1);
        assert.equal((await upgraded.db.get('SELECT COUNT(*) AS count FROM clover_raid_monthly_ledger')).count, 0);
        assert.equal((await upgraded.db.get('SELECT COUNT(*) AS count FROM clover_raid_reward_review_intents')).count, 0);
        assert.equal((await upgraded.db.get('SELECT COUNT(*) AS count FROM clover_raid_reward_proposal_revisions')).count, 0);
    } finally {
        await upgraded.db.close();
    }

    const reopened = await startup(filename);
    try {
        assert.equal(reopened.state.applied.length, CURRENT_SCHEMA_MIGRATIONS.length);
        assert.equal(await stableRowsDigest(reopened.db, 'jogadores', ['id', 'nome', 'dinheiro']), before.players);
        assert.equal(await stableRowsDigest(reopened.db, 'clover_inventory_items', ['id', 'player_id', 'item_name']), before.inventory);
    } finally {
        await reopened.db.close();
    }
});

test('fixture sintetica realista preserva os dominios criticos sem replay', async (t) => {
    const filename = temporaryFilename(t);
    const first = await startup(filename);
    let digest;
    try {
        await first.db.run('INSERT INTO jogadores (id, nome) VALUES (?, ?)', ['synthetic-player', 'Sintético']);
        await first.db.run('INSERT INTO player_progress (player_id, ph_total) VALUES (?, ?)', ['synthetic-player', 8]);
        await first.db.run('INSERT INTO clover_inventory_items (player_id, item_name) VALUES (?, ?)', ['synthetic-player', 'Item sintético']);
        const raid = await first.db.run(`INSERT INTO clover_raids (raid_key, name, owner_player_id, status, scope_type, counts_monthly)
            VALUES (?, ?, ?, 'lobby', 'global', 0)`, ['synthetic-raid', 'Raid sintética', 'synthetic-player']);
        await first.db.run('INSERT INTO clover_raid_participants (raid_id, player_id) VALUES (?, ?)', [raid.lastID, 'synthetic-player']);
        const reward = await first.db.run(`INSERT INTO clover_raid_rewards
            (raid_id, target_type, reward_type, amount, label, created_by) VALUES (?, 'player', 'yulls', 5, 'Sintético', 'system')`, [raid.lastID]);
        await first.db.run('INSERT INTO clover_raid_reward_deliveries (raid_id, reward_id, player_id) VALUES (?, ?, ?)', [raid.lastID, reward.lastID, 'synthetic-player']);
        await first.db.run(`INSERT INTO clover_raid_mutation_requests
            (idempotency_key, operation, fingerprint, actor_id, raid_id, status) VALUES (?, ?, ?, ?, ?, 'completed')`, ['synthetic-mutation', 'join', 'mutation-fingerprint', 'synthetic-player', raid.lastID]);
        const proposal = await first.db.run('INSERT INTO clover_raid_reward_proposals (raid_id, proposed_by, snapshot_hash) VALUES (?, ?, ?)', [raid.lastID, 'synthetic-player', 'proposal-hash']);
        await first.db.run(`INSERT INTO clover_raid_reward_review_intents
            (idempotency_key, proposal_id, raid_id, actor_id, decision, fingerprint, status)
            VALUES (?, ?, ?, ?, 'approve', ?, 'completed')`, ['synthetic-review', proposal.lastID, raid.lastID, 'reviewer', 'review-fingerprint']);
        await first.db.run(`INSERT INTO clover_raid_monthly_reservations
            (raid_id, category_key, month_key, scope_type, scope_key) VALUES (?, 'mission', '2026-08', 'player', ?)`, [raid.lastID, 'synthetic-player']);
        await first.db.run(`INSERT INTO clover_raid_monthly_ledger
            (entry_key, raid_id, category_key, month_key, scope_type, scope_key, amount, kind)
            VALUES ('synthetic-ledger', ?, 'mission', '2026-08', 'player', ?, 1, 'adjustment')`, [raid.lastID, 'synthetic-player']);
        const tables = [
            'jogadores', 'player_progress', 'clover_inventory_items', 'clover_raids', 'clover_raid_participants',
            'clover_raid_rewards', 'clover_raid_reward_deliveries', 'clover_raid_mutation_requests',
            'clover_raid_reward_proposals', 'clover_raid_reward_proposal_authors', 'clover_raid_reward_proposal_revisions',
            'clover_raid_reward_review_intents', 'clover_raid_monthly_reservations', 'clover_raid_monthly_ledger',
        ];
        digest = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, normalizedTableDigest(await first.db.all(`SELECT * FROM ${table} ORDER BY 1`))])));
        assert.equal((await first.db.get('SELECT COUNT(*) AS count FROM clover_raid_reward_review_events')).count, 0);
    } finally {
        await first.db.close();
    }
    const reopened = await startup(filename);
    try {
        for (const [table, expected] of Object.entries(digest)) {
            assert.equal(normalizedTableDigest(await reopened.db.all(`SELECT * FROM ${table} ORDER BY 1`)), expected, table);
        }
        assert.equal((await reopened.db.get('SELECT COUNT(*) AS count FROM clover_raid_reward_review_events')).count, 0);
    } finally {
        await reopened.db.close();
    }
});
