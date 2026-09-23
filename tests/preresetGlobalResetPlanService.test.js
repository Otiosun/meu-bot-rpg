'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    buildPreresetGlobalResetPlan,
} = require('../helpers/clover/preresetGlobalResetPlanService');

async function setup() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado'
        );

        CREATE TABLE clover_return_point_shop_gate (
            campaign_key TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            required_keep_count INTEGER NOT NULL,
            roster_revision INTEGER NOT NULL,
            roster_hash TEXT NOT NULL,
            keep_count_at_open INTEGER DEFAULT NULL,
            opened_by TEXT DEFAULT NULL,
            opened_at TEXT DEFAULT NULL,
            closed_by TEXT DEFAULT NULL,
            closed_at TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_return_point_shop_eligible (
            campaign_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            roster_revision INTEGER NOT NULL,
            roster_hash TEXT NOT NULL,
            outcome TEXT NOT NULL,
            captured_by TEXT DEFAULT NULL,
            captured_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (campaign_key, player_id)
        );
    `);
    for (const [id, name] of [
        ['keep@lid', 'Keep Player'],
        ['reset-a@lid', 'Reset A'],
        ['reset-b@lid', 'Reset B'],
    ]) {
        await db.run(
            'INSERT INTO jogadores (id, personagem_nome) VALUES (?, ?)',
            [id, name]
        );
    }
    return db;
}

async function seedGate(db, status = 'open') {
    await db.run(
        `INSERT INTO clover_return_point_shop_gate
         (campaign_key, status, required_keep_count, roster_revision,
          roster_hash, keep_count_at_open, opened_by, opened_at)
         VALUES ('mythic_launch_v1', ?, 1, 1, 'hash-001', 1, 'owner@lid', CURRENT_TIMESTAMP)`,
        [status]
    );
    for (const [playerId, outcome] of [
        ['keep@lid', 'keep'],
        ['reset-a@lid', 'reset'],
        ['reset-b@lid', 'reset'],
    ]) {
        await db.run(
            `INSERT INTO clover_return_point_shop_eligible
             (campaign_key, player_id, roster_revision, roster_hash, outcome)
             VALUES ('mythic_launch_v1', ?, 1, 'hash-001', ?)`,
            [playerId, outcome]
        );
    }
}

test('bloqueia plano de reset global quando a Return Shop nao esta aberta', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await seedGate(db, 'closed');

    await assert.rejects(
        () => buildPreresetGlobalResetPlan(db, { campaignKey: 'mythic_launch_v1' }),
        (error) => error.code === 'return_shop_gate_not_open'
    );
});

test('plano de reset global usa roster finalizado e preserva PR e entitlements', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await seedGate(db, 'open');

    const plan = await buildPreresetGlobalResetPlan(db, {
        campaignKey: 'mythic_launch_v1',
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.campaignKey, 'mythic_launch_v1');
    assert.deepEqual(plan.counts, { keep: 1, reset: 2, total: 3 });
    assert.deepEqual(plan.keepPlayerIds, ['keep@lid']);
    assert.deepEqual(plan.resetPlayerIds, ['reset-a@lid', 'reset-b@lid']);
    assert.equal(plan.preservation.returnPointsLedger, true);
    assert.equal(plan.preservation.returnShopEntitlements, true);
    assert.equal(plan.preservation.returnShopGateAndEligibility, true);
});
