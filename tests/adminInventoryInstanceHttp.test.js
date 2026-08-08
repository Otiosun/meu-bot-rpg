'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureInventoryV1 } = require('../helpers/clover/inventoryService');
const {
    handleAdminInventoryInstanceHttp,
    parseAdminInventoryPath,
} = require('../helpers/clover/adminInventoryInstanceHttp');

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += String(value || ''); },
    };
}

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
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
    const inserted = await db.run(
        `INSERT INTO clover_inventory_items (
            player_id, item_name, description, quantity, kind, source, created_by,
            metadata_json, catalog_version, category, origin, status, quality,
            base_price, reference_price, durability_current, durability_max, bound,
            transferable, properties_json, effects_json, created_at, updated_at
         ) VALUES ('player@test', 'Item HTTP', 'Teste', 1, 'equipamento', 'test', 'test',
                   '{}', 1, 'equipamento', 'Clover', 'disponivel', 'comum',
                   100, 100, 5, 5, 0, 1, '{}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    return { db, itemId: Number(inserted.lastID) };
}

function context(db, capabilities) {
    return {
        db,
        access: { actor: { id: 'admin@test', role: 'owner', capabilities } },
    };
}

test('inventory admin path parser accepts list and numeric item detail only', () => {
    assert.deepEqual(parseAdminInventoryPath('/admin/players/player%40test/inventory'), {
        playerId: 'player@test', itemId: null, list: true,
    });
    assert.deepEqual(parseAdminInventoryPath('/admin/players/player%40test/inventory/42'), {
        playerId: 'player@test', itemId: 42, list: false,
    });
    assert.equal(parseAdminInventoryPath('/admin/players/player%40test/inventory/not-number'), null);
});

test('GET inventory list/detail requires player.view and returns canonical snapshots', async (t) => {
    const { db, itemId } = await makeDb();
    t.after(() => db.close());

    const listReq = { method: 'GET', url: '/admin/players/player%40test/inventory?limit=20', headers: {} };
    const listRes = responseRecorder();
    await handleAdminInventoryInstanceHttp(
        listReq,
        listRes,
        { resolveAdminContext: async () => context(db, ['player.view']) },
        parseAdminInventoryPath('/admin/players/player%40test/inventory')
    );
    assert.equal(listRes.statusCode, 200);
    const listPayload = JSON.parse(listRes.body);
    assert.equal(listPayload.ok, true);
    assert.equal(listPayload.items.length, 1);
    assert.equal(listPayload.items[0].itemName, 'Item HTTP');

    const detailReq = { method: 'GET', url: `/admin/players/player%40test/inventory/${itemId}?historyLimit=10`, headers: {} };
    const detailRes = responseRecorder();
    await handleAdminInventoryInstanceHttp(
        detailReq,
        detailRes,
        { resolveAdminContext: async () => context(db, ['player.view']) },
        parseAdminInventoryPath(`/admin/players/player%40test/inventory/${itemId}`)
    );
    assert.equal(detailRes.statusCode, 200);
    const detailPayload = JSON.parse(detailRes.body);
    assert.equal(detailPayload.item.id, itemId);
    assert.deepEqual(detailPayload.locks, []);
    assert.deepEqual(detailPayload.reservations, []);
    assert.ok(Array.isArray(detailPayload.history));
});

test('inventory read API fails closed without player.view and never accepts POST mutations', async (t) => {
    const { db, itemId } = await makeDb();
    t.after(() => db.close());
    const parsed = parseAdminInventoryPath(`/admin/players/player%40test/inventory/${itemId}`);

    const forbidden = responseRecorder();
    await handleAdminInventoryInstanceHttp(
        { method: 'GET', url: `/admin/players/player%40test/inventory/${itemId}`, headers: {} },
        forbidden,
        { resolveAdminContext: async () => context(db, []) },
        parsed
    );
    assert.equal(forbidden.statusCode, 403);
    assert.equal(JSON.parse(forbidden.body).error, 'missing_capability');

    const post = responseRecorder();
    await handleAdminInventoryInstanceHttp(
        { method: 'POST', url: `/admin/players/player%40test/inventory/${itemId}`, headers: {} },
        post,
        { resolveAdminContext: async () => context(db, ['player.view', 'player.manage']) },
        parsed
    );
    assert.equal(post.statusCode, 405);
    assert.equal(JSON.parse(post.body).error, 'method_not_allowed');
});
