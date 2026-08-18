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
    migrationChecksum,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    SITE_PROFILE_IMAGE_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0012 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 12));
const MIGRATIONS_THROUGH_0013 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 13));

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0013-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { allSiteProfileColumns = false } = {}) {
    await db.exec(`
        CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY, ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0);
        CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY, roll_basis_points INTEGER DEFAULT NULL);
        CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY, expires_at TEXT DEFAULT NULL);
        CREATE TABLE clover_consumable_uses (id INTEGER PRIMARY KEY, effect_category TEXT DEFAULT NULL);
        CREATE TABLE player_onboarding (player_id TEXT PRIMARY KEY, step_payload TEXT DEFAULT '{}');
        CREATE TABLE pending_magic_confirmations (player_id TEXT PRIMARY KEY, magic_label TEXT NOT NULL, roll_number INTEGER DEFAULT NULL);
        CREATE TABLE group_settings (group_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, reception_enabled INTEGER DEFAULT 0, reception_type TEXT DEFAULT NULL);
        CREATE TABLE clover_market_listings (id INTEGER PRIMARY KEY, idempotency_key TEXT DEFAULT NULL);
        CREATE TABLE clover_weekly_npc_requests (id INTEGER PRIMARY KEY, required_quality TEXT NOT NULL DEFAULT 'qualquer', required_condition TEXT NOT NULL DEFAULT 'qualquer');
        CREATE TABLE clover_quick_evaluations (id INTEGER PRIMARY KEY, quoted_message_key TEXT DEFAULT NULL, scene_sent_at TEXT DEFAULT NULL, scene_source TEXT DEFAULT NULL, evaluated_at TEXT DEFAULT NULL, salary_eligible INTEGER DEFAULT NULL, salary_service_type TEXT DEFAULT NULL);
        CREATE TABLE player_rolls (player_id TEXT NOT NULL, roll_number INTEGER NOT NULL, kingdom TEXT DEFAULT '-', grimoire_rank TEXT DEFAULT '-', grimoire_symbol TEXT DEFAULT '-', magic_scope TEXT DEFAULT '-', roll_version TEXT DEFAULT 'legacy', kingdom_key TEXT DEFAULT NULL, social_class_key TEXT DEFAULT NULL, race_key TEXT DEFAULT NULL, grimoire_key TEXT DEFAULT NULL, magic_rarity_key TEXT DEFAULT NULL, roll_payload TEXT DEFAULT '{}', PRIMARY KEY (player_id, roll_number));
        CREATE TABLE clover_item_templates (template_key TEXT PRIMARY KEY, is_custom INTEGER NOT NULL DEFAULT 0, requestable INTEGER NOT NULL DEFAULT 0, marketable INTEGER NOT NULL DEFAULT 1, duplicable INTEGER NOT NULL DEFAULT 1, created_by TEXT DEFAULT 'system', updated_by TEXT DEFAULT NULL, archived_at TEXT DEFAULT NULL);
        CREATE TABLE clover_inventory_items (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL, item_name TEXT NOT NULL, template_key TEXT DEFAULT NULL, catalog_version INTEGER DEFAULT 1, category TEXT DEFAULT 'material', origin TEXT DEFAULT 'Clover', status TEXT DEFAULT 'disponivel', quality TEXT DEFAULT 'comum', base_price INTEGER DEFAULT 0, reference_price INTEGER DEFAULT 0, durability_current INTEGER DEFAULT NULL, durability_max INTEGER DEFAULT NULL, bound INTEGER DEFAULT 0, transferable INTEGER DEFAULT 1, equipped_slot TEXT DEFAULT NULL, expires_at TEXT DEFAULT NULL, updated_at TEXT DEFAULT NULL, properties_json TEXT DEFAULT NULL, effects_json TEXT DEFAULT NULL);
        CREATE TABLE clover_admin_service_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            evaluator_id TEXT NOT NULL,
            evaluation_id INTEGER DEFAULT NULL,
            target_player_id TEXT DEFAULT NULL,
            modality_key TEXT NOT NULL,
            modality_label TEXT NOT NULL,
            weight INTEGER NOT NULL DEFAULT 0,
            points INTEGER NOT NULL DEFAULT 0,
            paid_points INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            source TEXT NOT NULL DEFAULT 'quick_evaluation',
            service_week_key TEXT DEFAULT NULL,
            scene_week_key TEXT DEFAULT NULL,
            scene_sent_at TEXT DEFAULT NULL,
            evaluated_at TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            voided_at TEXT DEFAULT NULL,
            voided_by TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
    `);

    const siteColumns = allSiteProfileColumns
        ? ', site_profile_image_data TEXT DEFAULT NULL, site_profile_image_updated_at TEXT DEFAULT NULL'
        : '';
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT DEFAULT '-',
            nome_real TEXT DEFAULT '-',
            idade_real INTEGER DEFAULT NULL,
            gosta_de_fazer TEXT DEFAULT '-',
            disponibilidade_detalhada TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-',
            numero_roll_escolhido INTEGER DEFAULT NULL,
            ficha_status TEXT DEFAULT 'incompleta',
            ultima_recepcao_em TEXT DEFAULT NULL,
            familia_key TEXT DEFAULT NULL,
            magia_key TEXT DEFAULT NULL,
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_normalizada TEXT DEFAULT NULL,
            personagem_aparencia_status TEXT DEFAULT 'pending',
            personagem_aparencia_motivo TEXT DEFAULT NULL,
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            personagem_aparencia_image_message_id TEXT DEFAULT NULL,
            personagem_aparencia_approved_by TEXT DEFAULT NULL,
            personagem_aparencia_approved_at TEXT DEFAULT NULL,
            personagem_aparencia_updated_at TEXT DEFAULT NULL
            ${siteColumns}
        )
    `);
}

test('0013 versiona exatamente duas colunas de avatar do site e segunda execução é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    const first = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0013 });
    assert.equal(first.latestVersion, 13);
    assert.equal(first.appliedCount, 13);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 13);
    for (const target of SITE_PROFILE_IMAGE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, target.column);
    }
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13]);

    const second = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0013 });
    assert.equal(second.appliedCount, 0);
});

test('0013 é schema-no-op e preserva avatar existente quando as duas colunas já existem', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { allSiteProfileColumns: true });
    await db.run(
        `INSERT INTO jogadores (id, nome, site_profile_image_data, site_profile_image_updated_at)
         VALUES (?, ?, ?, ?)`,
        ['fixture-player', 'Fixture', 'avatar-fixture', '2026-08-18 01:00:00']
    );

    const result = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0013 });
    assert.equal(result.appliedCount, 13);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 13);
    const player = await db.get(
        `SELECT site_profile_image_data, site_profile_image_updated_at
         FROM jogadores WHERE id = ?`,
        ['fixture-player']
    );
    assert.deepEqual(player, {
        site_profile_image_data: 'avatar-fixture',
        site_profile_image_updated_at: '2026-08-18 01:00:00',
    });
});

test('0013 falha fechado se jogadores desaparecer após a adoção até 0012 e preserva ledger em v12', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0012 });
    await db.exec('DROP TABLE jogadores');

    await assert.rejects(
        runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0013 }),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'jogadores'
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 12);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12]);
});

test('checksum da 0013 cobre os dois targets e a migration não altera dados', () => {
    const migration = MIGRATIONS_THROUGH_0013[12];
    const checksum = migrationChecksum(migration);
    assert.equal(checksum, 'f74c972fefbdee10f3a1b10826d5cfc02058996771b55e0f84251e59dfaa9d50');
    assert.doesNotMatch(String(migration.up), /UPDATE\s+/i);
    const altered = { ...migration, checksumMaterial: migration.checksumMaterial.slice(0, 1) };
    assert.notEqual(migrationChecksum(altered), checksum);
});
