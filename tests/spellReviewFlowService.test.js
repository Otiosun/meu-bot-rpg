'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { prepareCanonicalSchema } = require('./helpers/canonicalRaidSchemaFixture');

const {
    concludeSpellReviewEntry,
    deferSpellReviewEntry,
    ensureSpellReviewFlowSchema,
    fillSpellReviewSlots,
    getSpellReviewFlowState,
    holdSpellReviewEntry,
    resumeSpellReviewEntry,
    setSpellReviewAutoFlowEnabled,
    setSpellReviewCapacity,
} = require('../helpers/clover/spellReviewFlowService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            jogo_status TEXT,
            dinheiro INTEGER DEFAULT 0
        )
    `);
    await prepareCanonicalSchema(db);
    await ensureSpellReviewFlowSchema(db);
    return db;
}

async function addPlayer(db, index) {
    const id = `p${index}@lid`;
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status)
         VALUES (?, ?, ?, ?, 'aprovada', 'liberado')`,
        [id, `Player ${index}`, `Player ${index}`, `Personagem ${index}`]
    );
    await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at)
         VALUES (?, 'waiting', ?)`,
        [id, `2026-07-${String(index).padStart(2, '0')} 10:00:00`]
    );
    return id;
}

async function addApprovedSpell(db, playerId, name) {
    const normalizedName = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    await db.run(
        `INSERT INTO clover_spellbook_spells (
            player_id, name, normalized_name, version, type, cost, reach,
            duration, effect, limits, adm_notes, status, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'Criação', '-', '-', '-', 'Efeito', '-', '-',
                   'approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [playerId, name, normalizedName]
    );
}

test('capacidade simultânea chama cinco, mantém pendente no grupo e avança', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const players = [];
    for (let index = 1; index <= 8; index += 1) {
        players.push(await addPlayer(db, index));
    }

    assert.equal((await setSpellReviewCapacity(db, 5)).ok, true);
    const firstFill = await fillSpellReviewSlots(db, 'owner@lid');
    assert.equal(firstFill.called.length, 5);

    let state = await getSpellReviewFlowState(db);
    assert.equal(state.capacity, 5);
    assert.equal(state.active, 5);
    assert.equal(state.pending, 0);
    assert.equal(state.waiting, 3);

    const held = await holdSpellReviewEntry(db, players[1], 'owner@lid', 'ajustar limites');
    assert.equal(held.ok, true);

    state = await getSpellReviewFlowState(db);
    assert.equal(state.active, 4);
    assert.equal(state.pending, 1);
    assert.equal(state.waiting, 3);

    const secondFill = await fillSpellReviewSlots(db, 'owner@lid');
    assert.equal(secondFill.called.length, 1);
    assert.equal(secondFill.called[0].player_id, players[5]);

    state = await getSpellReviewFlowState(db);
    assert.equal(state.active, 5);
    assert.equal(state.pending, 1);
    assert.equal(state.waiting, 2);

    const blockedResume = await resumeSpellReviewEntry(db, players[1], 'owner@lid');
    assert.equal(blockedResume.ok, false);
    assert.equal(blockedResume.code, 'capacity_full');

    const concluded = await concludeSpellReviewEntry(db, players[0], 'owner@lid');
    assert.equal(concluded.ok, true);

    const resumed = await resumeSpellReviewEntry(db, players[1], 'owner@lid');
    assert.equal(resumed.ok, true);

    state = await getSpellReviewFlowState(db);
    assert.equal(state.active, 5);
    assert.equal(state.pending, 0);
    assert.equal(state.waiting, 2);
});

test('adiar manda ao fim e permite chamar outro sem recapturar o mesmo player', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const p1 = await addPlayer(db, 1);
    const p2 = await addPlayer(db, 2);
    const p3 = await addPlayer(db, 3);

    await setSpellReviewCapacity(db, 2);
    await fillSpellReviewSlots(db, 'owner@lid');

    const deferred = await deferSpellReviewEntry(db, p1, 'owner@lid', 'revisar ficha');
    assert.equal(deferred.ok, true);
    assert.equal(deferred.previousStatus, 'called');

    const fill = await fillSpellReviewSlots(db, 'owner@lid', {
        excludePlayerIds: [p1],
    });
    assert.equal(fill.called.length, 1);
    assert.equal(fill.called[0].player_id, p3);

    const rows = await db.all(
        `SELECT player_id, status
         FROM clover_spell_review_queue
         ORDER BY requested_at, id`
    );
    assert.equal(rows.find((row) => row.player_id === p1).status, 'waiting');
    assert.equal(rows.find((row) => row.player_id === p2).status, 'called');
    assert.equal(rows.find((row) => row.player_id === p3).status, 'called');
});

test('fluxo pode ser pausado sem alterar chamados ou pendentes', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await addPlayer(db, 1);
    await addPlayer(db, 2);
    await setSpellReviewCapacity(db, 5);
    await fillSpellReviewSlots(db, 'owner@lid');

    await setSpellReviewAutoFlowEnabled(db, false);
    const state = await getSpellReviewFlowState(db);

    assert.equal(state.autoFlow, false);
    assert.equal(state.active, 2);
    assert.equal(state.waiting, 0);
});

test('fluxo automático preserva bloqueado por slot e chama os próximos elegíveis', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const blockedPlayer = await addPlayer(db, 1);
    const eligiblePlayerA = await addPlayer(db, 2);
    const eligiblePlayerB = await addPlayer(db, 3);
    await addApprovedSpell(db, blockedPlayer, 'Feitiço já aprovado');
    await setSpellReviewCapacity(db, 2);

    const fill = await fillSpellReviewSlots(db, 'system:auto-flow');

    assert.equal(fill.called.length, 2);
    assert.deepEqual(
        fill.called.map((entry) => entry.player_id),
        [eligiblePlayerA, eligiblePlayerB]
    );
    assert.equal(fill.blocked.length, 1);
    assert.equal(fill.blocked[0].player_id, blockedPlayer);
    assert.equal(fill.blocked[0].blockCode, 'no_available_spell_slot');
    assert.equal(fill.blocked[0].statusPreserved, true);

    const rows = await db.all(
        `SELECT player_id, status
         FROM clover_spell_review_queue
         ORDER BY requested_at, id`
    );
    assert.equal(rows.find((row) => row.player_id === blockedPlayer).status, 'waiting');
    assert.equal(rows.find((row) => row.player_id === eligiblePlayerA).status, 'called');
    assert.equal(rows.find((row) => row.player_id === eligiblePlayerB).status, 'called');
});
