'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
} = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const { createRaid } = require('../helpers/clover/raidService');
const {
    getRaidCreationOptions,
    previewRaidMonthlyUsage,
} = require('../helpers/clover/raidV2OptionsService');

const NARRATOR = '5511111111111@s.whatsapp.net';
const PLAYER = '5522222222222@s.whatsapp.net';

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            jogo_status TEXT DEFAULT 'liberado'
        );
        INSERT INTO jogadores
            (id, personagem_nome, magia, esquadrao, jogo_status)
        VALUES
            ('${NARRATOR}', 'Narrador', 'Registro', '-', 'liberado'),
            ('${PLAYER}', 'Player Um', 'Fogo', 'Coringas Magenta', 'liberado'),
            ('5533333333333@s.whatsapp.net', 'Arquivado', 'Água', '-', 'arquivado');
    `);
    await ensureCloverRaidSchema(db);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await db.run(
        `INSERT INTO clover_squads (squad_key, name)
         VALUES ('coringas_magenta', 'Coringas Magenta')`
    );
    await assignAccessRole(db, {
        subjectId: NARRATOR,
        role: 'narrator',
        assignedBy: NARRATOR,
        reason: 'teste de opções de raid',
    });
    return db;
}

test('opções de criação trazem quatro categorias oficiais', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const options = await getRaidCreationOptions(db, NARRATOR);
    assert.equal(options.categories.length, 4);
    assert.deepEqual(options.categories.map((category) => category.key), [
        'saga_pessoal',
        'missao_esquadrao',
        'treino_esquadrao',
        'evento_especial',
    ]);
    assert.deepEqual(options.players.map((player) => player.name), ['Narrador', 'Player Um']);
    assert.equal(options.players.find((player) => player.id === PLAYER).magic, 'Fogo');
    assert.deepEqual(options.squads.map((squad) => squad.name), ['Coringas Magenta']);
});

test('prévia mensal usa reserva real sem fingir conclusão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const before = await previewRaidMonthlyUsage(db, NARRATOR, {
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });
    assert.equal(before.usage.completed, 0);
    assert.equal(before.usage.reserved, 0);
    assert.equal(before.usage.used, 0);
    assert.equal(before.usage.remaining, 1);

    await createRaid(db, NARRATOR, {
        name: 'Saga em andamento',
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });

    const after = await previewRaidMonthlyUsage(db, NARRATOR, {
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });
    assert.equal(after.usage.completed, 0);
    assert.equal(after.usage.reserved, 1);
    assert.equal(after.usage.used, 1);
    assert.equal(after.usage.remaining, 0);
    assert.equal(after.usage.exhausted, true);
});