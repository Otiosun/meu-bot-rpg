'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureInventoryV1 } = require('../helpers/clover/inventoryService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    AdminInventoryInstanceError,
    getAdminInventoryInstance,
    normalizeUpdatePayload,
} = require('../helpers/clover/adminInventoryInstanceService');
const {
    normalizeAdminOperationInput,
    requiredCapabilitiesForActions,
} = require('../helpers/clover/adminOperationContract');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            dinheiro INTEGER DEFAULT 0,
            estrelas INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT NULL
        );
        INSERT INTO jogadores (id, personagem_nome, nome) VALUES ('player@test', 'Teste', 'Teste');
    `);
    await ensureInventoryV1(db);
    return db;
}

async function insertItem(db, overrides = {}) {
    const row = {
        playerId: 'player@test',
        itemName: 'Espada de Teste',
        description: 'Item de teste',
        quantity: 1,
        kind: 'equipamento',
        source: 'test',
        relatedId: null,
        createdBy: 'test',
        templateKey: null,
        catalogVersion: 1,
        category: 'equipamento',
        origin: 'Clover',
        status: 'disponivel',
        quality: 'comum',
        basePrice: 100,
        referencePrice: 100,
        durabilityCurrent: 5,
        durabilityMax: 5,
        bound: 0,
        transferable: 1,
        equippedSlot: null,
        expiresAt: null,
        propertiesJson: JSON.stringify({ conditionDescriptions: { integro: 'Íntegro', desgastado: 'Desgastado', danificado: 'Danificado', quebrado: 'Quebrado' } }),
        effectsJson: '{}',
        metadataJson: '{}',
        ...overrides,
    };
    const result = await db.run(
        `INSERT INTO clover_inventory_items (
            player_id, item_name, description, quantity, kind, source, related_id, created_by,
            metadata_json, template_key, catalog_version, category, origin, status, quality,
            base_price, reference_price, durability_current, durability_max, bound, transferable,
            equipped_slot, expires_at, properties_json, effects_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
            row.playerId, row.itemName, row.description, row.quantity, row.kind, row.source, row.relatedId,
            row.createdBy, row.metadataJson, row.templateKey, row.catalogVersion, row.category, row.origin,
            row.status, row.quality, row.basePrice, row.referencePrice, row.durabilityCurrent,
            row.durabilityMax, row.bound, row.transferable, row.equippedSlot, row.expiresAt,
            row.propertiesJson, row.effectsJson,
        ]
    );
    return Number(result.lastID);
}

const operation = {
    code: 'OP-A1B2C3',
    reason: 'Correção de teste',
    actor: { id: 'admin@test', role: 'owner' },
};
const target = { playerId: 'player@test', characterName: 'Teste' };

function unit(id) {
    return { id, target_player_id: target.playerId, metadata: { target } };
}

test('operation contract accepts inventory instance update and reservation release with player.manage', () => {
    for (const type of ['player.item.update', 'player.item.release_reservation']) {
        const normalized = normalizeAdminOperationInput({
            title: type,
            reason: 'Teste',
            targets: [{ kind: 'player', playerId: target.playerId }],
            actions: [{ type, payload: { itemId: 1 } }],
            idempotencyKey: `test:${type}`,
        }, { actorId: 'admin@test', actorRole: 'owner' });
        assert.equal(normalized.actions[0].type, type);
        assert.deepEqual(requiredCapabilitiesForActions(normalized.actions), ['player.manage']);
    }
});

test('normalizeUpdatePayload keeps inventory invariants', () => {
    const before = {
        quantity: 3,
        reservedQuantity: 1,
        availableQuantity: 2,
        durabilityCurrent: 3,
        durabilityMax: 5,
        status: 'disponivel',
        bound: false,
        transferable: true,
        expiresAt: null,
    };
    const next = normalizeUpdatePayload({ quantity: 2, durabilityCurrent: 0, bound: true }, before);
    assert.equal(next.quantity, 2);
    assert.equal(next.availableQuantity, 1);
    assert.equal(next.durabilityCurrent, 0);
    assert.equal(next.status, 'quebrado');
    assert.equal(next.bound, true);
    assert.equal(next.transferable, false);
    assert.throws(
        () => normalizeUpdatePayload({ quantity: 0 }, before),
        (error) => error instanceof AdminInventoryInstanceError && error.code === 'invalid_inventory_quantity'
    );
    assert.throws(
        () => normalizeUpdatePayload({ quantity: 0 }, { ...before, reservedQuantity: 0 }),
        (error) => error instanceof AdminInventoryInstanceError && error.code === 'invalid_inventory_quantity'
    );
});

test('inventory instance update applies and registry undo ignores audit-only historyId', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const itemId = await insertItem(db, { quantity: 2, durabilityCurrent: 4 });
    const executor = getAdminOperationExecutors()['player.item.update'];
    assert.equal(executor.atomicSafe, false);

    const preview = await executor.preview({
        db,
        operation,
        action: { type: 'player.item.update', payload: { itemId, quantity: 3, durabilityCurrent: 2 } },
        target,
        unit: unit('U1'),
    });
    assert.equal(preview.before.quantity, 2);
    assert.equal(preview.after.quantity, 3);
    assert.equal(preview.after.durabilityCurrent, 2);

    const applied = await executor.apply({
        db,
        operation,
        action: { type: 'player.item.update', payload: { itemId, quantity: 3, durabilityCurrent: 2 } },
        target,
        unit: unit('U1'),
        before: preview.before,
        after: preview.after,
    });
    assert.ok(applied.after.historyId > 0);
    assert.equal((await getAdminInventoryInstance(db, target.playerId, itemId)).item.quantity, 3);

    await executor.undo({
        db,
        operation,
        target,
        unit: { ...unit('U1'), after: applied.after },
        before: preview.before,
        after: applied.after,
    });
    const restored = await getAdminInventoryInstance(db, target.playerId, itemId);
    assert.equal(restored.item.quantity, 2);
    assert.equal(restored.item.durabilityCurrent, 4);
});

test('active reservation blocks update/remove until explicit release, and release undo is safe', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const itemId = await insertItem(db, { quantity: 2 });
    const inserted = await db.run(
        `INSERT INTO clover_inventory_reservations
         (reservation_key, inventory_item_id, player_id, quantity, source_type, source_id, status, created_by, created_at, updated_at)
         VALUES ('RES-TEST', ?, ?, 1, 'raid', 'R-TEST', 'active', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [itemId, target.playerId]
    );
    const reservationId = Number(inserted.lastID);
    const registry = getAdminOperationExecutors();

    for (const type of ['player.item.update', 'player.item.remove']) {
        await assert.rejects(
            () => registry[type].preview({
                db,
                operation,
                action: { type, payload: { itemId, quantity: 1 } },
                target,
                unit: unit('LOCK'),
            }),
            (error) => error instanceof AdminInventoryInstanceError && error.code === 'inventory_instance_locked'
        );
    }

    const release = registry['player.item.release_reservation'];
    const preview = await release.preview({
        db,
        operation,
        action: { type: 'player.item.release_reservation', payload: { reservationId } },
        target,
        unit: unit('REL'),
    });
    const applied = await release.apply({ db, operation, before: preview.before, after: preview.after, target, unit: unit('REL') });
    assert.equal(applied.after.status, 'released');

    const unlocked = await getAdminInventoryInstance(db, target.playerId, itemId);
    assert.equal(unlocked.locks.length, 0);

    await release.undo({ db, operation, before: preview.before, after: applied.after, target, unit: unit('REL') });
    const row = await db.get('SELECT status FROM clover_inventory_reservations WHERE id = ?', [reservationId]);
    assert.equal(row.status, 'active');
});

test('remove deletes an unlocked instance and undo restores the exact snapshot', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const itemId = await insertItem(db, { quantity: 1, bound: 1, transferable: 0 });
    const executor = getAdminOperationExecutors()['player.item.remove'];

    const preview = await executor.preview({
        db,
        operation,
        action: { type: 'player.item.remove', payload: { itemId } },
        target,
        unit: unit('RM'),
    });
    const applied = await executor.apply({
        db,
        operation,
        action: { type: 'player.item.remove', payload: { itemId } },
        target,
        unit: unit('RM'),
        before: preview.before,
        after: preview.after,
    });
    assert.equal(await db.get('SELECT id FROM clover_inventory_items WHERE id = ?', [itemId]), undefined);

    await executor.undo({ db, operation, target, unit: { ...unit('RM'), after: applied.after }, after: applied.after });
    const restored = await getAdminInventoryInstance(db, target.playerId, itemId);
    assert.equal(restored.item.itemName, 'Espada de Teste');
    assert.equal(restored.item.bound, true);
    assert.equal(restored.item.transferable, false);
});
