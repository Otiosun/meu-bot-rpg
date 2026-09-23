'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    PreresetReturnShopAssignmentError,
    assignReturnShopEntitlementToRoll,
    listReturnShopEntitlements,
} = require('../helpers/clover/preresetReturnShopAssignmentService');

async function setup() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-'
        );
        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT DEFAULT '-',
            social_class TEXT DEFAULT '-',
            race TEXT DEFAULT '-',
            grimoire TEXT DEFAULT '-',
            magic_rarity TEXT DEFAULT '-',
            PRIMARY KEY (player_id, roll_number)
        );
        CREATE TABLE clover_prereset_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            catalog_item_key TEXT NOT NULL,
            entitlement_key TEXT NOT NULL,
            price_return_points INTEGER NOT NULL CHECK (price_return_points > 0),
            return_points_ledger_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_prereset_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            entitlement_key TEXT NOT NULL,
            purchase_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            consumed_at TEXT DEFAULT NULL
        );
        INSERT INTO jogadores (id, personagem_nome) VALUES ('player@lid', 'Player');
        INSERT INTO player_rolls (player_id, roll_number, kingdom, social_class, race, grimoire, magic_rarity)
        VALUES
            ('player@lid', 1, 'Clover', 'Plebeu', 'Humano', '3 Folhas', 'Comum'),
            ('player@lid', 2, 'Spade', 'Plebeu', 'Humano', '1 Espada', 'Rara');
    `);
    return db;
}

async function addPurchase(db, key, metadata, price = 100) {
    const purchase = await db.run(
        `INSERT INTO clover_prereset_purchases
         (player_id, idempotency_key, catalog_item_key, entitlement_key,
          price_return_points, return_points_ledger_id, status, metadata_json)
         VALUES ('player@lid', ?, 'return_shop_global_package', ?, ?, 1, 'completed', ?)`,
        [key, `return_shop_package:${key}`, price, JSON.stringify(metadata)]
    );
    await db.run(
        `INSERT INTO clover_prereset_entitlements
         (player_id, entitlement_key, purchase_id, status, metadata_json)
         VALUES ('player@lid', ?, ?, 'active', ?)`,
        [`return_shop_package:${key}`, purchase.lastID, JSON.stringify(metadata)]
    );
    return purchase.lastID;
}

test('lista compras da Return Shop separando destino de roll e proximo personagem', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await addPurchase(db, 'shop:roll', {
        fulfillment_status: 'pending_roll_assignment',
        requires_roll_assignment: true,
        target_roll_number: null,
        attempt: { request: 'Grimorio de 4 Folhas' },
        exclusive_categories: ['grimorio'],
    }, 500);
    await addPurchase(db, 'shop:item', {
        fulfillment_status: 'pending_character_fulfillment',
        requires_roll_assignment: false,
        attempt: { request: 'Caixa Real' },
        items: [{ label: 'Caixa Real', quantity: 1 }],
    }, 60);

    const entries = await listReturnShopEntitlements(db, 'player@lid');

    assert.equal(entries.length, 2);
    assert.equal(entries[0].label, 'Grimorio de 4 Folhas');
    assert.equal(entries[0].requiresRollAssignment, true);
    assert.deepEqual(entries[0].exclusiveCategories, ['grimorio']);
    assert.equal(entries[1].label, 'Caixa Real');
    assert.equal(entries[1].requiresRollAssignment, false);
});

test('atribui compra de build a um roll sem consumir entitlement', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await addPurchase(db, 'shop:roll', {
        fulfillment_status: 'pending_roll_assignment',
        requires_roll_assignment: true,
        target_roll_number: null,
        attempt: { request: 'Elfo' },
        exclusive_categories: ['raca'],
    }, 900);

    const result = await assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 2, {
        actorId: 'player@lid',
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.targetRollNumber, 2);

    const entitlement = await db.get('SELECT * FROM clover_prereset_entitlements WHERE id = 1');
    const metadata = JSON.parse(entitlement.metadata_json);
    assert.equal(entitlement.status, 'active');
    assert.equal(metadata.target_roll_number, 2);
    assert.equal(metadata.fulfillment_status, 'roll_assigned_pending_fulfillment');
    assert.equal(metadata.roll_assigned_by, 'player@lid');

    const purchase = await db.get('SELECT * FROM clover_prereset_purchases WHERE id = 1');
    const purchaseMetadata = JSON.parse(purchase.metadata_json);
    assert.equal(purchaseMetadata.target_roll_number, 2);
});

test('bloqueia categoria exclusiva duplicada no mesmo roll', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await addPurchase(db, 'shop:grimorio-a', {
        fulfillment_status: 'pending_roll_assignment',
        requires_roll_assignment: true,
        target_roll_number: null,
        attempt: { request: 'Grimorio de 4 Folhas' },
        exclusive_categories: ['grimorio'],
    }, 500);
    await addPurchase(db, 'shop:grimorio-b', {
        fulfillment_status: 'pending_roll_assignment',
        requires_roll_assignment: true,
        target_roll_number: null,
        attempt: { request: 'Grimorio de Diamante Lapidado' },
        exclusive_categories: ['grimorio'],
    }, 650);

    await assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 1);

    await assert.rejects(
        () => assignReturnShopEntitlementToRoll(db, 'player@lid', 2, 1),
        (error) => (
            error instanceof PreresetReturnShopAssignmentError
            && error.code === 'exclusive_category_conflict'
        )
    );
});

test('trocar permite mover compra ja atribuida para outro roll', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await addPurchase(db, 'shop:race', {
        fulfillment_status: 'pending_roll_assignment',
        requires_roll_assignment: true,
        target_roll_number: null,
        attempt: { request: 'Bruxa' },
        exclusive_categories: ['raca'],
    }, 300);

    await assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 1);
    await assert.rejects(
        () => assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 2),
        (error) => (
            error instanceof PreresetReturnShopAssignmentError
            && error.code === 'entitlement_already_assigned'
        )
    );

    const changed = await assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 2, {
        allowReassign: true,
    });

    assert.equal(changed.previousRollNumber, 1);
    assert.equal(changed.targetRollNumber, 2);
});

async function setupFuture(db) {
    await db.exec(`
        CREATE TABLE clover_prereset_future_rolls (
            campaign_key TEXT NOT NULL, player_id TEXT NOT NULL, roll_number INTEGER NOT NULL,
            kingdom TEXT, PRIMARY KEY(campaign_key, player_id, roll_number)
        );
        CREATE TABLE clover_prereset_characters (player_id TEXT PRIMARY KEY, status TEXT, draft_json TEXT);
        INSERT INTO clover_prereset_future_rolls VALUES ('mythic_launch_v1', 'player@lid', 2, 'Heart');
        INSERT INTO clover_prereset_future_rolls VALUES ('other_campaign', 'player@lid', 2, 'Diamond');
    `);
    await addPurchase(db, 'shop:future', {
        fulfillment_status: 'pending_roll_assignment', requires_roll_assignment: true,
        items: [{ key: 'realeza', exclusive_category: 'classe_social' }],
    });
}

test('escolhe o roll futuro da campanha, nunca o roll antigo do mesmo numero', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await setupFuture(db);
    const result = await assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 2);
    assert.equal(result.roll.kingdom, 'Heart');
    assert.equal(result.entitlement.metadata.target_campaign_key, 'mythic_launch_v1');
    assert.equal(result.entitlement.metadata.target_player_id, 'player@lid');
});

test('nao usa roll legado quando o numero nao existe no pre-reset', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await setupFuture(db);
    await assert.rejects(assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 1), { code: 'roll_not_found' });
    const entry = (await listReturnShopEntitlements(db, 'player@lid'))[0];
    assert.equal(entry.targetRollNumber, null);
});

test('ficha enviada impede atribuir compra e a falha libera a transacao', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await setupFuture(db);
    await db.run("INSERT INTO clover_prereset_characters VALUES ('player@lid', 'submitted', '{}')");
    await assert.rejects(assignReturnShopEntitlementToRoll(db, 'player@lid', 1, 2), { code: 'future_character_locked' });
    await db.exec('BEGIN IMMEDIATE; ROLLBACK');
    assert.equal((await listReturnShopEntitlements(db, 'player@lid'))[0].targetRollNumber, null);
});
