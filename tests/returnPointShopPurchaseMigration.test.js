'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    RETURN_POINT_SHOP_0029_LEGACY_OBJECTS,
    RETURN_POINT_SHOP_PURCHASE_MIGRATION,
    inspect0029LegacyReturnPointShopPurchaseSchemaState,
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

async function create0029LegacyShop(db) {
    for (const object of RETURN_POINT_SHOP_0029_LEGACY_OBJECTS) {
        await db.exec(object.sql);
    }
}

test('0041 cria schema exato de compras e entitlements quando a familia esta ausente', async () => {
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

test('0041 reconhece e promove exatamente o lineage sintetico da migration 0029', async () => {
    const db = await createDb();
    try {
        await create0029LegacyShop(db);
        assert.equal((await inspect0029LegacyReturnPointShopPurchaseSchemaState(db)).kind, 'exact');
        assert.equal((await inspectReturnPointShopPurchaseSchemaState(db)).kind, 'partial_or_divergent');

        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);

        const state = await inspectReturnPointShopPurchaseSchemaState(db);
        assert.equal(state.kind, 'exact');
        assert.equal(state.objects.every((entry) => entry.exact), true);
        const legacyTables = await db.all(`
            SELECT name FROM sqlite_schema
            WHERE name IN ('clover_prereset_purchases_0029_legacy','clover_prereset_entitlements_0029_legacy')
        `);
        assert.deepEqual(legacyTables, []);
    } finally {
        await db.close();
    }
});

test('0041 preserva IDs e dados 0029 e traduz somente semantica conhecida de entitlement', async () => {
    const db = await createDb();
    try {
        await db.run('INSERT INTO jogadores (id) VALUES (?)', ['P1']);
        const ledger = await db.run('INSERT INTO clover_return_points_ledger (player_id) VALUES (?)', ['P1']);
        await create0029LegacyShop(db);

        const purchase = await db.run(
            `INSERT INTO clover_prereset_purchases
             (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,
              return_points_ledger_id,status,created_at,refunded_at,metadata_json)
             VALUES (?,?,?,?,?,?,'refunded','2026-08-01 10:00:00','2026-08-02 11:00:00',?)`,
            ['P1','legacy-idem','legacy_item','legacy:entitlement',25,Number(ledger.lastID),'{"legacy":true}']
        );
        const entitlement = await db.run(
            `INSERT INTO clover_prereset_entitlements
             (player_id,entitlement_key,purchase_id,status,reserved_for_player_id,granted_at,metadata_json)
             VALUES (?,?,?,'reserved',?,'2026-08-01 10:00:01',?)`,
            ['P1','legacy:entitlement',Number(purchase.lastID),'P1','{"old":1}']
        );

        await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);

        const migratedPurchase = await db.get('SELECT * FROM clover_prereset_purchases WHERE id=?', [purchase.lastID]);
        assert.equal(migratedPurchase.id, purchase.lastID);
        assert.equal(migratedPurchase.player_id, 'P1');
        assert.equal(migratedPurchase.idempotency_key, 'legacy-idem');
        assert.equal(migratedPurchase.catalog_item_key, 'legacy_item');
        assert.equal(migratedPurchase.entitlement_key, 'legacy:entitlement');
        assert.equal(migratedPurchase.price_return_points, 25);
        assert.equal(migratedPurchase.return_points_ledger_id, ledger.lastID);
        assert.equal(migratedPurchase.status, 'refunded');
        assert.equal(migratedPurchase.created_at, '2026-08-01 10:00:00');
        assert.equal(JSON.parse(migratedPurchase.metadata_json).legacy, true);
        assert.equal(JSON.parse(migratedPurchase.metadata_json).legacy_0029_refunded_at, '2026-08-02 11:00:00');

        const migratedEntitlement = await db.get('SELECT * FROM clover_prereset_entitlements WHERE id=?', [entitlement.lastID]);
        assert.equal(migratedEntitlement.id, entitlement.lastID);
        assert.equal(migratedEntitlement.player_id, 'P1');
        assert.equal(migratedEntitlement.entitlement_key, 'legacy:entitlement');
        assert.equal(migratedEntitlement.purchase_id, purchase.lastID);
        assert.equal(migratedEntitlement.status, 'active');
        assert.equal(migratedEntitlement.created_at, '2026-08-01 10:00:01');
        assert.equal(migratedEntitlement.consumed_at, null);
        const meta = JSON.parse(migratedEntitlement.metadata_json);
        assert.equal(meta.old, 1);
        assert.equal(meta.legacy_0029_status, 'reserved');
        assert.equal(meta.legacy_0029_reserved_for_player_id, 'P1');
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

test('0041 continua fail-closed quando qualquer objeto existente diverge fora do lineage 0029', async () => {
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

test('0041 falha fechado se lineage 0029 contiver player orfao em vez de apagar dados', async () => {
    const db = await createDb();
    try {
        await create0029LegacyShop(db);
        const ledger = await db.run('INSERT INTO clover_return_points_ledger (player_id) VALUES (?)', ['ORPHAN']);
        await db.run(
            `INSERT INTO clover_prereset_purchases
             (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id)
             VALUES ('ORPHAN','orphan-idem','legacy','legacy:orphan',25,?)`,
            [ledger.lastID]
        );
        await assert.rejects(
            RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db),
            (error) => error?.code === 'return_point_shop_0029_data_reconciliation_required'
        );
        assert.equal((await inspect0029LegacyReturnPointShopPurchaseSchemaState(db)).kind, 'exact');
        assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_prereset_purchases')).total, 1);
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