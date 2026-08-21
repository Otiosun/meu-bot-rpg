'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const legacyDatabase = require('../database/legacy');
const { criarBanco, resolveSchemaMigrations } = require('../database');
const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const { CORE_MIGRATIONS, MIGRATION_TABLE, columnExists } = require('../helpers/clover/schemaMigrationService');
const {
    APPEARANCE_MODERATION_TARGETS,
    CHARACTER_IDENTITY_TARGETS,
    CHARACTER_TRAITS_TARGETS,
    CURRENT_SCHEMA_MIGRATIONS,
    GAME_STATE_TARGETS,
    MARKET_REQUEST_TARGETS,
    PLAYER_PATENT_TARGETS,
    PLAYER_PROFILE_TARGETS,
    ROLL_ATTEMPT_STATE_TARGETS,
    SITE_PROFILE_IMAGE_TARGETS,
    STORY_STATE_TARGETS,
    SQUAD_COLUMNS_TARGETS,
    RAID_V1_BRIDGE_TARGETS,
    RAID_V2_COLUMNS_TARGETS,
    RAID_PARTICIPANT_FINALIZATION_TARGETS,
    RAID_REWARDS_V1_TABLE_SQL,
    RAID_REWARDS_V2_KEY,
    inspectRaidRewardsSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

function tempDatabasePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-catalog-'));
    return path.join(dir, 'database.sqlite');
}

async function createCurrentPrerequisites(db) {
    await db.exec(`
        CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY, ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0);
        CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY, roll_basis_points INTEGER DEFAULT NULL);
        CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY, expires_at TEXT DEFAULT NULL);
        CREATE TABLE clover_consumable_uses (id INTEGER PRIMARY KEY, effect_category TEXT DEFAULT NULL);
        CREATE TABLE player_onboarding (player_id TEXT PRIMARY KEY, step_payload TEXT DEFAULT '{}');
        CREATE TABLE pending_magic_confirmations (player_id TEXT PRIMARY KEY, magic_label TEXT NOT NULL, roll_number INTEGER DEFAULT NULL);
        CREATE TABLE group_settings (group_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, reception_enabled INTEGER DEFAULT 0, reception_type TEXT DEFAULT NULL);
        CREATE TABLE clover_market_listings (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_weekly_npc_requests (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_quick_evaluations (id INTEGER PRIMARY KEY);
        CREATE TABLE player_rolls (player_id TEXT NOT NULL, roll_number INTEGER NOT NULL, PRIMARY KEY (player_id, roll_number));
        CREATE TABLE clover_item_templates (template_key TEXT PRIMARY KEY);
        CREATE TABLE clover_inventory_items (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL, item_name TEXT NOT NULL);
        CREATE TABLE clover_admin_service_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            evaluator_id TEXT NOT NULL,
            modality_key TEXT NOT NULL,
            modality_label TEXT NOT NULL,
            weight INTEGER NOT NULL DEFAULT 0,
            points INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'quick_evaluation',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_squads (squad_key TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE clover_raids (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'lobby', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE clover_raid_participants (id INTEGER PRIMARY KEY, raid_id INTEGER NOT NULL, player_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'joined', joined_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, nome TEXT);
    `);
    await db.exec(RAID_REWARDS_V1_TABLE_SQL);
    await db.exec(`
        CREATE INDEX idx_clover_raid_rewards_raid
        ON clover_raid_rewards (raid_id, status, id)
    `);
}

test('catálogo atual é usado no legacy real e fixtures custom continuam no catálogo core por padrão', () => {
    assert.strictEqual(resolveSchemaMigrations({}, legacyDatabase.criarBanco), CURRENT_SCHEMA_MIGRATIONS);
    assert.strictEqual(resolveSchemaMigrations({}, async () => {}), CORE_MIGRATIONS);
    assert.strictEqual(
        resolveSchemaMigrations({ migrations: CURRENT_SCHEMA_MIGRATIONS }, async () => {}),
        CURRENT_SCHEMA_MIGRATIONS
    );
});

test('fixture explícita consegue reproduzir o catálogo atual até a 0023', async (t) => {
    const filename = tempDatabasePath();
    let legacyObserved0004 = false;

    const seed = await openCloverDatabase({ filename });
    await createCurrentPrerequisites(seed);
    await seed.close();

    const db = await criarBanco({
        migrations: CURRENT_SCHEMA_MIGRATIONS,
        openMigrationDatabase: (options) => openCloverDatabase({ ...options, filename }),
        createLegacyDatabase: async () => {
            const connection = await openCloverDatabase({ filename });
            legacyObserved0004 = await columnExists(connection, 'clover_market_listings', 'idempotency_key');
            return connection;
        },
    });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    assert.equal(legacyObserved0004, false, 'sem baseline, primeira adoção continua legacy-first');
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 23);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]);
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.at(-1)?.key, RAID_REWARDS_V2_KEY);
    for (const target of MARKET_REQUEST_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of PLAYER_PROFILE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of CHARACTER_IDENTITY_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of APPEARANCE_MODERATION_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of SITE_PROFILE_IMAGE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of CHARACTER_TRAITS_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of ROLL_ATTEMPT_STATE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of STORY_STATE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of GAME_STATE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of PLAYER_PATENT_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of SQUAD_COLUMNS_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of RAID_V1_BRIDGE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of RAID_V2_COLUMNS_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of RAID_PARTICIPANT_FINALIZATION_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    const rewards = await inspectRaidRewardsSchemaState(db);
    assert.equal(rewards.kind, 'v2');
    assert.equal(rewards.indexValid, true);
});
