'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { runAdminTraitLegacyMigration } = require('../helpers/clover/adminTraitLegacyMigrationService');
const { getAdminPlayerTraitOverview } = require('../helpers/clover/adminPlayerTraitOverviewService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            aptidao_comum TEXT,
            aptidao_comum_key TEXT,
            marca_comum TEXT,
            marca_comum_key TEXT,
            aptidao_rara TEXT,
            aptidao_rara_key TEXT,
            marca_rara TEXT,
            marca_rara_key TEXT,
            anomalia TEXT,
            anomalia_key TEXT,
            historias_extras TEXT,
            gancho_narrativo TEXT
        );
        CREATE TABLE clover_player_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            content_type TEXT NOT NULL,
            content_key TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            raw_source_text TEXT,
            mechanical_status TEXT NOT NULL DEFAULT 'not_applicable',
            review_status TEXT NOT NULL DEFAULT 'draft',
            linked_content_id INTEGER,
            version INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 1,
            source TEXT,
            created_by TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT,
            UNIQUE(player_id, content_type, content_key, version)
        );
        CREATE TABLE clover_character_bonuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT,
            value TEXT,
            description TEXT,
            status TEXT,
            source TEXT,
            reason TEXT,
            expires_at TEXT,
            created_by TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT
        );
        CREATE TABLE clover_trait_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            category TEXT NOT NULL,
            status TEXT NOT NULL,
            result TEXT NOT NULL,
            chosen_key TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(player_id, attempt_number)
        );
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, aptidao_comum, aptidao_comum_key, marca_comum, marca_comum_key,
          aptidao_rara, marca_rara, anomalia, historias_extras)
         VALUES (?, ?, ?, ?, ?, ?, '-', '-', '-', ?)`,
        [
            'emil@lid', 'Emil', 'Corpo de Rotina', 'corpo_de_rotina', 'Mãos que Tremem', 'maos_que_tremem',
            JSON.stringify([
                { type: 'traço', title: 'Corpo de Combate', description: '' },
                { type: 'gn', title: 'Voz no Vento', description: 'Um cochicho recorrente.' },
            ]),
        ]
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, aptidao_comum, aptidao_comum_key, marca_comum, aptidao_rara, marca_rara, anomalia, historias_extras)
         VALUES ('other@lid', 'Outro', 'Olhar Anal?tico', 'olhar_analitico', '-', '-', '-', '-', '[]')`
    );
    await db.run(
        `INSERT INTO clover_player_content
         (player_id, content_type, content_key, title, body, raw_source_text, mechanical_status, review_status, source)
         VALUES ('other@lid', 'custom_trait', 'teste', 'MÃ¡scara', 'DescriÃ§Ã£o', 'DescriÃ§Ã£o', 'pending_balance', 'approved', 'test')`
    );
    await db.run(`INSERT INTO clover_character_bonuses (player_id, name, status) VALUES ('emil@lid', 'Agilidade +10%', 'ativo')`);
    await db.run(
        `INSERT INTO clover_trait_attempts (player_id, attempt_number, category, status, result)
         VALUES ('emil@lid', 1, 'anomaly', 'completed', 'failure')`
    );
    return db;
}

test('migra legado de forma idempotente e expõe o perfil completo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await runAdminTraitLegacyMigration(db, { sourceSha256: 'fixture' });
    assert.equal(first.integrityCheck, 'ok');
    assert.equal(first.templatesCreated, 4);
    assert.equal(first.assignmentsCreated, 4);
    assert.equal(first.hooksCreated, 1);
    assert.equal(first.contentRowsRepaired, 1);
    assert.equal(first.assignmentConflicts.length, 0);

    const second = await runAdminTraitLegacyMigration(db, { sourceSha256: 'fixture' });
    assert.equal(second.templatesCreated, 0);
    assert.equal(second.assignmentsCreated, 0);
    assert.equal(second.assignmentsSkippedExisting, 4);
    assert.equal(second.hooksSkippedExisting, 1);
    assert.equal(second.contentRowsRepaired, 0);

    const overview = await getAdminPlayerTraitOverview(db, 'emil@lid');
    assert.equal(overview.slots.find((item) => item.slotKey === 'aptidao_comum').value, 'Corpo de Rotina');
    assert.equal(overview.slots.find((item) => item.slotKey === 'aptidao_rara').source, 'empty');
    assert.equal(overview.extraTraits.length, 1);
    assert.equal(overview.extraTraits[0].value, 'Corpo de Combate');
    assert.equal(overview.hooks.length, 1);
    assert.equal(overview.bonuses.length, 1);
    assert.equal(overview.attempts.length, 1);

    const repaired = await db.get("SELECT title, body FROM clover_player_content WHERE player_id = 'other@lid'");
    assert.equal(repaired.title, 'Máscara');
    assert.equal(repaired.body, 'Descrição');

    const canonical = await db.get("SELECT name FROM clover_trait_templates WHERE canonical_key = 'olhar_analitico'");
    assert.equal(canonical.name, 'Olhar Analítico');
});
