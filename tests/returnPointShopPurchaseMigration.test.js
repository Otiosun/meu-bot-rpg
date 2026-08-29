'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    RETURN_POINT_SHOP_PURCHASE_MIGRATION,
    inspectReturnPointShopPurchaseSchemaState,
} = require('../helpers/clover/returnPointShopPurchaseMigration');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec(`
        CREATE TABLE jogadores (id TEXT PRIMARY KEY);
        CREATE TABLE clover_return_points_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL
        );
    `);
    return db;
}

test('0041 cria schema exato de compras e entitlements', async () => {
    const db = await createDb();
    try {
        assert.equal((await inspectReturnPointShopPurchaseSchemaState(db)).kind, 'absent');
        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);
        const state = await inspectReturnPointShopPurchaseSchemaState(db);
        assert.equal(state.kind, 'exact');
        assert.equal(state.objects.every((entry) => entry.exact), true);
    } finally {
        await db.close();
    }
});

test('0041 e idempotente quando o schema canonico ja existe', async () => {
    const db = await createDb();
    try {
        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);
        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);
        assert.equal((await inspectReturnPointShopPurchaseSchemaState(db)).kind, 'exact');
    } finally {
        await db.close();
    }
});

test('0041 completa estado parcial quando todo objeto existente e canonico', async () => {
    const db = await createDb();
    try {
        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);
        await db.exec('DROP INDEX idx_prereset_entitlements_player');
        const partial = await inspectReturnPointShopPurchaseSchemaState(db);
        assert.equal(partial.kind, 'partial_or_divergent');
        assert.equal(partial.objects.filter((entry) => entry.exists).every((entry) => entry.exact), true);

        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);
        const healed = await inspectReturnPointShopPurchaseSchemaState(db);
        assert.equal(healed.kind, 'exact');
        assert.equal(healed.objects.every((entry) => entry.exact), true);
    } finally {
        await db.close();
    }
});

test('0041 continua fail-closed quando qualquer objeto existente diverge', async () => {
    const db = await createDb();
    try {
        await db.exec('CREATE TABLE clover_prereset_purchases (id INTEGER PRIMARY KEY)');
        const divergent = await inspectReturnPointShopPurchaseSchemaState(db);
        assert.equal(divergent.kind, 'partial_or_divergent');
        assert.equal(divergent.objects.find((entry) => entry.name === 'clover_prereset_purchases').exact, false);

        await assert.rejects(
            RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db),
            (error) => error?.code === 'return_point_shop_purchase_schema_reconciliation_required'
        );
    } finally {
        await db.close();
    }
});

test('schema garante idempotencia da compra e entitlement unico por jogador', async () => {
    const db = await createDb();
    try {
        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);
        await db.run('INSERT INTO jogadores (id) VALUES (?)', ['P1']);
        const ledger = await db.run('INSERT INTO clover_return_points_ledger (player_id) VALUES (?)', ['P1']);
        const purchase = await db.run(
            `INSERT INTO clover_prereset_purchases
             (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id)
             VALUES (?,?,?,?,?,?)`,
            ['P1','idem-1','caixa_comum','return-shop:caixa_comum:r0:n1',25,Number(ledger.lastID)]
        );
        await db.run(
            `INSERT INTO clover_prereset_entitlements
             (player_id,entitlement_key,purchase_id,metadata_json)
             VALUES (?,?,?,?)`,
            ['P1','return-shop:caixa_comum:r0:n1',Number(purchase.lastID),'{}']
        );
        await assert.rejects(
            db.run(
                `INSERT INTO clover_prereset_purchases
                 (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id)
                 VALUES (?,?,?,?,?,?)`,
                ['P1','idem-1','caixa_rara','other',40,Number(ledger.lastID)]
            )
        );
        const counts = await db.get(`
            SELECT
              (SELECT COUNT(*) FROM clover_prereset_purchases) AS purchases,
              (SELECT COUNT(*) FROM clover_prereset_entitlements) AS entitlements
        `);
        assert.equal(counts.purchases, 1);
        assert.equal(counts.entitlements, 1);
    } finally {
        await db.close();
    }
});
