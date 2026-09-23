'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const runtime = process.env.CLOVER_RUNTIME_ROOT;
const run = runtime ? test : test.skip;

async function fixture(t) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE jogadores (id TEXT,raca TEXT,grimorio TEXT,familia TEXT,familia_key TEXT,magia TEXT,magia_key TEXT,anomalia TEXT,anomalia_key TEXT);
        CREATE TABLE clover_prereset_launch_players (campaign_key TEXT,player_id TEXT,outcome TEXT);
        CREATE TABLE clover_prereset_purchases (id INTEGER PRIMARY KEY,status TEXT);
        CREATE TABLE clover_prereset_entitlements (id INTEGER PRIMARY KEY,purchase_id INTEGER,status TEXT,metadata_json TEXT);
        CREATE TABLE clover_prereset_future_slot_reservations (
            campaign_key TEXT,player_id TEXT,roll_number INTEGER,category TEXT,option_key TEXT,status TEXT,source TEXT,
            released_at TEXT, consumed_at TEXT, PRIMARY KEY(campaign_key,player_id,roll_number,category)
        );
        INSERT INTO clover_prereset_future_slot_reservations (campaign_key,player_id,roll_number,category,option_key,status)
            VALUES ('mythic_launch_v1','a',1,'grimoire','diamond_4f','held'),('mythic_launch_v1','b',1,'grimoire','diamond_4f','held');
        INSERT INTO clover_prereset_purchases VALUES (1,'completed');
    `);
    await db.run('INSERT INTO clover_prereset_entitlements VALUES (1,1,?,?)', ['active', JSON.stringify({
        reset_cycle_key: 'mythic_launch_v1', items: [{ key: 'polishedDiamond', quantity: 1 }],
    })]);
    return db;
}

run('runtime: sorteio novo nao toma a ultima vaga de um comprador que ainda nao escolheu roll', async t => {
    const db = await fixture(t);
    const service = require(path.join(runtime, 'helpers/clover/preResetFutureSlotService'));
    const availability = await service.getFutureSlotAvailability(db, 'grimoire', 'diamond_4f');
    assert.equal(availability.usedCount, 3);
    assert.equal(availability.shopCommitted, 1);
    assert.equal(availability.ok, false);
    const result = await service.holdFutureSlot(db, { playerId: 'intruder', rollNumber: 1, category: 'grimoire', optionKey: 'diamond_4f' });
    assert.equal(result.ok, false);
    assert.equal((await db.get('SELECT COUNT(*) n FROM clover_prereset_future_slot_reservations')).n, 2);
});

run('runtime: entrega troca compromisso da compra por reserva do roll sem contar a mesma vaga duas vezes', async t => {
    const db = await fixture(t);
    const service = require(path.join(runtime, 'helpers/clover/preResetFutureSlotService'));
    await db.exec('BEGIN IMMEDIATE');
    const result = await service.holdFutureSlot(db, { playerId: 'buyer', rollNumber: 2, category: 'grimoire', optionKey: 'diamond_4f', excludeEntitlementId: 1 });
    assert.equal(result.ok, true);
    await db.run("UPDATE clover_prereset_entitlements SET status='consumed' WHERE id=1");
    const availability = await service.getFutureSlotAvailability(db, 'grimoire', 'diamond_4f');
    assert.equal(availability.usedCount, 3);
    assert.equal(availability.shopCommitted, 0);
    await db.exec('ROLLBACK');
    assert.equal((await db.get("SELECT status FROM clover_prereset_entitlements WHERE id=1")).status, 'active');
});
