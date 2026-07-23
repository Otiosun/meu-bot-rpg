'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    INSERT_TRIGGER,
    UPDATE_TRIGGER,
    ensureAdminTraitProfileSyncTrigger,
} = require('../helpers/clover/adminTraitProfileSyncTrigger');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome_real TEXT,
            ficha_status TEXT,
            aptidao_comum TEXT,
            aptidao_comum_key TEXT,
            marca_comum TEXT,
            marca_comum_key TEXT,
            aptidao_rara TEXT,
            aptidao_rara_key TEXT,
            marca_rara TEXT,
            marca_rara_key TEXT,
            anomalia TEXT,
            anomalia_key TEXT
        )
    `);
    return db;
}

async function activeAssignments(db, playerId) {
    return db.all(
        `SELECT pt.slot_key, pt.value_text, pt.source, pt.assignment_key, tt.canonical_key
         FROM clover_player_traits pt
         JOIN clover_trait_templates tt ON tt.id = pt.trait_id
         WHERE pt.player_id = ? AND pt.active = 1
         ORDER BY pt.slot_key`,
        [playerId]
    );
}

test('confirmação de ficha sincroniza catálogo e vínculos sem duplicar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await ensureAdminTraitProfileSyncTrigger(db);
    await ensureAdminTraitProfileSyncTrigger(db);

    const triggers = await db.all(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name IN (?, ?)
         ORDER BY name`,
        [INSERT_TRIGGER, UPDATE_TRIGGER]
    );
    assert.deepEqual(triggers.map((row) => row.name).sort(), [INSERT_TRIGGER, UPDATE_TRIGGER].sort());

    await db.run(
        `INSERT INTO jogadores (
            id, personagem_nome, nome_real, ficha_status,
            aptidao_comum, aptidao_comum_key,
            marca_comum, marca_comum_key,
            aptidao_rara, aptidao_rara_key,
            marca_rara, marca_rara_key,
            anomalia, anomalia_key
        ) VALUES (?, ?, ?, 'aprovada', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            '111@lid', 'Emil', 'Jogador',
            'Corpo de Rotina', 'corpo_de_rotina',
            'Mãos que Tremem', 'maos_que_tremem',
            '-', null,
            null, null,
            'Sem Mana', 'sem_mana',
        ]
    );

    let assignments = await activeAssignments(db, '111@lid');
    assert.deepEqual(assignments.map((row) => row.slot_key), ['anomalia', 'aptidao_comum', 'marca_comum']);
    assert(assignments.every((row) => row.source === 'profile_confirmation'));
    assert.equal(await db.get('SELECT COUNT(*) AS total FROM clover_trait_templates').then((row) => row.total), 3);

    await db.run(
        `UPDATE jogadores
         SET nome_real = ?,
             aptidao_comum = ?, aptidao_comum_key = ?,
             marca_comum = ?, marca_comum_key = ?,
             anomalia = ?, anomalia_key = ?
         WHERE id = ?`,
        [
            'Jogador Atualizado',
            'Corpo de Combate', 'corpo_de_combate',
            '-', null,
            'Sem Mana', 'sem_mana',
            '111@lid',
        ]
    );

    assignments = await activeAssignments(db, '111@lid');
    assert.deepEqual(
        assignments.map((row) => [row.slot_key, row.value_text]),
        [
            ['anomalia', 'Sem Mana'],
            ['aptidao_comum', 'Corpo de Combate'],
        ]
    );
    assert.equal(await db.get('SELECT COUNT(*) AS total FROM clover_trait_templates').then((row) => row.total), 4);

    await db.run(
        `UPDATE jogadores
         SET nome_real = nome_real
         WHERE id = ?`,
        ['111@lid']
    );

    const afterRepeat = await activeAssignments(db, '111@lid');
    assert.deepEqual(afterRepeat, assignments);
    assert.equal(
        await db.get('SELECT COUNT(*) AS total FROM clover_player_traits WHERE active = 1').then((row) => row.total),
        2
    );
});

test('alteração administrativa isolada não dispara o gatilho de confirmação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await ensureAdminTraitProfileSyncTrigger(db);
    await db.run(
        `INSERT INTO jogadores (
            id, personagem_nome, nome_real, ficha_status,
            aptidao_comum, aptidao_comum_key,
            marca_comum, marca_comum_key,
            aptidao_rara, aptidao_rara_key,
            marca_rara, marca_rara_key,
            anomalia, anomalia_key
        ) VALUES (?, ?, ?, 'aprovada', ?, ?, '-', NULL, '-', NULL, '-', NULL, '-', NULL)`,
        ['222@lid', 'Aster', 'Jogador', 'Corpo de Rotina', 'corpo_de_rotina']
    );

    const before = await activeAssignments(db, '222@lid');
    assert.equal(before.length, 1);

    await db.run(
        `UPDATE jogadores
         SET aptidao_comum = ?, aptidao_comum_key = ?
         WHERE id = ?`,
        ['Valor alterado fora da confirmação', 'valor_alterado', '222@lid']
    );

    const after = await activeAssignments(db, '222@lid');
    assert.deepEqual(after, before);
});
