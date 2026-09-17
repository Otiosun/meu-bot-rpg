'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('node:path');

const {
    addUncatalogedItemInTransaction,
    consumeInventoryItem,
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    updateInventoryItemInTransaction,
} = require('../helpers/clover/inventoryService');
const { findCriticalMutations } = require('../scripts/auditCanonicalDataAuthority');
const {
    ensureCloverAdminServiceSchema,
    ensureCloverQuickEvaluationsSchema,
} = require('../database');
const { purchasePaShopItem } = require('../helpers/clover/paShopService');
const { openSimplePaBox } = require('../helpers/clover/paItemUseService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE jogadores (id TEXT PRIMARY KEY, personagem_nome TEXT DEFAULT '-', dinheiro INTEGER DEFAULT 0);`);
    await db.run("INSERT INTO jogadores (id, personagem_nome) VALUES ('player@lid', 'Player')");
    await ensureInventoryV1(db);
    return db;
}

test('autoridade canônica concede item narrativo com histórico e retry idempotente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.exec('BEGIN IMMEDIATE');
    const first = await addUncatalogedItemInTransaction(db, 'player@lid', {
        itemName: 'Item narrativo', description: 'Descrição', quantity: 2, kind: 'narrativo', category: 'material',
    }, { source: 'test', relatedId: 'grant:1', idempotencyKey: 'inventory:test:grant:1' });
    await db.exec('COMMIT');

    await db.exec('BEGIN IMMEDIATE');
    const retry = await addUncatalogedItemInTransaction(db, 'player@lid', {
        itemName: 'Item narrativo', description: 'Descrição', quantity: 2, kind: 'narrativo', category: 'material',
    }, { source: 'test', relatedId: 'grant:1', idempotencyKey: 'inventory:test:grant:1' });
    await db.exec('COMMIT');

    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal((await db.get('SELECT COUNT(*) total FROM clover_inventory_items')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) total FROM clover_inventory_item_history')).total, 1);
});

test('autoridade canônica registra mudança e consumo e respeita rollback', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.exec('BEGIN IMMEDIATE');
    const granted = await addUncatalogedItemInTransaction(db, 'player@lid', {
        itemName: 'Ticket', quantity: 2, kind: 'ticket', category: 'consumivel',
    }, { source: 'test', relatedId: 'ticket:1', idempotencyKey: 'inventory:test:ticket:1' });
    const changed = await updateInventoryItemInTransaction(db, granted.items[0].id, {
        status: 'reservado',
    }, { action: 'reservado', source: 'test', relatedId: 'ticket:1:reserve' });
    await consumeInventoryItemInTransaction(db, changed, 1, {
        action: 'consumido', source: 'test', relatedId: 'ticket:1:consume', idempotencyKey: 'inventory:test:consume:1',
        allowedStatuses: ['reservado'],
    });
    await db.exec('COMMIT');
    assert.deepEqual(await db.get('SELECT quantity, status FROM clover_inventory_items WHERE id = ?', [granted.items[0].id]), { quantity: 1, status: 'reservado' });
    assert.equal((await db.get('SELECT COUNT(*) total FROM clover_inventory_item_history')).total, 3);

    await db.exec('BEGIN IMMEDIATE');
    await updateInventoryItemInTransaction(db, granted.items[0].id, { status: 'disponivel' }, {
        action: 'liberado', source: 'test', idempotencyKey: 'inventory:test:rollback',
    });
    await db.exec('ROLLBACK');
    assert.equal((await db.get('SELECT status FROM clover_inventory_items WHERE id = ?', [granted.items[0].id])).status, 'reservado');
    assert.equal((await db.get("SELECT COUNT(*) total FROM clover_inventory_item_history WHERE idempotency_key='inventory:test:rollback'")).total, 0);
});

test('consumo standalone é atômico e idempotente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.exec('BEGIN IMMEDIATE');
    const granted = await addUncatalogedItemInTransaction(db, 'player@lid', {
        itemName: 'Consumível', quantity: 2, kind: 'consumivel',
    }, { source: 'test', idempotencyKey: 'inventory:test:standalone-grant' });
    await db.exec('COMMIT');
    const options = { action: 'consumido', source: 'test', idempotencyKey: 'inventory:test:standalone-consume' };
    const first = await consumeInventoryItem(db, granted.items[0], 1, options);
    const retry = await consumeInventoryItem(db, granted.items[0], 1, options);
    assert.equal(first.duplicate, undefined);
    assert.equal(retry.duplicate, true);
    assert.equal((await db.get('SELECT quantity FROM clover_inventory_items WHERE id = ?', [granted.items[0].id])).quantity, 1);
});

test('writers runtime não alteram a tabela de inventário fora da autoridade canônica', () => {
    const writers = findCriticalMutations(path.join(__dirname, '..'))
        .filter(({ table }) => table === 'clover_inventory_items')
        .map(({ file }) => file);
    assert.deepEqual(writers, [
        'database/legacy.js',
        'helpers/clover/inventoryService.js',
        'helpers/clover/legacyEventRewardResolutionExecutor.js',
        'helpers/clover/legacyInventoryRepairExecutor.js',
        'helpers/clover/schemaBaseConsolidationAudit.js',
    ]);
});

test('loja PA concede caixa por autoridade canônica e retry não duplica', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverAdminServiceSchema(db);
    await db.run(
        `INSERT INTO clover_admin_service_entries
         (evaluator_id, target_player_id, modality_key, modality_label, weight,
          points, paid_points, status, service_week_key, scene_week_key, created_by)
         VALUES ('player@lid', 'player@lid', 'test', 'Test', 1, 8, 0, 'pending', '2026-09-14', '2026-09-14', 'admin@lid')`
    );
    const first = await purchasePaShopItem(db, 'player@lid', 'caixa_simples', {
        idempotencyKey: 'pa-shop:test:box', weekKey: '2026-09-14',
    });
    const retry = await purchasePaShopItem(db, 'player@lid', 'caixa_simples', {
        idempotencyKey: 'pa-shop:test:box', weekKey: '2026-09-14',
    });
    assert.equal(first.ok, true);
    assert.equal(retry.code, 'duplicate');
    assert.equal((await db.get("SELECT COUNT(*) total FROM clover_inventory_items WHERE kind='caixa_pa'")).total, 1);
    assert.equal((await db.get("SELECT COUNT(*) total FROM clover_inventory_item_history WHERE source='pa_shop'")).total, 1);

    const opened = await openSimplePaBox(db, 'player@lid', {
        idempotencyKey: 'pa-box:test:open', roll: 0,
    });
    const openRetry = await openSimplePaBox(db, 'player@lid', {
        idempotencyKey: 'pa-box:test:open', roll: 99,
    });
    assert.equal(opened.ok, true);
    assert.equal(openRetry.code, 'duplicate');
    assert.equal((await db.get("SELECT COUNT(*) total FROM clover_inventory_items WHERE kind='caixa_pa'")).total, 0);
    assert.equal((await db.get("SELECT COUNT(*) total FROM clover_inventory_item_history WHERE action='caixa_aberta'")).total, 1);
});
