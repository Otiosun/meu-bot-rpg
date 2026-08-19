'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    MIGRATION_TABLE,
    columnExists,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    RAID_V1_BRIDGE_ALLOWED_PARTICIPANT_STATUSES,
    RAID_V1_BRIDGE_ALLOWED_RAID_STATUSES,
    RAID_V1_BRIDGE_MIGRATION,
    RAID_V1_BRIDGE_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0020-raid-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function createOldRaidSchema(db) {
    await db.exec(`
        CREATE TABLE clover_raids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'rascunho',
            slots INTEGER DEFAULT NULL,
            event_date TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            simulation_code TEXT DEFAULT NULL,
            applied_run_code TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_raid_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'inscrito',
            tags_json TEXT DEFAULT '[]',
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (raid_id, player_id)
        );
    `);
}

async function createModernRaidSchema(db) {
    await db.exec(`
        CREATE TABLE clover_raids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'missao',
            description TEXT DEFAULT NULL,
            location TEXT DEFAULT 'Capital de Clover',
            status TEXT NOT NULL DEFAULT 'lobby'
                CHECK (status IN ('lobby', 'in_progress', 'finalization', 'completed', 'cancelled')),
            owner_player_id TEXT NOT NULL,
            max_players INTEGER NOT NULL DEFAULT 12 CHECK (max_players BETWEEN 1 AND 50),
            salary_eligible INTEGER NOT NULL DEFAULT 1 CHECK (salary_eligible IN (0, 1)),
            rules_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT DEFAULT NULL,
            finalization_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            cancelled_by TEXT DEFAULT NULL,
            cancellation_reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_raid_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'joined'
                CHECK (status IN ('joined', 'active', 'completed', 'removed', 'withdrawn')),
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            joined_via TEXT DEFAULT 'site',
            removed_at TEXT DEFAULT NULL,
            removed_by TEXT DEFAULT NULL,
            removal_reason TEXT DEFAULT NULL,
            snapshot_json TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (raid_id, player_id)
        );
    `);
}

async function run0020(db) {
    return runCloverSchemaMigrations(db, { migrations: [RAID_V1_BRIDGE_MIGRATION] });
}

async function ledgerVersions(db) {
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    return rows.map((row) => Number(row.version));
}

test('0020 possui exatamente 20 targets do bridge V1 e exclui V2, rewards e finalização', () => {
    assert.equal(RAID_V1_BRIDGE_TARGETS.length, 20);
    const keys = RAID_V1_BRIDGE_TARGETS.map((target) => `${target.table}.${target.column}`);
    assert.equal(new Set(keys).size, 20);
    assert.deepEqual(
        [...new Set(RAID_V1_BRIDGE_TARGETS.map((target) => target.table))].sort(),
        ['clover_raid_participants', 'clover_raids']
    );
    const forbidden = new Set([
        'clover_raids.category_key',
        'clover_raids.scope_type',
        'clover_raids.month_key',
        'clover_raid_participants.finalization_status',
        'clover_raid_rewards.target_type',
        'clover_raid_rewards.resource_key',
    ]);
    for (const key of keys) assert.equal(forbidden.has(key), false, key);
    assert.deepEqual(
        RAID_V1_BRIDGE_ALLOWED_RAID_STATUSES,
        ['lobby', 'in_progress', 'finalization', 'completed', 'cancelled']
    );
    assert.deepEqual(
        RAID_V1_BRIDGE_ALLOWED_PARTICIPANT_STATUSES,
        ['joined', 'active', 'completed', 'removed', 'withdrawn']
    );
});

test('0020 converte schema pré-V1 reconciliado, copia identidade/capacidade e preserva legado', async (t) => {
    const db = await openTestDatabase(t);
    await createOldRaidSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raids
         (code, name, status, slots, event_date, created_by, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['legacy-raid', 'Raid Legada', 'lobby', 7, '2026-07-20', 'owner-old',
            '2026-07-18 01:02:03', '2026-07-18 04:05:06', '{"legacy":true}']
    );
    await db.run(
        `INSERT INTO clover_raid_participants
         (raid_id, player_id, status, tags_json, joined_at, updated_at)
         VALUES (?, ?, 'joined', ?, ?, ?)`,
        [inserted.lastID, 'player-old', '["tag-antiga"]', '2026-07-18 05:00:00', '2026-07-18 06:00:00']
    );

    const first = await run0020(db);
    assert.equal(first.latestVersion, 20);
    assert.equal(first.appliedCount, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 20);
    assert.deepEqual(await ledgerVersions(db), [20]);

    for (const target of RAID_V1_BRIDGE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }

    const raid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]);
    assert.equal(raid.code, 'legacy-raid');
    assert.equal(raid.raid_key, 'legacy-raid');
    assert.equal(raid.name, 'Raid Legada');
    assert.equal(raid.slots, 7);
    assert.equal(raid.max_players, 7);
    assert.equal(raid.created_by, 'owner-old');
    assert.equal(raid.owner_player_id, 'owner-old');
    assert.equal(raid.category, 'missao');
    assert.equal(raid.location, 'Capital de Clover');
    assert.equal(raid.salary_eligible, 1);
    assert.equal(raid.event_date, '2026-07-20');
    assert.equal(raid.metadata_json, '{"legacy":true}');

    const participant = await db.get(
        'SELECT * FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?',
        [inserted.lastID, 'player-old']
    );
    assert.equal(participant.tags_json, '["tag-antiga"]');
    assert.equal(participant.joined_via, 'site');
    assert.equal(participant.removed_at, null);
    assert.equal(participant.snapshot_json, null);

    const index = await db.get(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_clover_raids_raid_key'"
    );
    assert.match(index?.sql || '', /UNIQUE INDEX/i);
    assert.match(index?.sql || '', /WHERE raid_key IS NOT NULL/i);

    const beforeSecond = JSON.stringify({
        raids: await db.all('PRAGMA table_info(clover_raids)'),
        participants: await db.all('PRAGMA table_info(clover_raid_participants)'),
        raid,
        participant,
    });
    const second = await run0020(db);
    assert.equal(second.appliedCount, 0);
    assert.equal(JSON.stringify({
        raids: await db.all('PRAGMA table_info(clover_raids)'),
        participants: await db.all('PRAGMA table_info(clover_raid_participants)'),
        raid: await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]),
        participant: await db.get(
            'SELECT * FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?',
            [inserted.lastID, 'player-old']
        ),
    }), beforeSecond);
});

test('0020 falha fechado para status pré-V1 de raid e reverte todo DDL', async (t) => {
    const db = await openTestDatabase(t);
    await createOldRaidSchema(db);
    await db.run(
        `INSERT INTO clover_raids (code, name, status, slots, created_by)
         VALUES ('old-status', 'Old Status', 'rascunho', 5, 'legacy-owner')`
    );

    await assert.rejects(
        run0020(db),
        (error) => error?.code === 'raid_v1_status_mapping_required'
            && error?.table === 'clover_raids'
            && error?.statuses?.includes('rascunho')
    );
    assert.equal(await columnExists(db, 'clover_raids', 'raid_key'), false);
    assert.equal(await columnExists(db, 'clover_raid_participants', 'joined_via'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0020 falha fechado para status pré-V1 de participante e reverte todo DDL', async (t) => {
    const db = await openTestDatabase(t);
    await createOldRaidSchema(db);
    const raid = await db.run(
        `INSERT INTO clover_raids (code, name, status, slots, created_by)
         VALUES ('modern-status', 'Modern Status', 'lobby', 5, 'legacy-owner')`
    );
    await db.run(
        `INSERT INTO clover_raid_participants (raid_id, player_id, status)
         VALUES (?, 'legacy-player', 'inscrito')`,
        [raid.lastID]
    );

    await assert.rejects(
        run0020(db),
        (error) => error?.code === 'raid_v1_status_mapping_required'
            && error?.table === 'clover_raid_participants'
            && error?.statuses?.includes('inscrito')
    );
    assert.equal(await columnExists(db, 'clover_raids', 'raid_key'), false);
    assert.equal(await columnExists(db, 'clover_raid_participants', 'joined_via'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0020 é schema-no-op no CREATE moderno e não reintroduz code/slots/created_by', async (t) => {
    const db = await openTestDatabase(t);
    await createModernRaidSchema(db);
    const raid = await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, status, owner_player_id, max_players, salary_eligible, metadata_json)
         VALUES ('modern-1', 'Modern Raid', 'missao', 'completed', 'owner-new', 11, 0, '{"modern":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_participants (raid_id, player_id, status, joined_via)
         VALUES (?, 'modern-player', 'completed', 'site')`,
        [raid.lastID]
    );

    const raidSchemaBefore = JSON.stringify(await db.all('PRAGMA table_info(clover_raids)'));
    const participantSchemaBefore = JSON.stringify(await db.all('PRAGMA table_info(clover_raid_participants)'));
    const raidBefore = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.lastID]);

    await run0020(db);

    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(clover_raids)')), raidSchemaBefore);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(clover_raid_participants)')), participantSchemaBefore);
    assert.deepEqual(await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.lastID]), raidBefore);
    assert.equal(await columnExists(db, 'clover_raids', 'code'), false);
    assert.equal(await columnExists(db, 'clover_raids', 'slots'), false);
    assert.equal(await columnExists(db, 'clover_raids', 'created_by'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 20);
    assert.deepEqual(await ledgerVersions(db), [20]);
    const index = await db.get(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_clover_raids_raid_key'"
    );
    assert.ok(index);
});
