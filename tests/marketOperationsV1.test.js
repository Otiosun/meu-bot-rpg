'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let createAsyncAdapter;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createAsyncAdapter = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    Module._load = function loadSqliteFallback(request, parent, isMain) {
        if (request === 'sqlite3') return { verbose: () => ({ Database: class TestDriver {} }) };
        if (request === 'sqlite') return { open: async () => { throw new Error('open() não deve ser usado'); } };
        return originalLoad.call(this, request, parent, isMain);
    };
    createAsyncAdapter = async () => {
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

const { ensureCloverEconomySchema } = require('../database');
Module._load = originalLoad;

const { addCatalogItem } = require('../helpers/clover/inventoryService');
const { getYullsSummary } = require('../helpers/clover/yullsService');
const {
    MarketServiceError,
    confirmMarketPurchase,
    confirmPayment,
    confirmSecureTrade,
    createMarketListing,
    createSecureTrade,
    finalizeAuction,
    fulfillWeeklyNpcRequest,
    listWeeklyNpcRequests,
    placeAuctionBid,
    previewMarketPurchase,
    previewPayment,
} = require('../helpers/clover/marketService');

const SELLER = '5511000000001@s.whatsapp.net';
const BUYER = '5511000000002@s.whatsapp.net';
const THIRD = '5511000000003@s.whatsapp.net';

async function createTestDb() {
    const db = await createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-', display_name TEXT DEFAULT '-', personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado', esquadrao TEXT DEFAULT 'Coringas Magenta',
            patente TEXT DEFAULT 'Júnior 2ª Classe', dinheiro INTEGER DEFAULT 0
        )
    `);
    for (const [id, name] of [[SELLER, 'Vendedor'], [BUYER, 'Comprador'], [THIRD, 'Terceiro']]) {
        await db.run('INSERT INTO jogadores (id, personagem_nome, dinheiro) VALUES (?, ?, 10000)', [id, name]);
    }
    await ensureCloverEconomySchema(db);
    return db;
}

test('pagamento direto reserva, confirma e gera os dois lados do recibo', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const preview = await previewPayment(db, SELLER, BUYER, 1500, 'Pagamento por informação', { idempotencyKey: 'payment-1' });
    assert.equal((await getYullsSummary(db, SELLER)).available, 8500);
    await confirmPayment(db, SELLER, preview.payment.key);
    assert.equal((await getYullsSummary(db, SELLER)).total, 8500);
    assert.equal((await getYullsSummary(db, BUYER)).total, 11500);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_yulls_ledger WHERE related_id = ?", [preview.payment.key])).total, 2);
});

test('mercado fixo cobra publicação, reserva o item e paga 95% ao vendedor', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const item = await addCatalogItem(db, SELLER, 'kit_campo', 1, { source: 'raid_reward' });
    const listing = await createMarketListing(db, SELLER, {
        type: 'fixed', inventoryItemId: item.items[0].id, quantity: 1, unitPrice: 1000,
    });
    assert.equal(listing.publicationFee, 100);
    assert.equal((await getYullsSummary(db, SELLER)).total, 9900);
    const preview = await previewMarketPurchase(db, BUYER, listing.listing.key, 1, { idempotencyKey: 'market-buy-1' });
    const confirmed = await confirmMarketPurchase(db, BUYER, preview.intent.intent_key);
    assert.equal(confirmed.fee, 50);
    assert.equal(confirmed.sellerNet, 950);
    assert.equal((await getYullsSummary(db, SELLER)).total, 10850);
    assert.equal((await getYullsSummary(db, BUYER)).total, 9000);
    const received = await db.get("SELECT * FROM clover_inventory_items WHERE player_id = ? AND template_key = 'kit_campo'", [BUYER]);
    assert.ok(received);
});

test('leilão libera o lance superado, exige incremento e aplica anti-sniping', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const now = new Date('2026-07-17T12:00:00Z');
    const item = await addCatalogItem(db, SELLER, 'adaga', 1, { source: 'raid_reward' });
    const created = await createMarketListing(db, SELLER, {
        type: 'auction', inventoryItemId: item.items[0].id, quantity: 1, startingBid: 1000, durationHours: 24,
    }, { now });
    await placeAuctionBid(db, BUYER, created.listing.key, 1000, { idempotencyKey: 'bid-1', now: new Date('2026-07-18T11:00:00Z') });
    await assert.rejects(
        () => placeAuctionBid(db, THIRD, created.listing.key, 1099, { idempotencyKey: 'bid-low', now: new Date('2026-07-18T11:10:00Z') }),
        (error) => error instanceof MarketServiceError && error.code === 'bid_too_low'
    );
    const second = await placeAuctionBid(db, THIRD, created.listing.key, 1100, {
        idempotencyKey: 'bid-2', now: new Date('2026-07-18T11:56:00Z'),
    });
    assert.equal(second.extended, true);
    assert.equal((await getYullsSummary(db, BUYER)).reserved, 0);
    assert.equal((await getYullsSummary(db, THIRD)).reserved, 1100);
    await db.run("UPDATE clover_market_listings SET ends_at = datetime('now', '-1 minute') WHERE listing_key = ?", [created.listing.key]);
    const finalized = await finalizeAuction(db, created.listing.key, { force: true });
    assert.equal(finalized.sold, true);
    assert.equal((await getYullsSummary(db, THIRD)).total, 8900);
    assert.equal((await getYullsSummary(db, SELLER)).total, 10945);
});

test('Troca Segura só conclui após as duas confirmações e move itens e Yulls atomicamente', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const sellerItem = await addCatalogItem(db, SELLER, 'kit_campo', 1, { source: 'raid_reward' });
    const buyerItem = await addCatalogItem(db, BUYER, 'pocao_antidoto', 1, { source: 'raid_reward' });
    const created = await createSecureTrade(db, SELLER, BUYER, {
        creatorItems: [{ inventoryItemId: sellerItem.items[0].id, quantity: 1 }],
        targetItems: [{ inventoryItemId: buyerItem.items[0].id, quantity: 1 }],
        creatorYulls: 500,
        targetYulls: 200,
    });
    const first = await confirmSecureTrade(db, SELLER, created.trade.key);
    assert.equal(first.completed, false);
    const second = await confirmSecureTrade(db, BUYER, created.trade.key);
    assert.equal(second.completed, true);
    assert.equal((await getYullsSummary(db, SELLER)).total, 9700);
    assert.equal((await getYullsSummary(db, BUYER)).total, 10300);
    assert.ok(await db.get("SELECT id FROM clover_inventory_items WHERE player_id = ? AND template_key = 'pocao_antidoto'", [SELLER]));
    assert.ok(await db.get("SELECT id FROM clover_inventory_items WHERE player_id = ? AND template_key = 'kit_campo'", [BUYER]));
});

test('pedido semanal paga imediatamente, respeita limite e bloqueia arbitragem da loja NPC', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    await addCatalogItem(db, SELLER, 'kit_campo', 1, { source: 'raid' });
    await addCatalogItem(db, BUYER, 'pocao_antidoto', 1, { source: 'raid' });
    await addCatalogItem(db, THIRD, 'adaga', 1, { source: 'raid' });
    const requests = await listWeeklyNpcRequests(db, SELLER, { now: new Date('2026-07-17T12:00:00Z') });
    assert.equal(requests.length, 3);
    const request = requests[0];
    const loot = await addCatalogItem(db, SELLER, request.templateKey, 1, { source: 'raid_reward' });
    const before = (await getYullsSummary(db, SELLER)).total;
    const delivered = await fulfillWeeklyNpcRequest(db, SELLER, request.key, loot.items[0].id, 1, {
        idempotencyKey: 'weekly-delivery-1', now: new Date('2026-07-17T12:00:00Z'),
    });
    assert.equal((await getYullsSummary(db, SELLER)).total, before + delivered.delivery.total);

    const storeItem = await addCatalogItem(db, SELLER, request.templateKey, 1, { source: 'loja_npc' });
    await assert.rejects(
        () => fulfillWeeklyNpcRequest(db, SELLER, request.key, storeItem.items[0].id, 1, {
            idempotencyKey: 'weekly-delivery-arbitrage', now: new Date('2026-07-17T12:00:00Z'),
        }),
        (error) => error instanceof MarketServiceError && error.code === 'weekly_request_arbitrage'
    );
});
