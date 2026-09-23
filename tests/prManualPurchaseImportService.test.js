'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensurePreresetManualPurchaseSchema,
    importManualReturnShopPurchases,
} = require('../helpers/clover/prManualPurchaseImportService');

async function setup() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado'
        );
        INSERT INTO jogadores (id, personagem_nome)
        VALUES ('player@lid', 'Player Um');
    `);
    await ensurePreresetManualPurchaseSchema(db);
    return db;
}

test('importa compras manuais como entitlements rastreaveis sem debitar PR', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const result = await importManualReturnShopPurchases(db, [
        {
            playerId: 'player@lid',
            catalogItemKey: 'roll_slot_bonus',
            entitlementKey: 'roll_slot_bonus:slot_1',
            targetRollNumber: 1,
            note: 'Compra manual da loja de retorno',
        },
    ], {
        importKey: 'manual-list-001',
        createdBy: 'owner@lid',
    });

    assert.equal(result.created, 1);
    assert.equal(result.duplicates, 0);
    assert.equal(result.entries.length, 1);

    const purchase = await db.get(
        'SELECT * FROM clover_prereset_purchases WHERE player_id = ?',
        ['player@lid']
    );
    assert.equal(purchase.catalog_item_key, 'roll_slot_bonus');
    assert.equal(purchase.entitlement_key, 'roll_slot_bonus:slot_1');
    assert.equal(purchase.price_return_points, 0);
    assert.equal(purchase.return_points_ledger_id, 0);
    assert.equal(purchase.status, 'completed');

    const entitlement = await db.get(
        'SELECT * FROM clover_prereset_entitlements WHERE purchase_id = ?',
        [purchase.id]
    );
    assert.equal(entitlement.player_id, 'player@lid');
    assert.equal(entitlement.entitlement_key, 'roll_slot_bonus:slot_1');
    assert.equal(entitlement.status, 'active');
    const metadata = JSON.parse(entitlement.metadata_json);
    assert.equal(metadata.fulfillment_status, 'pending');
    assert.equal(metadata.target_roll_number, 1);
    assert.equal(metadata.source_import_key, 'manual-list-001');
});

test('reimportar a mesma lista manual nao cria duplicatas', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const entries = [
        {
            playerId: 'player@lid',
            catalogItemKey: 'roll_slot_bonus',
            entitlementKey: 'roll_slot_bonus:slot_1',
        },
    ];

    const first = await importManualReturnShopPurchases(db, entries, {
        importKey: 'manual-list-001',
        createdBy: 'owner@lid',
    });
    const second = await importManualReturnShopPurchases(db, entries, {
        importKey: 'manual-list-001',
        createdBy: 'owner@lid',
    });

    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal(second.duplicates, 1);

    const purchases = await db.get(
        'SELECT COUNT(*) AS total FROM clover_prereset_purchases'
    );
    const entitlements = await db.get(
        'SELECT COUNT(*) AS total FROM clover_prereset_entitlements'
    );
    assert.equal(purchases.total, 1);
    assert.equal(entitlements.total, 1);
});
