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
                return { changes: Number(result.changes || 0), lastID: Number(result.lastInsertRowid || 0) };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

Module._load = function loadWithPhStub(request, parent, isMain) {
    const parentFile = String(parent?.filename || '');
    if (request === './phService' && (parentFile.endsWith('boxService.js') || parentFile.endsWith('prShopService.js'))) {
        return {
            ensurePhState: async (db) => db.exec(`
                CREATE TABLE IF NOT EXISTS test_ph_awards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    player_id TEXT NOT NULL,
                    amount INTEGER NOT NULL,
                    related_id TEXT DEFAULT NULL
                )
            `),
            addPhInTransaction: async (db, playerId, amount, source, reason, createdBy, metadata, relatedId) => {
                const inserted = await db.run(
                    'INSERT INTO test_ph_awards (player_id, amount, related_id) VALUES (?, ?, ?)',
                    [playerId, amount, relatedId]
                );
                return { ledgerId: inserted.lastID };
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    ensureCloverInventorySchema,
    ensureCloverRecruitmentSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const { addCatalogItem } = require('../helpers/clover/inventoryService');
const { getBoxDashboard, openBox } = require('../helpers/clover/boxService');
const {
    PR_SHOP_CATALOG,
    PrShopServiceError,
    ensurePrShopSchema,
    getPrShopDashboard,
    purchasePrShopItem,
} = require('../helpers/clover/prShopService');
const { validateBoxCatalogs } = require('../helpers/clover/seasonalEventCatalog');
Module._load = originalLoad;

async function setup() {
    const db = await createDb();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            jogo_status TEXT DEFAULT 'liberado',
            jogo_liberado_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    for (let index = 1; index <= 10; index += 1) {
        await db.run(
            `INSERT INTO jogadores (id, personagem_nome, jogo_status, dinheiro)
             VALUES (?, ?, 'liberado', 0)`,
            [`p${index}`, `Player ${index}`]
        );
    }
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverRecruitmentSchema(db);
    await ensureCloverInventorySchema(db);
    await db.run(`
        UPDATE clover_recruitment_events
        SET status = 'active', shop_enabled = 1, starts_at = datetime('now', '-1 day'), ends_at = datetime('now', '+30 day')
        WHERE event_key = 'divulgacao_v1'
    `);
    const event = await db.get("SELECT id FROM clover_recruitment_events WHERE event_key = 'divulgacao_v1'");
    for (let index = 1; index <= 10; index += 1) {
        await db.run(
            `INSERT INTO clover_pr_ledger
             (player_id, event_id, amount, kind, source, week_key, reason, idempotency_key, created_at)
             VALUES (?, ?, 100, 'ajuste_admin', 'ajuste_admin', '2026-07-20', 'saldo de teste', ?, CURRENT_TIMESTAMP)`,
            [`p${index}`, event.id, `seed:pr:p${index}`]
        );
    }
    return { db, event };
}

test('preparar schema da loja nao reabre uma loja fechada', async (t) => {
    const { db } = await setup();
    t.after(() => db.close());
    await db.run("UPDATE clover_recruitment_events SET shop_enabled=0 WHERE event_key='divulgacao_v1'");
    await ensurePrShopSchema(db);
    const before = await db.get('SELECT COUNT(*) count,SUM(amount) balance FROM clover_pr_ledger');
    await assert.rejects(purchasePrShopItem(db,'p1','yulls_2500',1,{idempotencyKey:'closed-shop-test'}),error=>error.code==='shop_not_active');
    assert.deepEqual(await db.get('SELECT COUNT(*) count,SUM(amount) balance FROM clover_pr_ledger'),before);
    assert.equal((await db.get("SELECT dinheiro FROM jogadores WHERE id='p1'")).dinheiro,0);
    const event = await db.get("SELECT shop_enabled FROM clover_recruitment_events WHERE event_key='divulgacao_v1'");
    assert.equal(event.shop_enabled, 0);
});

test('catálogos sazonais fecham em 100% e loja usa os valores definidos', () => {
    assert.deepEqual(validateBoxCatalogs(), [
        {
            key: 'simples',
            totalChance: 100,
            rewardCount: 13,
            tierTotals: {
                common: 44,
                mid: 43.9,
                high_non_relic: 12,
                ultra_relic: 0.1,
            },
        },
        {
            key: 'rara',
            totalChance: 100,
            rewardCount: 11,
            tierTotals: {
                common: 33.8,
                mid: 53,
                high_non_relic: 13,
                ultra_relic: 0.2,
            },
        },
    ]);
    assert.deepEqual(
        PR_SHOP_CATALOG.map((item) => [item.key, item.cost, item.limits]),
        [
            ['yulls_2500', 1, { weekly: 10 }],
            ['caixa_simples', 3, { weekly: 10 }],
            ['ph_5', 5, { weekly: 6 }],
            ['caixa_rara', 6, { weekly: 5 }],
            ['ticket_feitico', 15, { weekly: 1 }],
            ['cupom_prioridade_feitico', 20, { weekly: 1 }],
            ['titulo_recrutador', 20, { oneTime: true }],
            ['dungeon_exclusiva', 30, { eventGlobal: 8 }],
        ]
    );
});

test('loja aplica limite semanal, compra única e estoque global do evento', async (t) => {
    const { db, event } = await setup();
    t.after(() => db.close());

    const dashboard = await getPrShopDashboard(db, 'p1', { weekKey: '2026-07-20' });
    assert.equal(dashboard.event.shopEnabled, true);
    assert.equal(dashboard.items.find((item) => item.key === 'yulls_2500').limits.weeklyRemaining, 10);

    const yulls = await purchasePrShopItem(db, 'p1', 'yulls_2500', 10, {
        weekKey: '2026-07-20',
        idempotencyKey: 'shop:p1:yulls',
    });
    assert.equal(yulls.totalPrCost, 10);
    assert.equal(yulls.reward.amount, 25000);
    await assert.rejects(
        () => purchasePrShopItem(db, 'p1', 'yulls_2500', 1, {
            weekKey: '2026-07-20',
            idempotencyKey: 'shop:p1:yulls:extra',
        }),
        (error) => error instanceof PrShopServiceError && error.code === 'weekly_limit'
    );

    await purchasePrShopItem(db, 'p1', 'titulo_recrutador', 1, { idempotencyKey: 'shop:p1:title' });
    await assert.rejects(
        () => purchasePrShopItem(db, 'p1', 'titulo_recrutador', 1, { idempotencyKey: 'shop:p1:title:2' }),
        (error) => error instanceof PrShopServiceError && error.code === 'one_time_limit'
    );

    for (let index = 1; index <= 7; index += 1) {
        await db.run(
            `INSERT INTO clover_pr_shop_purchases
             (purchase_key, event_id, player_id, item_key, quantity, unit_pr_cost, total_pr_cost,
              week_key, status, idempotency_key, created_at, completed_at)
             VALUES (?, ?, ?, 'dungeon_exclusiva', 1, 30, 30, NULL, 'completed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [`seed:dungeon:${index}`, event.id, `p${index}`, `seed:dungeon:idempotency:${index}`]
        );
    }
    const eighth = await purchasePrShopItem(db, 'p8', 'dungeon_exclusiva', 1, { idempotencyKey: 'shop:p8:dungeon' });
    assert.equal(eighth.dashboard.items.find((item) => item.key === 'dungeon_exclusiva').limits.globalRemaining, 0);
    await assert.rejects(
        () => purchasePrShopItem(db, 'p9', 'dungeon_exclusiva', 1, { idempotencyKey: 'shop:p9:dungeon' }),
        (error) => error instanceof PrShopServiceError && error.code === 'global_stock'
    );
});

test('relíquias saem do pool após o primeiro portador e pool vazio gera novo sorteio', async (t) => {
    const { db } = await setup();
    t.after(() => db.close());

    for (const playerId of ['p1', 'p2']) {
        await addCatalogItem(db, playerId, 'box_simple_v1', 1, { source: 'teste' });
    }
    const minimumRandom = (min) => min;
    const first = await openBox(db, 'p1', 'simples', {
        idempotencyKey: 'box:p1:relic',
        roll: 10000,
        randomInt: minimumRandom,
    });
    const second = await openBox(db, 'p2', 'simples', {
        idempotencyKey: 'box:p2:relic',
        roll: 10000,
        randomInt: minimumRandom,
    });
    assert.equal(first.reward.type, 'relic');
    assert.equal(second.reward.type, 'relic');
    assert.notEqual(first.reward.templateKey, second.reward.templateKey);

    const state = await getBoxDashboard(db, 'p1');
    let fakeOpening = -1;
    for (const relic of state.relics.relics.filter((item) => !item.claimed)) {
        await db.run(
            `INSERT INTO clover_seasonal_relic_ownership
             (relic_key, player_id, box_opening_id, claimed_at, metadata_json)
             VALUES (?, 'p10', ?, CURRENT_TIMESTAMP, '{}')`,
            [relic.key, fakeOpening--]
        );
    }

    await addCatalogItem(db, 'p3', 'box_simple_v1', 1, { source: 'teste' });
    const fallback = await openBox(db, 'p3', 'simples', {
        idempotencyKey: 'box:p3:fallback',
        roll: 10000,
        randomInt: minimumRandom,
    });
    assert.notEqual(fallback.reward.type, 'relic');
    assert.equal(fallback.reward.rerolledFrom, 'reliquia_exclusiva');
    assert.equal((await getBoxDashboard(db, 'p3')).relics.available, 0);
});
