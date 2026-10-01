'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const database = require('../database');
const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    ADMIN_SERVICE_TARGETS,
    APPEARANCE_MODERATION_TARGETS,
    CHARACTER_IDENTITY_TARGETS,
    CHARACTER_TRAITS_TARGETS,
    CURRENT_SCHEMA_MIGRATIONS,
    GAME_STATE_TARGETS,
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
    RAID_MONTHLY_PROGRESS_KEY,
    RAID_SUPPORT_INDEXES,
    RAID_SUPPORT_TABLES,
    RAID_IDEMPOTENCY_REQUESTS_INDEXES,
    RAID_IDEMPOTENCY_REQUESTS_KEY,
    RAID_IDEMPOTENCY_REQUESTS_TABLES,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
    RAID_REWARD_PROPOSAL_HISTORY_KEY,
    SKILL_TREE_CATALOG_KEY,
    PROFILE_PRESENTATION_KEY,
    inspectProfilePresentationSchemaState,
    inspectSkillTreeCatalogSchemaState,
    inspectRaidIdempotencyRequestsSchemaState,
    inspectRaidRewardProposalHistorySchemaState,
    inspectRaidRewardProposalIdempotencySchemaState,
    inspectRaidMonthlyProgressSchemaState,
    inspectRaidSupportSchemaState,
    inspectRaidRewardsSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');
const { MIGRATED_BASE_TABLES } = require('../helpers/clover/schemaBaseCatalog');
const {
    MIGRATION_TABLE,
    columnExists,
    tableExists,
} = require('../helpers/clover/schemaMigrationService');
const {
    collectMigratedColumnTargets,
    findCreateTableBody,
} = require('../helpers/clover/schemaBaseConsolidationAudit');
const {
    DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS,
    prebootstrapCloverSchemaBeforeLegacy,
} = require('../helpers/clover/schemaBasePrebootstrapService');

const MIGRATIONS_THROUGH_0008 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 8));

function tempDatabasePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prebootstrap-'));
    return path.join(dir, 'database.sqlite');
}

function normalizeSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function createExactRaidSupportFixture(db) {
    for (const table of RAID_SUPPORT_TABLES) {
        await db.exec(table.sql);
    }
    for (const index of RAID_SUPPORT_INDEXES) {
        await db.exec(index.sql);
    }
}

test('catálogo base reproduz os 19 CREATE TABLE canônicos do legacy atual e indexa Rewards somente no create', () => {
    const legacySource = fs.readFileSync(path.join(__dirname, '..', 'database', 'legacy.js'), 'utf8');
    assert.equal(MIGRATED_BASE_TABLES.length, 19);
    for (const entry of MIGRATED_BASE_TABLES) {
        const legacyBody = findCreateTableBody(legacySource, entry.table);
        const openParen = entry.sql.indexOf('(');
        const closeParen = entry.sql.lastIndexOf(')');
        const catalogBody = openParen >= 0 && closeParen > openParen
            ? entry.sql.slice(openParen + 1, closeParen)
            : null;
        assert.ok(legacyBody, `CREATE ausente no legacy: ${entry.table}`);
        assert.ok(catalogBody, `CREATE ausente no catálogo: ${entry.table}`);
        assert.equal(normalizeSql(catalogBody), normalizeSql(legacyBody), entry.table);
    }

    const rewardsBase = MIGRATED_BASE_TABLES.find((entry) => entry.table === 'clover_raid_rewards');
    assert.ok(rewardsBase);
    assert.equal(rewardsBase.onCreateSql?.length, 1);
    assert.match(
        normalizeSql(rewardsBase.onCreateSql[0]),
        /^CREATE INDEX idx_clover_raid_rewards_raid ON clover_raid_rewards \(raid_id, status, id\)$/
    );
});

test('pre-bootstrap vazio cria 19 bases e executa migrations canônicas sem ledger nem user_version', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    const result = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });

    assert.equal(result.prebootstrappedBeforeLegacy, true);
    assert.equal(result.baseTablesCreatedOrPresent, 19);
    assert.equal(result.transientMigrationCount, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length);
    assert.deepEqual(result.transientMigrations.map((item) => item.key), DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS);
    assert.equal(result.transientMigrations.some((item) => item.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    assert.equal(result.transientMigrations.some((item) => item.key === SKILL_TREE_CATALOG_KEY), true);
    assert.equal(result.transientMigrations.some((item) => item.key === PROFILE_PRESENTATION_KEY), true);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);

    for (const entry of MIGRATED_BASE_TABLES) {
        assert.equal(await tableExists(db, entry.table), true, entry.table);
    }
    for (const target of collectMigratedColumnTargets()) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of ADMIN_SERVICE_TARGETS) {
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
    const finalizationIndex = await db.all('PRAGMA index_info(idx_clover_raid_participant_finalization)');
    assert.deepEqual(
        finalizationIndex.sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((row) => row.name),
        ['raid_id', 'finalization_status', 'status', 'id']
    );
    const rewardsState = await inspectRaidRewardsSchemaState(db);
    assert.equal(rewardsState.kind, 'v2');
    assert.equal(rewardsState.indexValid, true);
    assert.deepEqual(rewardsState.unexpectedIndexes, []);
    assert.deepEqual(rewardsState.triggers, []);
    assert.deepEqual(rewardsState.dependentSchemaObjects, []);
    assert.deepEqual(rewardsState.inboundForeignKeys, []);
    const monthlyState = await inspectRaidMonthlyProgressSchemaState(db);
    assert.equal(monthlyState.kind, 'exact');
    assert.equal(monthlyState.indexValid, true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_reservations')).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_ledger')).n, 0);
    const supportState = await inspectRaidSupportSchemaState(db);
    assert.equal(supportState.kind, 'exact');
    assert.equal(supportState.indexValid, true);
    for (const table of supportState.tables) {
        assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n, 0, table.name);
    }
    const idempotencyState = await inspectRaidIdempotencyRequestsSchemaState(db);
    assert.equal(idempotencyState.kind, 'exact');
    assert.equal(idempotencyState.indexValid, true);
    assert.deepEqual(idempotencyState.tables.map((entry) => entry.name), RAID_IDEMPOTENCY_REQUESTS_TABLES.map((entry) => entry.name));
    assert.deepEqual(idempotencyState.indexes.map((entry) => entry.name), RAID_IDEMPOTENCY_REQUESTS_INDEXES.map((entry) => entry.name));
    for (const table of idempotencyState.tables) {
        assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n, 0, table.name);
    }
    const proposalIdempotencyState = await inspectRaidRewardProposalIdempotencySchemaState(db);
    assert.equal(proposalIdempotencyState.base.kind, 'exact');
    assert.equal(proposalIdempotencyState.idempotency.kind, 'exact');
    assert.equal((await inspectRaidRewardProposalHistorySchemaState(db)).history.kind, 'exact');
    const treeCatalogState = await inspectSkillTreeCatalogSchemaState(db);
    assert.equal(treeCatalogState.kind, 'exact');
    const profilePresentationState = await inspectProfilePresentationSchemaState(db);
    assert.equal(profilePresentationState.kind, 'exact');

    const second = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });
    assert.equal(second.afterFingerprint, result.afterFingerprint);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('pre-bootstrap 0019 atualiza clover_squads legado preservando dados e sem adotar o banco', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    await db.exec(`
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            historical_stars INTEGER DEFAULT 0,
            current_stars INTEGER DEFAULT 0,
            black_stars INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, historical_stars, current_stars, black_stars, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['black-bulls', 'Touros Negros', 41, 7, 2, '2026-08-01 12:00:00']
    );

    const before = await db.get(
        `SELECT squad_key, name, historical_stars, current_stars, black_stars, updated_at
         FROM clover_squads WHERE squad_key = ?`,
        ['black-bulls']
    );

    const result = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });

    assert.equal(result.transientMigrationCount, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length);
    assert.equal(result.transientMigrations.some((item) => item.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    for (const target of SQUAD_COLUMNS_TARGETS) {
        assert.equal(await columnExists(db, 'clover_squads', target.column), true, target.column);
    }

    const after = await db.get(
        `SELECT squad_key, name, historical_stars, current_stars, black_stars, updated_at,
                group_id, phrase, captain_name, captain_player_id, vice_captain_player_id,
                description_synced_at, description_sync_status, description_sync_error
         FROM clover_squads WHERE squad_key = ?`,
        ['black-bulls']
    );
    assert.deepEqual(
        {
            squad_key: after.squad_key,
            name: after.name,
            historical_stars: after.historical_stars,
            current_stars: after.current_stars,
            black_stars: after.black_stars,
            updated_at: after.updated_at,
        },
        before
    );
    assert.equal(after.group_id, null);
    assert.equal(after.phrase, null);
    assert.equal(after.captain_name, null);
    assert.equal(after.captain_player_id, null);
    assert.equal(after.vice_captain_player_id, null);
    assert.equal(after.description_synced_at, null);
    assert.equal(after.description_sync_status, null);
    assert.equal(after.description_sync_error, null);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});


test('pre-bootstrap 0026 atualiza Raid legado ate tabelas auxiliares sem retroatividade preservando dados e sem adotar o banco', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

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

    const inserted = await db.run(
        `INSERT INTO clover_raids
         (code, name, status, slots, event_date, created_by, created_at, updated_at,
          simulation_code, applied_run_code, metadata_json)
         VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'legacy-prebootstrap', 'Raid V1 Antiga', 7, '2026-07-20', 'owner-old',
            '2026-07-18 01:02:03', '2026-07-18 04:05:06',
            'SIM-OLD', 'RUN-OLD', '{"legacy":true}',
        ]
    );
    await db.run(
        `INSERT INTO clover_raid_participants
         (raid_id, player_id, status, tags_json, joined_at, updated_at)
         VALUES (?, ?, 'withdrawn', ?, ?, ?)`,
        [
            inserted.lastID, 'player-old', '["tag-antiga"]',
            '2026-07-18 05:00:00', '2026-07-18 06:00:00',
        ]
    );

    const beforeRaid = await db.get(
        `SELECT id, code, name, status, slots, event_date, created_by, created_at, updated_at,
                simulation_code, applied_run_code, metadata_json
         FROM clover_raids WHERE id = ?`,
        [inserted.lastID]
    );
    const beforeParticipant = await db.get(
        `SELECT id, raid_id, player_id, status, tags_json, joined_at, updated_at
         FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?`,
        [inserted.lastID, 'player-old']
    );

    const result = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });

    assert.equal(result.baseTablesCreatedOrPresent, 19);
    assert.equal(result.transientMigrationCount, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length);
    assert.equal(result.transientMigrations.some((item) => item.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);

    for (const target of RAID_V1_BRIDGE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    for (const target of RAID_V2_COLUMNS_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }

    const afterRaid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]);
    assert.deepEqual({
        id: afterRaid.id,
        code: afterRaid.code,
        name: afterRaid.name,
        status: afterRaid.status,
        slots: afterRaid.slots,
        event_date: afterRaid.event_date,
        created_by: afterRaid.created_by,
        created_at: afterRaid.created_at,
        updated_at: afterRaid.updated_at,
        simulation_code: afterRaid.simulation_code,
        applied_run_code: afterRaid.applied_run_code,
        metadata_json: afterRaid.metadata_json,
    }, beforeRaid);
    assert.equal(afterRaid.raid_key, 'legacy-prebootstrap');
    assert.equal(afterRaid.category, 'missao');
    assert.equal(afterRaid.location, 'Capital de Clover');
    assert.equal(afterRaid.owner_player_id, 'owner-old');
    assert.equal(afterRaid.max_players, 7);
    assert.equal(afterRaid.salary_eligible, 1);

    const afterParticipant = await db.get(
        'SELECT * FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?',
        [inserted.lastID, 'player-old']
    );
    assert.deepEqual({
        id: afterParticipant.id,
        raid_id: afterParticipant.raid_id,
        player_id: afterParticipant.player_id,
        status: afterParticipant.status,
        tags_json: afterParticipant.tags_json,
        joined_at: afterParticipant.joined_at,
        updated_at: afterParticipant.updated_at,
    }, beforeParticipant);
    assert.equal(afterParticipant.joined_via, 'site');
    assert.equal(afterParticipant.removed_at, null);
    assert.equal(afterParticipant.snapshot_json, null);
    assert.equal(afterParticipant.metadata_json, null);
    assert.equal(afterParticipant.finalization_status, 'pending');
    assert.equal(afterParticipant.finalization_note, null);
    assert.equal(afterParticipant.finalized_by, null);
    assert.equal(afterParticipant.finalized_at, null);

    const index = await db.get(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_clover_raids_raid_key'"
    );
    assert.match(index?.sql || '', /UNIQUE INDEX/i);
    assert.match(index?.sql || '', /WHERE raid_key IS NOT NULL/i);

    assert.equal(afterRaid.category_key, 'evento_especial');
    assert.equal(afterRaid.category_label, 'Evento especial');
    assert.equal(afterRaid.scope_type, 'global');
    assert.equal(afterRaid.scope_player_id, null);
    assert.equal(afterRaid.scope_squad_key, null);
    assert.equal(afterRaid.month_key, '2026-07');
    assert.equal(afterRaid.counts_monthly, 0);
    assert.equal(afterRaid.monthly_limit, null);
    const monthlyIndex = await db.get(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_clover_raids_monthly_scope'"
    );
    assert.ok(monthlyIndex);
    for (const target of RAID_PARTICIPANT_FINALIZATION_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    const finalizationIndex = await db.all('PRAGMA index_info(idx_clover_raid_participant_finalization)');
    assert.deepEqual(
        finalizationIndex.sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((row) => row.name),
        ['raid_id', 'finalization_status', 'status', 'id']
    );
    const legacyRewardsState = await inspectRaidRewardsSchemaState(db);
    assert.equal(legacyRewardsState.kind, 'v2');
    assert.equal(legacyRewardsState.indexValid, true);
    const legacyMonthlyState = await inspectRaidMonthlyProgressSchemaState(db);
    assert.equal(legacyMonthlyState.kind, 'exact');
    assert.equal(legacyMonthlyState.indexValid, true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_reservations')).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_ledger')).n, 0);
    const legacySupportState = await inspectRaidSupportSchemaState(db);
    assert.equal(legacySupportState.kind, 'exact');
    assert.equal(legacySupportState.indexValid, true);
    for (const table of legacySupportState.tables) {
        assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n, 0, table.name);
    }
    const legacyIdempotencyState = await inspectRaidIdempotencyRequestsSchemaState(db);
    assert.equal(legacyIdempotencyState.kind, 'exact');
    assert.equal(legacyIdempotencyState.indexValid, true);
    for (const table of legacyIdempotencyState.tables) {
        assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n, 0, table.name);
    }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_rewards')).n, 0);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('pre-bootstrap 0020 falha fechado em status pré-V1 e reverte bases/DDL da tentativa', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

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
    await db.run(
        `INSERT INTO clover_raids (code, name, status, slots, created_by)
         VALUES ('legacy-blocked', 'Raid não reconciliada', 'rascunho', 5, 'legacy-owner')`
    );

    await assert.rejects(
        prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS }),
        (error) => error?.code === 'raid_v1_status_mapping_required'
            && error?.table === 'clover_raids'
            && error?.statuses?.includes('rascunho')
    );

    assert.equal(await tableExists(db, 'clover_raids'), true);
    assert.equal(await tableExists(db, 'clover_raid_participants'), true);
    assert.equal(await columnExists(db, 'clover_raids', 'raid_key'), false);
    assert.equal(await columnExists(db, 'clover_raid_participants', 'joined_via'), false);

    assert.equal(await tableExists(db, 'clover_squads'), false);
    assert.equal(await tableExists(db, 'jogadores'), false);
    assert.equal(await tableExists(db, 'clover_character_stats'), false);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);

    const raid = await db.get(
        'SELECT code, name, status, slots, created_by FROM clover_raids WHERE code = ?',
        ['legacy-blocked']
    );
    assert.deepEqual(raid, {
        code: 'legacy-blocked',
        name: 'Raid não reconciliada',
        status: 'rascunho',
        slots: 5,
        created_by: 'legacy-owner',
    });
});



test('pre-bootstrap 0023 converte Rewards V1 existente preservando row, delivery e sqlite_sequence sem adotar o banco', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    await db.exec(RAID_REWARDS_V1_TABLE_SQL);
    await db.exec(`
        CREATE INDEX idx_clover_raid_rewards_raid
        ON clover_raid_rewards (raid_id, status, id);
    `);
    await createExactRaidSupportFixture(db);
    await db.run(
        `INSERT INTO clover_raid_rewards
         (id, raid_id, target_type, reward_type, amount, label, status, created_by, metadata_json)
         VALUES (7, 4, 'general', 'ph', 1, 'Reward legado', 'applied', 'host', '{"legacy":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_reward_deliveries
         (id, raid_id, reward_id, player_id, status, result_json)
         VALUES (3, 4, 7, 'p1', 'completed', '{"ph":1}')`
    );
    await db.run(`UPDATE sqlite_sequence SET seq = 50 WHERE name = 'clover_raid_rewards'`);

    const beforeReward = await db.get('SELECT * FROM clover_raid_rewards WHERE id = 7');
    const beforeDelivery = await db.get('SELECT * FROM clover_raid_reward_deliveries WHERE id = 3');

    const result = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });

    assert.equal(result.baseTablesCreatedOrPresent, 19);
    assert.equal(result.transientMigrationCount, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length);
    assert.equal(result.transientMigrations.some((item) => item.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);

    const state = await inspectRaidRewardsSchemaState(db);
    assert.equal(state.kind, 'v2');
    assert.equal(state.indexValid, true);
    const monthlyAfterRewards = await inspectRaidMonthlyProgressSchemaState(db);
    assert.equal(monthlyAfterRewards.kind, 'exact');
    assert.equal(monthlyAfterRewards.indexValid, true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_reservations')).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_ledger')).n, 0);
    const supportAfterRewards = await inspectRaidSupportSchemaState(db);
    assert.equal(supportAfterRewards.kind, 'exact');
    assert.equal(supportAfterRewards.indexValid, true);

    const afterReward = await db.get('SELECT * FROM clover_raid_rewards WHERE id = 7');
    assert.deepEqual(afterReward, {
        id: beforeReward.id,
        raid_id: beforeReward.raid_id,
        target_type: beforeReward.target_type,
        target_player_id: beforeReward.target_player_id,
        reward_type: beforeReward.reward_type,
        amount: beforeReward.amount,
        template_key: beforeReward.template_key,
        resource_key: null,
        label: beforeReward.label,
        reason: beforeReward.reason,
        status: beforeReward.status,
        created_by: beforeReward.created_by,
        created_at: beforeReward.created_at,
        cancelled_at: beforeReward.cancelled_at,
        cancelled_by: beforeReward.cancelled_by,
        metadata_json: beforeReward.metadata_json,
    });
    assert.deepEqual(
        await db.get('SELECT * FROM clover_raid_reward_deliveries WHERE id = 3'),
        beforeDelivery
    );
    const sequence = await db.get(
        `SELECT seq FROM sqlite_sequence WHERE name = 'clover_raid_rewards'`
    );
    assert.equal(Number(sequence.seq), 50);
});

test('pre-bootstrap 0023 nao repara indice ausente de Rewards V1 preexistente e reverte bases da tentativa', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    await db.exec(RAID_REWARDS_V1_TABLE_SQL);
    await db.run(
        `INSERT INTO clover_raid_rewards
         (raid_id, target_type, reward_type, amount, label, status, created_by)
         VALUES (2, 'general', 'ph', 1, 'Sem indice', 'draft', 'host')`
    );

    await assert.rejects(
        prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS }),
        (error) => error?.code === 'raid_rewards_v2_index_mapping_required'
            && error?.index === 'idx_clover_raid_rewards_raid'
    );

    assert.equal((await inspectRaidRewardsSchemaState(db)).kind, 'v1');
    assert.equal(
        await db.get(
            `SELECT 1 AS found
             FROM sqlite_schema
             WHERE type='index' AND name='idx_clover_raid_rewards_raid'`
        ),
        undefined
    );
    assert.equal(await tableExists(db, 'clover_raids'), false);
    assert.equal(await tableExists(db, 'clover_raid_participants'), false);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.equal(
        (await db.get('SELECT COUNT(*) AS n FROM clover_raid_rewards')).n,
        1
    );
});

test('pre-bootstrap 0026 preserva requests idempotentes exatos sem adotar o banco', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) await db.exec(table.sql);
    for (const index of RAID_IDEMPOTENCY_REQUESTS_INDEXES) await db.exec(index.sql);
    await db.run(
        `INSERT INTO clover_raid_creation_requests
         (idempotency_key, fingerprint, actor_id, status, processing_token, result_json, completed_at)
         VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
        ['creation-exact', 'fp-create', 'actor-1', 'token-create', '{"raidId":7}', '2026-08-21 12:00:00']
    );
    await db.run(
        `INSERT INTO clover_raid_mutation_requests
         (idempotency_key, operation, fingerprint, actor_id, raid_id, subject_player_id, status, processing_token, result_json, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
        ['mutation-exact', 'claim', 'fp-mutation', 'actor-1', 7, 'player-1', 'token-mutation', '{"claimed":true}', '2026-08-21 12:01:00']
    );
    const beforeCreation = await db.get('SELECT * FROM clover_raid_creation_requests WHERE idempotency_key = ?', ['creation-exact']);
    const beforeMutation = await db.get('SELECT * FROM clover_raid_mutation_requests WHERE idempotency_key = ?', ['mutation-exact']);

    const result = await prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });

    assert.equal(result.transientMigrationCount, DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.length);
    assert.equal(result.transientMigrations.some((item) => item.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    assert.equal((await inspectRaidIdempotencyRequestsSchemaState(db)).exact, true);
    assert.deepEqual(await db.get('SELECT * FROM clover_raid_creation_requests WHERE idempotency_key = ?', ['creation-exact']), beforeCreation);
    assert.deepEqual(await db.get('SELECT * FROM clover_raid_mutation_requests WHERE idempotency_key = ?', ['mutation-exact']), beforeMutation);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('pre-bootstrap 0026 falha fechado para requests idempotentes parciais e reverte a tentativa', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    await db.exec(RAID_IDEMPOTENCY_REQUESTS_TABLES[0].sql);
    await assert.rejects(
        prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS }),
        (error) => error?.code === 'raid_idempotency_requests_schema_mapping_required'
            && error?.reason === 'partial_tables'
    );

    const state = await inspectRaidIdempotencyRequestsSchemaState(db);
    assert.equal(state.kind, 'partial');
    assert.equal(state.indexValid, false);
    assert.equal(await tableExists(db, 'clover_raid_creation_requests'), true);
    assert.equal(await tableExists(db, 'clover_raid_mutation_requests'), false);
    assert.equal(await tableExists(db, 'clover_raids'), false);
    assert.equal(await tableExists(db, 'clover_squads'), false);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('pre-bootstrap rollback remove inclusive tabelas-base criadas na mesma transação', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    const failing = {
        version: 29,
        key: '0029_test_prebootstrap_failure',
        description: 'fixture de rollback',
        async up(connection) {
            await connection.exec('CREATE TABLE prebootstrap_should_rollback (id INTEGER PRIMARY KEY)');
            throw new Error('forced rollback');
        },
    };

    await assert.rejects(
        prebootstrapCloverSchemaBeforeLegacy(db, {
            migrations: [...CURRENT_SCHEMA_MIGRATIONS, failing],
            migrationKeys: [...DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS, failing.key],
        }),
        /forced rollback/
    );

    assert.equal(await tableExists(db, 'clover_inventory_items'), false);
    assert.equal(await tableExists(db, 'clover_admin_service_entries'), false);
    assert.equal(await tableExists(db, 'jogadores'), false);
    assert.equal(await tableExists(db, 'clover_squads'), false);
    assert.equal(await tableExists(db, 'prebootstrap_should_rollback'), false);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('pre-bootstrap rejeita estado não adotado com user_version diferente de zero', async (t) => {
    const filename = tempDatabasePath();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });
    await db.exec('PRAGMA user_version = 3');

    await assert.rejects(
        prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS }),
        (error) => error?.code === 'canonical_prebootstrap_state_incompatible'
            && error?.userVersion === 3
    );
});

test('database.js aplica a fixture custom canônica completa antes do legacy', async (t) => {
    const filename = tempDatabasePath();
    let observedBeforeLegacy = false;

    const openAtFixture = (options = {}) => openCloverDatabase({ ...options, filename });
    const createLegacyDatabase = async () => {
        const connection = await openAtFixture();
        observedBeforeLegacy = await columnExists(connection, 'clover_inventory_items', 'template_key')
            && await columnExists(connection, 'clover_item_templates', 'requestable')
            && await columnExists(connection, 'player_onboarding', 'step_payload');
        assert.equal(await tableExists(connection, MIGRATION_TABLE), false);
        assert.equal(Number(await readPragmaScalar(connection, 'user_version')), 0);
        return connection;
    };

    const db = await database.criarBanco({
        createLegacyDatabase,
        openMigrationDatabase: openAtFixture,
        migrations: CURRENT_SCHEMA_MIGRATIONS,
        canonicalPrebootstrap: true,
    });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    assert.equal(observedBeforeLegacy, true);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 28);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), CURRENT_SCHEMA_MIGRATIONS.map((migration) => migration.version));
});


test('bootstrap real completo em diretório vazio formaliza 0001→0028 depois do pre-bootstrap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-real-empty-'));
    try {
        const databaseModule = path.join(__dirname, '..', 'database.js');
        const script = `
            const { criarBanco } = require(${JSON.stringify(databaseModule)});
            (async () => {
                const db = await criarBanco();
                try {
                    const uv = await db.get('PRAGMA user_version');
                    const ledger = await db.all('SELECT version FROM clover_schema_migrations ORDER BY version');
                    const tables = await db.get("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                    const quick = await db.get('PRAGMA quick_check');
                    const integrity = await db.get('PRAGMA integrity_check');
                    const fk = await db.all('PRAGMA foreign_key_check');
                    process.stdout.write(JSON.stringify({
                        userVersion: Number(Object.values(uv)[0]),
                        ledger: ledger.map((row) => Number(row.version)),
                        tables: Number(tables.n),
                        quick: quick.quick_check,
                        integrity: integrity.integrity_check,
                        fk: fk.length,
                    }));
                } finally { await db.close(); }
            })().catch((error) => { console.error(error); process.exit(1); });
        `;
        const output = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
        const result = JSON.parse(output);
        assert.equal(result.userVersion, CURRENT_SCHEMA_MIGRATIONS.at(-1).version);
        assert.deepEqual(result.ledger, CURRENT_SCHEMA_MIGRATIONS.map((migration) => migration.version));
        assert.equal(result.tables >= 69, true);
        assert.equal(result.quick, 'ok');
        assert.equal(result.integrity, 'ok');
        assert.equal(result.fk, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('upgrade real preserva dados de schema antigo sem ledger e formaliza 0028 pós-legacy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-real-upgrade-'));
    const filename = path.join(dir, 'banco.sqlite');
    try {
        const seed = await openCloverDatabase({ filename });
        await require('../helpers/clover/schemaBaseCatalog').ensureCanonicalMigratedBaseTables(seed);
        await seed.run(
            'INSERT INTO player_onboarding (player_id, current_step) VALUES (?, ?)',
            ['legacy-player', 'recepcao']
        );
        await seed.run(
            'INSERT INTO clover_inventory_items (player_id, item_name, quantity, kind, created_at) VALUES (?, ?, ?, ?, ?)',
            ['legacy-player', 'Item Antigo', 2, 'material', '2026-01-01 00:00:00']
        );
        await seed.close();

        const databaseModule = path.join(__dirname, '..', 'database.js');
        const script = `
            const { criarBanco } = require(${JSON.stringify(databaseModule)});
            (async () => {
                const db = await criarBanco();
                try {
                    const uv = await db.get('PRAGMA user_version');
                    const onb = await db.get("SELECT player_id, current_step, step_payload FROM player_onboarding WHERE player_id='legacy-player'");
                    const item = await db.get("SELECT player_id, item_name, quantity, kind, category, status, quality, reference_price, created_at FROM clover_inventory_items WHERE player_id='legacy-player'");
                    const ledger = await db.all('SELECT version FROM clover_schema_migrations ORDER BY version');
                    const quick = await db.get('PRAGMA quick_check');
                    const integrity = await db.get('PRAGMA integrity_check');
                    const fk = await db.all('PRAGMA foreign_key_check');
                    process.stdout.write(JSON.stringify({
                        userVersion: Number(Object.values(uv)[0]),
                        onboarding: onb,
                        item,
                        ledger: ledger.map((row) => Number(row.version)),
                        quick: quick.quick_check,
                        integrity: integrity.integrity_check,
                        fk: fk.length,
                    }));
                } finally { await db.close(); }
            })().catch((error) => { console.error(error); process.exit(1); });
        `;
        const output = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
        const result = JSON.parse(output);
        assert.equal(result.userVersion, CURRENT_SCHEMA_MIGRATIONS.at(-1).version);
        assert.deepEqual(result.ledger, CURRENT_SCHEMA_MIGRATIONS.map((migration) => migration.version));
        assert.deepEqual(result.onboarding, {
            player_id: 'legacy-player',
            current_step: 'recepcao',
            step_payload: '{}',
        });
        assert.equal(result.item.player_id, 'legacy-player');
        assert.equal(result.item.item_name, 'Item Antigo');
        assert.equal(result.item.quantity, 2);
        assert.equal(result.item.kind, 'material');
        assert.equal(result.item.created_at, '2026-01-01 00:00:00');
        assert.equal(result.quick, 'ok');
        assert.equal(result.integrity, 'ok');
        assert.equal(result.fk, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
