'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    getAdminBoxDashboard,
    getAdminPlayerBoxState,
    openingIntegrity,
} = require('../helpers/clover/adminBoxService');
const { ensureInventoryV1 } = require('../helpers/clover/inventoryService');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            display_name TEXT,
            yulls INTEGER DEFAULT 0
        );
    `);
    await ensureInventoryV1(db);
    return db;
}

test('admin box dashboard exposes canonical catalogs without technical player identifiers', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = '551199999999@s.whatsapp.net';
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, nome, display_name)
         VALUES (?, 'Aster', 'Conta Aster', 'Aster')`,
        [playerId]
    );
    await db.run(
        `INSERT INTO clover_box_openings
         (player_id, inventory_item_id, box_key, catalog_version, roll, roll_basis_points,
          reward_key, result_json, status, idempotency_key, created_at, completed_at, metadata_json)
         VALUES (?, NULL, 'simples', 3, 42, 4200, 'yulls_1000_3000', ?, 'completed', 'box:test:1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}')`,
        [playerId, JSON.stringify({ type: 'yulls', amount: 1500, label: '1.500¥' })]
    );

    const dashboard = await getAdminBoxDashboard(db, { limit: 20 });
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.readOnlyCatalog, false);
    assert.equal(dashboard.catalogVersioningAvailable, true);
    assert.equal(dashboard.catalogs.length, 2);
    assert.ok(dashboard.versions.length >= 2);
    const simpleVersion = dashboard.versions.find((entry) => entry.boxKey === 'simples' && entry.status === 'active');
    assert.ok(simpleVersion);
    assert.ok(simpleVersion.catalog.templateKey);
    assert.ok(simpleVersion.catalog.rewards.some((reward) => (
        Array.isArray(reward.pool)
        || Number.isFinite(Number(reward.min))
        || Boolean(reward.templateKey)
    )));
    for (const catalog of dashboard.catalogs) {
        assert.equal(catalog.totalChance, 100);
        assert.equal(catalog.source.editable, false);
        assert.ok(catalog.policy);
    }
    assert.equal(dashboard.openings[0].characterName, 'Aster');
    assert.equal(dashboard.openings[0].code, 'CX-000001');
    const serialized = JSON.stringify(dashboard);
    assert.equal(serialized.includes(playerId), false);
});

test('failed and pending openings are review cases, never implicit rerolls', async () => {
    const failed = openingIntegrity({
        box_key: 'simples',
        catalog_version: 3,
        status: 'failed',
        reward_key: null,
        result_json: null,
        metadata_json: '{}',
    });
    assert.equal(failed.ok, false);
    assert.ok(failed.issues.some((issue) => issue.code === 'failed_opening'));
    assert.equal(failed.issues.some((issue) => /rerrol/i.test(issue.message)), false);

    const pending = openingIntegrity({
        box_key: 'rara',
        catalog_version: 3,
        status: 'pending',
        reward_key: 'ph_10_15',
        result_json: null,
        metadata_json: '{}',
    });
    assert.equal(pending.ok, false);
    assert.ok(pending.issues.some((issue) => issue.code === 'pending_opening'));
    assert.ok(pending.issues.some((issue) => /não rerrole/i.test(issue.message)));
});

test('player box state reuses canonical pity and history', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = 'player-internal-id';
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, nome, display_name)
         VALUES (?, 'Lyra', 'Conta Lyra', 'Lyra')`,
        [playerId]
    );
    const state = await getAdminPlayerBoxState(db, playerId, { limit: 10 });
    assert.equal(state.ok, true);
    assert.equal(state.characterName, 'Lyra');
    assert.ok(state.pity.simples);
    assert.ok(state.pity.rara);
    assert.equal(JSON.stringify(state).includes(playerId), false);
});
