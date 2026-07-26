'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let createDb;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    createDb = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return {
                    changes: Number(result.changes || 0),
                    lastID: Number(result.lastInsertRowid || 0),
                };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const {
    ensureCloverInventorySchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const { addCatalogItem } = require('../helpers/clover/inventoryService');
const { useConsumable } = require('../helpers/clover/economyService');
const { getPlayerPossessions } = require('../helpers/clover/possessionsService');
const { getSpellCapacity } = require('../helpers/clover/spellCapacityService');

const PLAYER = 'legacy-capacity@lid';

async function setup() {
    const db = await createDb();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            jogo_status TEXT DEFAULT 'liberado'
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro)
         VALUES (?, 'Legado de Teste', 0)`,
        [PLAYER]
    );
    await ensureCloverInventorySchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await getSpellCapacity(db, PLAYER);
    return db;
}

async function addApprovedSpell(db, name, normalizedName) {
    await db.run(
        `INSERT INTO clover_spellbook_spells (
            player_id, name, normalized_name, version, type, cost, reach,
            duration, effect, limits, adm_notes, status, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'Criação', '-', '-', '-', 'Efeito de teste', '-', '-',
                   'approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [PLAYER, name, normalizedName]
    );
}

test('excesso legado preserva feitiços e um Ticket regulariza uma dívida de slot', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await addApprovedSpell(db, 'Feitiço Um', 'feitico_um');
    await addApprovedSpell(db, 'Feitiço Dois', 'feitico_dois');

    let capacity = await getSpellCapacity(db, PLAYER);
    assert.equal(capacity.totalSlots, 1);
    assert.equal(capacity.occupiedSlots, 2);
    assert.equal(capacity.overCapacity, true);
    assert.equal(capacity.capacityDebt, 1);
    assert.equal(capacity.regularizationTicketsNeeded, 1);
    assert.equal(capacity.regularizationState, 'legacy_over_capacity');
    assert.equal(capacity.preservesApprovedSpells, true);
    assert.equal(capacity.canApproveNewSpell, false);

    let possessions = await getPlayerPossessions(db, PLAYER);
    assert.equal(possessions.summary.spellCapacityDebt, 1);
    assert.equal(possessions.summary.spellCapacityState, 'legacy_over_capacity');
    assert.equal(possessions.summary.canApproveNewSpell, false);

    const grant = await addCatalogItem(db, PLAYER, 'ticket_feitico', 1, {
        source: 'teste_regularizacao',
    });
    await useConsumable(db, PLAYER, grant.items[0].id, {
        idempotencyKey: 'legacy-capacity:ticket:1',
        via: 'test',
    });

    capacity = await getSpellCapacity(db, PLAYER);
    assert.equal(capacity.totalSlots, 2);
    assert.equal(capacity.occupiedSlots, 2);
    assert.equal(capacity.overCapacity, false);
    assert.equal(capacity.capacityDebt, 0);
    assert.equal(capacity.regularizationState, 'regular');
    assert.equal(capacity.canApproveNewSpell, false);

    possessions = await getPlayerPossessions(db, PLAYER);
    assert.equal(possessions.summary.spellCapacityDebt, 0);
    assert.equal(possessions.summary.spellCapacityState, 'regular');
    assert.equal(possessions.spellCapacity.sourceBreakdown.directTicketUses, 1);
}