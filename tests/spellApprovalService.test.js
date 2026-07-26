'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverInventorySchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const { approveCalledSpell } = require('../helpers/clover/spellApprovalService');
const { addCatalogItem } = require('../helpers/clover/inventoryService');
const { useConsumable } = require('../helpers/clover/economyService');
const {
    ensureSpellReviewFlowSchema,
} = require('../helpers/clover/spellReviewFlowService');
const {
    listApprovedSpells,
    normalizeSpellName,
} = require('../helpers/clover/spellbookService');
const { getSpellCapacity } = require('../helpers/clover/spellCapacityService');

const PLAYER = 'approval-player@lid';
const ADMIN = 'approval-admin@lid';

function sheet(name) {
    return {
        name,
        normalizedName: normalizeSpellName(name),
        version: null,
        type: 'Criação',
        cost: '100 mana',
        reach: 'curto',
        duration: '1 turno',
        effect: 'Efeito de teste.',
        limits: 'Uma vez por cena.',
        admNotes: 'Teste automatizado.',
    };
}

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, ficha_status, jogo_status)
         VALUES (?, 'Personagem de Aprovação', 'aprovada', 'liberado')`,
        [PLAYER]
    );
    await ensureCloverInventorySchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureSpellReviewFlowSchema(db);
    return db;
}

async function callPlayer(db) {
    await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at, review_state)
         VALUES (?, 'called', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active')`,
        [PLAYER]
    );
}

async function addApprovedSpell(db, name, version = 1) {
    await db.run(
        `INSERT INTO clover_spellbook_spells
         (player_id, name, normalized_name, version, type, cost, reach, duration,
          effect, limits, adm_notes, status, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Criação', '100 mana', 'curto', '1 turno',
                 'Efeito existente.', 'Uma vez por cena.', '-', 'approved', ?, ?,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [PLAYER, name, normalizeSpellName(name), version, ADMIN, ADMIN]
    );
}

test('bloqueia novo feitiço sem slot e preserva chamada e grimório', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await addApprovedSpell(db, 'Feitiço Existente');
    await callPlayer(db);

    const result = await approveCalledSpell(db, PLAYER, sheet('Feitiço Novo'), ADMIN);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'spell_capacity_full');
    assert.equal(result.preservesQueueEntry, true);
    assert.equal(result.capacity.totalSlots, 1);
    assert.equal(result.capacity.occupiedSlots, 1);

    const queue = await db.get(
        `SELECT status FROM clover_spell_review_queue WHERE player_id = ?`,
        [PLAYER]
    );
    assert.equal(queue.status, 'called');
    assert.equal((await listApprovedSpells(db, PLAYER)).length, 1);
});

test('permite nova versão em slot já ocupado e conclui a fila atomicamente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await addApprovedSpell(db, 'Feitiço Existente');
    await callPlayer(db);

    const result = await approveCalledSpell(
        db,
        PLAYER,
        sheet('Feitiço Existente'),
        ADMIN,
        { nextVersion: true }
    );
    assert.equal(result.ok, true);
    assert.equal(result.code, 'spell_version_approved');
    assert.equal(result.spell.version, 2);
    assert.equal(result.createsNewSpellSlot, false);

    const queue = await db.get(
        `SELECT status FROM clover_spell_review_queue WHERE player_id = ?`,
        [PLAYER]
    );
    assert.equal(queue.status, 'concluded');
    const rows = await db.all(
        `SELECT version FROM clover_spellbook_spells
         WHERE player_id = ? AND normalized_name = ? ORDER BY version`,
        [PLAYER, normalizeSpellName('Feitiço Existente')]
    );
    assert.deepEqual(rows.map((row) => row.version), [1, 2]);
});

test('Ticket abre slot, aprovação salva feitiço e fecha chamada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const grant = await addCatalogItem(db, PLAYER, 'ticket_feitico', 1, {
        source: 'teste_aprovacao',
    });
    await useConsumable(db, PLAYER, grant.items[0].id, {
        idempotencyKey: 'approval-ticket:1',
        via: 'test',
    });
    await callPlayer(db);

    const result = await approveCalledSpell(db, PLAYER, sheet('Feitiço Novo'), ADMIN);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'spell_approved');
    assert.equal(result.createsNewSpellSlot, true);

    const capacity = await getSpellCapacity(db, PLAYER);
    assert.equal(capacity.totalSlots, 2);
    assert.equal(capacity.occupiedSlots, 1);
    assert.equal(capacity.availableSlots, 1);

    const queue = await db.get(
        `SELECT status FROM clover_spell_review_queue WHERE player_id = ?`,
        [PLAYER]
    );
    assert.equal(queue.status, 'concluded');
});
