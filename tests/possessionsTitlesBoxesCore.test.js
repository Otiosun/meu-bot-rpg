'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
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

const {
    ensureCloverInventorySchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const {
    addCatalogItem,
    getAvailableInventoryQuantity,
} = require('../helpers/clover/inventoryService');
const { getBoxHistory, openBox } = require('../helpers/clover/boxService');
const {
    activatePlayerTitle,
    grantPlayerTitle,
    listPlayerTitleHistory,
    listPlayerTitles,
} = require('../helpers/clover/titleService');
const {
    ItemRedemptionServiceError,
    cancelItemRedemption,
    requestItemRedemption,
    resolveItemRedemption,
} = require('../helpers/clover/itemRedemptionService');
Module._load = originalLoad;

const PLAYER = 'player@lid';
const ADMIN = 'admin@lid';
const siteApiSource = fs.readFileSync(
    path.resolve(__dirname, '../helpers/clover/siteApiServerBase.js'),
    'utf8'
);

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
    await ensureCloverInventorySchema(db);
    await ensureCloverYullsLedgerSchema(db);
    return db;
}

test('Títulos permitem zero ou um ativo e registram histórico', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await grantPlayerTitle(db, PLAYER, { key: 'titulo_um', name: 'Título Um' }, {
        source: 'teste', idempotencyKey: 'title:one',
    });
    await grantPlayerTitle(db, PLAYER, { key: 'titulo_dois', name: 'Título Dois' }, {
        source: 'teste', idempotencyKey: 'title:two',
    });

    assert.equal((await activatePlayerTitle(db, PLAYER, 'titulo_um', {
        idempotencyKey: 'activate:one',
    })).activeTitle.key, 'titulo_um');
    assert.equal((await activatePlayerTitle(db, PLAYER, 'titulo_dois', {
        idempotencyKey: 'activate:two',
    })).activeTitle.key, 'titulo_dois');

    const activeCount = await db.get(
        'SELECT COUNT(*) AS total FROM clover_player_titles WHERE player_id = ? AND active = 1',
        [PLAYER]
    );
    assert.equal(Number(activeCount.total), 1);

    const none = await activatePlayerTitle(db, PLAYER, 'none', {
        idempotencyKey: 'activate:none',
    });
    assert.equal(none.activeTitle, null);
    assert.equal((await listPlayerTitles(db, PLAYER)).filter((title) => title.active).length, 0);

    const history = await listPlayerTitleHistory(db, PLAYER, 20);
    assert.ok(history.some((entry) => entry.action === 'activated'));
    assert.ok(history.some((entry) => entry.action === 'deactivated'));
});

test('Títulos expõem rota explícita para não usar título', () => {
    assert.match(siteApiSource, /POST \/economy\/titles\/deactivate/);
    assert.match(siteApiSource, /deactivatePlayerTitle\(db, playerId\)/);
    assert.match(siteApiSource, /POST \/economy\/titles\/:key\/activate/);
});

test('Cupom fica reservado e volta ao inventário ao cancelar ou recusar', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const grant = await addCatalogItem(db, PLAYER, 'cupom_prioridade', 2, { source: 'teste' });
    const itemId = grant.items[0].id;
    const first = await requestItemRedemption(db, PLAYER, itemId, null, {
        idempotencyKey: 'coupon:cancel',
    });
    assert.equal(first.redemption.action.actionKey, 'redeem_spell_priority_coupon');
    assert.equal(first.redemption.reservationStatus, 'active');

    const cancelled = await cancelItemRedemption(db, PLAYER, first.redemption.key, {
        reason: 'Desisti.',
    });
    assert.equal(cancelled.redemption.status, 'cancelled');
    assert.equal(cancelled.redemption.reservationStatus, 'released');

    const second = await requestItemRedemption(db, PLAYER, itemId, null, {
        idempotencyKey: 'coupon:reject',
    });
    await assert.rejects(
        resolveItemRedemption(db, ADMIN, second.redemption.key, 'rejected', ''),
        (error) => error instanceof ItemRedemptionServiceError
            && error.code === 'resolution_note_required'
    );
    const rejected = await resolveItemRedemption(
        db,
        ADMIN,
        second.redemption.key,
        'rejected',
        'Pedido recusado para este ciclo.'
    );
    assert.equal(rejected.redemption.status, 'rejected');
    assert.equal(rejected.redemption.reservationStatus, 'released');
    assert.equal((await getAvailableInventoryQuantity(db, PLAYER, itemId)).available, 2);
});

test('aprovação do Cupom consome somente uma unidade', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const grant = await addCatalogItem(db, PLAYER, 'cupom_prioridade', 2, { source: 'teste' });
    const itemId = grant.items[0].id;
    const request = await requestItemRedemption(db, PLAYER, itemId, null, {
        idempotencyKey: 'coupon:approve',
    });
    const approved = await resolveItemRedemption(
        db,
        ADMIN,
        request.redemption.key,
        'approved',
        'Prioridade aplicada no fluxo manual.'
    );
    assert.equal(approved.redemption.status, 'approved');
    assert.equal(approved.redemption.reservationStatus, 'consumed');
    const available = await getAvailableInventoryQuantity(db, PLAYER, itemId);
    assert.equal(available.owned, 1);
    assert.equal(available.available, 1);
});

test('Vale contextual não entra na fila de resgate', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const grant = await addCatalogItem(db, PLAYER, 'vale_compra_2000', 1, { source: 'teste' });
    await assert.rejects(
        requestItemRedemption(db, PLAYER, grant.items[0].id, null, {
            idempotencyKey: 'voucher:blocked',
        }),
        (error) => error instanceof ItemRedemptionServiceError
            && error.code === 'item_not_redeemable'
            && error.details.action.mode === 'contextual'
    );
});

test('Caixa devolve recibo normalizado e abertura recuperável', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await addCatalogItem(db, PLAYER, 'box_simple_v1', 1, { source: 'teste' });
    const opened = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'box:receipt:1',
        roll: 1,
        randomInt: (min) => min,
    });
    assert.equal(opened.ok, true);
    assert.match(opened.operation.code, /^CX-\d{6}$/);
    assert.equal(opened.presentation.headline, 'Você ganhou');
    assert.equal(opened.presentation.reward.destination.key, 'wallet');
    assert.equal(opened.presentation.recoverable, true);

    const duplicate = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'box:receipt:1',
        roll: 1,
        randomInt: (min) => min,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.openingId, opened.openingId);
    assert.equal((await getBoxHistory(db, PLAYER, 10)).length, 1);
});
