'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createReturnPointShopGateObjects,
} = require('../helpers/clover/returnPointShopGateMigration');
const {
    REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT,
    assertReturnPointShopOpen,
    closeReturnPointShop,
    getReturnPointShopGateState,
    getReturnPointShopRosterReadiness,
    openReturnPointShop,
} = require('../helpers/clover/returnPointShopGateService');
const { purchaseReturnPointShopItem } = require('../helpers/clover/returnPointShopService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_prereset_launch_rosters (
            campaign_key TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            status TEXT NOT NULL,
            roster_hash TEXT,
            finalized_at TEXT
        );
        CREATE TABLE clover_prereset_launch_keep_roster (
            campaign_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            roster_revision INTEGER NOT NULL,
            PRIMARY KEY (campaign_key, player_id)
        );
        CREATE TABLE clover_prereset_launch_players (
            campaign_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            roster_revision INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (campaign_key, player_id)
        );
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            ficha_status TEXT DEFAULT 'incompleta'
        );
        CREATE TABLE clover_prereset_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            catalog_item_key TEXT NOT NULL,
            entitlement_key TEXT NOT NULL,
            price_return_points INTEGER NOT NULL,
            return_points_ledger_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
    `);
    await createReturnPointShopGateObjects(db);
    return db;
}

async function seedRoster(db, keepCount) {
    await db.run(
        `INSERT INTO clover_prereset_launch_rosters
         (campaign_key,revision,status,roster_hash,finalized_at)
         VALUES ('mythic_launch_v1',7,'finalized','hash-r7',CURRENT_TIMESTAMP)`
    );
    for (let index = 1; index <= keepCount; index += 1) {
        const id = `KEEP-${String(index).padStart(2, '0')}`;
        await db.run(
            `INSERT INTO clover_prereset_launch_keep_roster
             (campaign_key,player_id,roster_revision) VALUES ('mythic_launch_v1',?,7)`,
            [id]
        );
        await db.run(
            `INSERT INTO clover_prereset_launch_players
             (campaign_key,player_id,roster_revision,outcome,status)
             VALUES ('mythic_launch_v1',?,7,'keep','pending')`,
            [id]
        );
    }
}

test('Loja de Retorno permanece fechada com 13 KEEP e abre somente em 14 exatos', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedRoster(db, 13);

    const before = await getReturnPointShopRosterReadiness(db);
    assert.equal(before.ok, false);
    assert.equal(before.keepCount, 13);
    assert.equal(before.requiredKeepCount, REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT);
    await assert.rejects(
        () => openReturnPointShop(db, 'owner@test'),
        (error) => error?.code === 'return_shop_keep_count_mismatch'
    );
    assert.equal((await getReturnPointShopGateState(db)).open, false);

    await db.run(
        `INSERT INTO clover_prereset_launch_keep_roster
         (campaign_key,player_id,roster_revision) VALUES ('mythic_launch_v1','KEEP-14',7)`
    );
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status)
         VALUES ('mythic_launch_v1','KEEP-14',7,'keep','pending')`
    );

    const ready = await getReturnPointShopRosterReadiness(db);
    assert.equal(ready.ok, true);
    assert.equal(ready.keepCount, 14);
    const opened = await openReturnPointShop(db, 'owner@test');
    assert.equal(opened.gate.open, true);
    assert.equal(opened.gate.keepCountAtOpen, 14);
    assert.equal(opened.gate.rosterRevision, 7);
    assert.equal(opened.gate.rosterHash, 'hash-r7');
    await assert.doesNotReject(() => assertReturnPointShopOpen(db));

    const events = await db.all('SELECT event_type,keep_count FROM clover_return_point_shop_gate_events ORDER BY id');
    assert.deepEqual(events, [{ event_type:'open', keep_count:14 }]);
});

test('fechamento bloqueia a loja imediatamente e preserva auditoria', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedRoster(db, 14);
    await openReturnPointShop(db, 'owner@test');
    await closeReturnPointShop(db, 'owner@test');

    const state = await getReturnPointShopGateState(db);
    assert.equal(state.open, false);
    assert.equal(state.keepCountAtOpen, 14);
    await assert.rejects(
        () => assertReturnPointShopOpen(db),
        (error) => error?.code === 'return_shop_closed'
    );
    const events = await db.all('SELECT event_type FROM clover_return_point_shop_gate_events ORDER BY id');
    assert.deepEqual(events.map((row) => row.event_type), ['open', 'close']);
});

test('servico de compra nao debita nem processa compra nova enquanto gate esta fechado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedRoster(db, 14);
    await db.run("INSERT INTO jogadores (id,ficha_status) VALUES ('RESET-01','aprovada')");
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status)
         VALUES ('mythic_launch_v1','RESET-01',7,'reset','pending')`
    );

    await assert.rejects(
        () => purchaseReturnPointShopItem(db, 'RESET-01', {
            itemKey: 'ph_1',
            quantity: 1,
            idempotencyKey: 'closed-shop-test-0001',
        }),
        (error) => error?.code === 'return_shop_closed'
    );
    const purchases = await db.get('SELECT COUNT(*) AS total FROM clover_prereset_purchases');
    assert.equal(Number(purchases.total), 0);
});
