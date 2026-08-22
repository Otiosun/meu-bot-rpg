'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
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

Module._load = function loadWithStubs(request, parent, isMain) {
    const parentFile = String(parent?.filename || '');
    if (request === './phService' && parentFile.endsWith('boxService.js')) {
        return {
            ensurePhState: async () => ({ ok: true }),
            addPhInTransaction: async () => ({ ledgerId: 1 }),
        };
    }
    if (request === './itemAdminService' && parentFile.endsWith('itemRedemptionService.js')) {
        return {
            requireItemManager: async (db, actorId) => ({
                actorId,
                context: { owner: true, roleKeys: [] },
            }),
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { prepareCanonicalSchema } = require('./helpers/canonicalRaidSchemaFixture');
const {
    addCatalogItem,
    getAvailableInventoryQuantity,
} = require('../helpers/clover/inventoryService');
const { useConsumable } = require('../helpers/clover/economyService');
const {
    ItemRedemptionServiceError,
    requestItemRedemption,
} = require('../helpers/clover/itemRedemptionService');
const { getPlayerPossessions } = require('../helpers/clover/possessionsService');
const { getSpellCapacity } = require('../helpers/clover/spellCapacityService');
Module._load = originalLoad;

const PLAYER = 'player@lid';
const ADMIN = 'admin@lid';

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
         VALUES (?, 'Player de Teste', 0)`,
        [PLAYER]
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro)
         VALUES (?, 'Administrador', 0)`,
        [ADMIN]
    );
    await prepareCanonicalSchema(db);
    return db;
}

test('todo personagem começa com um slot e a fila não reserva capacidade', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const capacity = await getSpellCapacity(db, PLAYER);
    assert.equal(capacity.status, 'ready');
    assert.equal(capacity.baseSlots, 1);
    assert.equal(capacity.additionalSlots, 0);
    assert.equal(capacity.totalSlots, 1);
    assert.equal(capacity.reservedSlots, 0);
    assert.equal(capacity.reviewQueueIsNotPersonalCapacity, true);
});

test('Ticket é usado diretamente, concede +1 slot e é idempotente', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const grant = await addCatalogItem(db, PLAYER, 'ticket_feitico', 2, { source: 'teste' });
    const itemId = grant.items[0].id;

    await assert.rejects(
        requestItemRedemption(db, PLAYER, itemId, null, {
            idempotencyKey: 'redeem:ticket:blocked',
        }),
        (error) => (
            error instanceof ItemRedemptionServiceError
            && error.code === 'item_not_redeemable'
            && error.details.action.mode === 'direct'
        )
    );

    const used = await useConsumable(db, PLAYER, itemId, {
        idempotencyKey: 'use:ticket:1',
        via: 'site',
    });
    assert.equal(used.ok, true);
    assert.equal(used.duplicate, false);
    assert.equal(used.result, 'used');

    const capacity = await getSpellCapacity(db, PLAYER);
    assert.equal(capacity.additionalSlots, 1);
    assert.equal(capacity.totalSlots, 2);
    assert.equal(capacity.sourceBreakdown.directTicketUses, 1);

    const duplicate = await useConsumable(db, PLAYER, itemId, {
        idempotencyKey: 'use:ticket:1',
        via: 'site',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal((await getSpellCapacity(db, PLAYER)).totalSlots, 2);

    const available = await getAvailableInventoryQuantity(db, PLAYER, itemId);
    assert.equal(available.owned, 1);
    assert.equal(available.available, 1);
});

test('Central de Posses classifica Ticket e mostra slots reais', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const grant = await addCatalogItem(db, PLAYER, 'ticket_feitico', 1, { source: 'teste' });
    let possessions = await getPlayerPossessions(db, PLAYER);

    assert.equal(possessions.spellCapacity.totalSlots, 1);
    assert.equal(possessions.summary.ticketItemRows, 1);
    const ticket = possessions.items.special.find((item) => item.id === grant.items[0].id);
    assert.equal(ticket.possessionCategory, 'ticket');
    assert.equal(ticket.useAction.actionKey, 'use_spell_ticket');
    assert.equal(ticket.useAction.mode, 'direct');
    assert.equal(ticket.useAction.requiresReview, false);

    await useConsumable(db, PLAYER, grant.items[0].id, {
        idempotencyKey: 'use:ticket:possessions',
        via: 'site',
    });
    possessions = await getPlayerPossessions(db, PLAYER);
    assert.equal(possessions.spellCapacity.totalSlots, 2);
    assert.equal(possessions.summary.spellSlotsTotal, 2);
});

test('Central de Posses mostra Caixa Simples de Servico da Loja de PA', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_inventory_items
         (player_id, item_name, description, quantity, kind, source, related_id, category, status)
         VALUES (?, 'Caixa Simples de Serviço', 'Caixa da Loja de PA.', 1, 'caixa_pa', 'pa_shop', 'pa_shop:test', 'caixa', 'disponivel')`,
        [PLAYER]
    );

    const possessions = await getPlayerPossessions(db, PLAYER);

    assert.equal(possessions.summary.boxItemRows, 1);
    const box = possessions.items.special.find((item) => item.kind === 'caixa_pa');
    assert.equal(box.possessionCategory, 'box');
    assert.equal(box.useAction.actionKey, 'open_pa_box');
    assert.equal(box.useAction.mode, 'direct');
});

test('resgate antigo aprovado de Ticket conta como slot adicional', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const grant = await addCatalogItem(db, PLAYER, 'ticket_feitico', 1, { source: 'legado' });
    const itemId = grant.items[0].id;
    const reservation = await db.run(
        `INSERT INTO clover_inventory_reservations
         (reservation_key, inventory_item_id, player_id, quantity, source_type, source_id,
          status, created_by, created_at, updated_at, released_at, metadata_json)
         VALUES ('legacy-ticket-reservation', ?, ?, 0, 'item_redemption', 'RES-LEGACY',
                 'consumed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}')`,
        [itemId, PLAYER, PLAYER]
    );
    await db.run(
        `INSERT INTO clover_item_redemptions
         (redemption_key, player_id, inventory_item_id, reservation_id, template_key,
          item_name, redemption_kind, status, requested_at, resolved_at, resolved_by,
          idempotency_key, metadata_json)
         VALUES ('RES-LEGACY', ?, ?, ?, 'ticket_feitico', 'Ticket de Feitiço',
                 'ticket_feitico', 'approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?,
                 'legacy-ticket-approved', '{}')`,
        [PLAYER, itemId, reservation.lastID, ADMIN]
    );

    const capacity = await getSpellCapacity(db, PLAYER);
    assert.equal(capacity.sourceBreakdown.legacyApprovedTicketUses, 1);
    assert.equal(capacity.additionalSlots, 1);
    assert.equal(capacity.totalSlots, 2);
});
