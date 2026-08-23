'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    readPlayerRaidChecklist,
} = require('../helpers/clover/raidMonthlyProgressService');
const { RAID_V2_COLUMNS_MIGRATION } = require('../helpers/clover/schemaMigrationCatalog');
const { prepareCanonicalRaidSchema } = require('./helpers/canonicalRaidSchemaFixture');

async function baseDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado'
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            squad_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
        );
        INSERT INTO jogadores (id, personagem_nome, esquadrao)
        VALUES ('player-one', 'Player Um', 'Coringas Magenta');
    `);
    await prepareCanonicalRaidSchema(db);
    await db.run(
        `INSERT INTO clover_squads (squad_key, name)
         VALUES ('coringas_magenta', 'Coringas Magenta')`
    );
    await db.run(
        `INSERT INTO clover_squad_memberships (player_id, squad_key, status)
         VALUES ('player-one', 'coringas_magenta', 'active')`
    );
    await db.run(
        `INSERT INTO clover_squads (squad_key, name)
         VALUES ('asas_verdes', 'Asas Verdes')`
    );
    return db;
}

test('implantação cria ledger vazio e não transforma Raid antiga em conclusão', async (t) => {
    const db = await baseDb();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, description, location, status,
          owner_player_id, max_players, salary_eligible, created_at, updated_at)
         VALUES ('RAID-LEGACY-1', 'Investigação antiga', 'missao_desenvolvimento',
                 'Registro anterior à checklist', 'Capital de Clover', 'completed',
                 'player-one', 4, 1, '2026-06-10 12:00:00', '2026-06-10 15:00:00')`
    );

    await RAID_V2_COLUMNS_MIGRATION.up(db);

    const migrated = await db.get(
        `SELECT category_key, category_label, scope_type, counts_monthly, monthly_limit
         FROM clover_raids WHERE raid_key = 'RAID-LEGACY-1'`
    );
    assert.equal(migrated.category_key, 'evento_especial');
    assert.equal(migrated.category_label, 'Evento especial');
    assert.equal(migrated.scope_type, 'global');
    assert.equal(Number(migrated.counts_monthly), 0);
    assert.equal(migrated.monthly_limit, null);

    const ledger = await db.get('SELECT COUNT(*) AS total FROM clover_raid_monthly_ledger');
    const reservations = await db.get('SELECT COUNT(*) AS total FROM clover_raid_monthly_reservations');
    assert.equal(Number(ledger.total), 0);
    assert.equal(Number(reservations.total), 0);
});

test('registro V2 individual antigo é canonizado sem receber crédito retroativo', async (t) => {
    const db = await baseDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, category_key, category_label, description,
          location, status, owner_player_id, max_players, salary_eligible,
          scope_type, scope_player_id, month_key, counts_monthly, monthly_limit,
          created_at, updated_at)
         VALUES ('RAID-V2-OLD', 'Desenvolvimento antigo', 'missao_desenvolvimento',
                 'missao_desenvolvimento', 'Missão de desenvolvimento', 'Antiga',
                 'Capital de Clover', 'completed', 'player-one', 4, 1,
                 'player', 'player-one', '2026-06', 1, 1,
                 '2026-06-10 12:00:00', '2026-06-10 15:00:00')`
    );

    await RAID_V2_COLUMNS_MIGRATION.up(db);
    const migrated = await db.get(
        `SELECT category, category_key, category_label, scope_type, scope_player_id
         FROM clover_raids WHERE raid_key = 'RAID-V2-OLD'`
    );
    assert.equal(migrated.category, 'saga_pessoal');
    assert.equal(migrated.category_key, 'saga_pessoal');
    assert.equal(migrated.category_label, 'Saga individual / Missao de desenvolvimento');
    assert.equal(migrated.scope_type, 'player');
    assert.equal(migrated.scope_player_id, 'player-one');

    const ledger = await db.get('SELECT COUNT(*) AS total FROM clover_raid_monthly_ledger');
    assert.equal(Number(ledger.total), 0);
});

test('troca de esquadrão altera a leitura atual e preserva o ledger anterior', async (t) => {
    const db = await baseDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (entry_key, raid_id, category_key, month_key, scope_type, scope_key,
          amount, kind, reason, created_by)
         VALUES ('mission-magenta', 1, 'missao_esquadrao', '2026-07',
                 'squad', 'coringas_magenta', 1, 'completion',
                 'Missão concluída', 'admin')`
    );

    const before = await readPlayerRaidChecklist(db, 'player-one', { monthKey: '2026-07' });
    assert.equal(before.squadKey, 'coringas_magenta');
    assert.equal(before.squadMission.completed, 1);

    await db.run(
        `UPDATE clover_squad_memberships SET status = 'transferred'
         WHERE player_id = 'player-one' AND status = 'active'`
    );
    await db.run(
        `INSERT INTO clover_squad_memberships (player_id, squad_key, status)
         VALUES ('player-one', 'asas_verdes', 'active')`
    );
    const after = await readPlayerRaidChecklist(db, 'player-one', { monthKey: '2026-07' });
    assert.equal(after.squadKey, 'asas_verdes');
    assert.equal(after.squadMission.completed, 0);

    const previousHistory = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM clover_raid_monthly_ledger
         WHERE scope_type = 'squad' AND scope_key = 'coringas_magenta'`
    );
    assert.equal(Number(previousHistory.total), 1);
});
