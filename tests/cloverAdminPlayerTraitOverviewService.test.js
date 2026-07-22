'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { getAdminPlayerTraitOverview } = require('../helpers/clover/adminPlayerTraitOverviewService');
const { createTraitTemplate, ensureAdminTraitSchema } = require('../helpers/clover/adminTraitService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            aptidao_comum TEXT,
            marca_comum TEXT,
            aptidao_rara TEXT,
            marca_rara TEXT,
            anomalia TEXT
        )
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, aptidao_comum, marca_comum, aptidao_rara, marca_rara, anomalia)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['111@lid', 'Killian', 'Corpo de Rotina', 'Marca Legada', null, null, null]
    );
    return db;
}

test('lista os cinco espaços e distingue catálogo, legado e vazio', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await ensureAdminTraitSchema(db);
    await createTraitTemplate(db, {
        id: 'TR-ABCDEF12',
        name: 'Corpo de Rotina',
        slotKey: 'aptidao_comum',
        description: 'Modelo estruturado.',
        metadata: { imageUrl: 'data:image/jpeg;base64,AA==' },
    });
    await db.run(
        `INSERT INTO clover_player_traits
         (player_id, trait_id, slot_key, value_text, active, assigned_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
        ['111@lid', 'TR-ABCDEF12', 'aptidao_comum', 'Corpo de Rotina', new Date().toISOString()]
    );

    const overview = await getAdminPlayerTraitOverview(db, '111@lid');

    assert.equal(overview.available, true);
    assert.equal(overview.slots.length, 5);

    const common = overview.slots.find((slot) => slot.slotKey === 'aptidao_comum');
    assert.equal(common.source, 'catalog');
    assert.equal(common.trait.id, 'TR-ABCDEF12');
    assert.equal(common.trait.metadata.imageUrl, 'data:image/jpeg;base64,AA==');

    const legacy = overview.slots.find((slot) => slot.slotKey === 'marca_comum');
    assert.equal(legacy.source, 'legacy');
    assert.equal(legacy.value, 'Marca Legada');
    assert.equal(legacy.trait, null);

    const empty = overview.slots.find((slot) => slot.slotKey === 'anomalia');
    assert.equal(empty.source, 'empty');
    assert.equal(empty.value, null);
});
