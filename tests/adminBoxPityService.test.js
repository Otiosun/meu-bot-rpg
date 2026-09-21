'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createAdminBoxPityExecutors,
    pitySnapshot,
} = require('../helpers/clover/adminBoxPityService');
const { ensureBoxPitySchema } = require('../helpers/clover/boxPityStateService');
const { getBoxCatalog } = require('../helpers/clover/seasonalEventCatalog');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_box_openings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            box_key TEXT NOT NULL,
            catalog_version INTEGER NOT NULL,
            reward_key TEXT DEFAULT NULL,
            result_json TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_seasonal_relic_ownership (
            relic_key TEXT PRIMARY KEY,
            player_id TEXT NOT NULL,
            inventory_item_id INTEGER DEFAULT NULL,
            box_opening_id INTEGER NOT NULL UNIQUE,
            claimed_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );
    `);
    await ensureBoxPitySchema(db);
    return db;
}

function context(db, payload, before, after) {
    return {
        db,
        action: { type: 'player.box.pity.correct', payload },
        target: { kind: 'player', playerId: 'player-1', characterName: 'Aster' },
        before,
        after,
    };
}

test('preview, apply and undo change only pity counters on stored state', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_box_pity_state (
            player_id, box_key, catalog_version, quality_miss_streak,
            relic_miss_streak, last_reward_key, last_opening_id, initialized_from
         ) VALUES ('player-1', 'simples', 3, 2, 4, 'kit_comum', 17, 'history_v1')`
    );
    const executor = createAdminBoxPityExecutors()['player.box.pity.correct'];
    const preview = await executor.preview(context(db, {
        boxKey: 'simples', qualityMissStreak: 8, relicMissStreak: 7,
    }));
    assert.equal(preview.before.qualityMissStreak, 2);
    assert.equal(preview.after.qualityMissStreak, 8);
    assert.equal(preview.after.quality.softActive, true);
    assert.equal(preview.after.lastRewardKey, 'kit_comum');
    assert.equal(preview.after.lastOpeningId, 17);

    const applied = await executor.apply(context(db, {
        boxKey: 'simples', qualityMissStreak: 8, relicMissStreak: 7,
    }, preview.before, preview.after));
    assert.equal(applied.after.qualityMissStreak, 8);
    assert.equal(applied.after.relicMissStreak, 7);
    assert.equal(applied.after.lastRewardKey, 'kit_comum');
    assert.equal(applied.after.lastOpeningId, 17);

    await executor.undo(context(db, {
        boxKey: 'simples', qualityMissStreak: 8, relicMissStreak: 7,
    }, preview.before, applied.after));
    const restored = await pitySnapshot(db, 'player-1', getBoxCatalog('simples'));
    assert.equal(restored.qualityMissStreak, 2);
    assert.equal(restored.relicMissStreak, 4);
    assert.equal(restored.lastRewardKey, 'kit_comum');
    assert.equal(restored.lastOpeningId, 17);
});

test('correction materializes reconstructed state and undo removes the materialized row', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_box_openings
         (player_id, box_key, catalog_version, reward_key, result_json, status)
         VALUES ('player-1', 'rara', 3, 'pocao_comum', '{"type":"item"}', 'completed')`
    );
    const executor = createAdminBoxPityExecutors()['player.box.pity.correct'];
    const preview = await executor.preview(context(db, {
        boxKey: 'rara', qualityMissStreak: 3, relicMissStreak: 9,
    }));
    assert.equal(preview.before.stored, false);
    assert.equal(preview.after.stored, true);

    const applied = await executor.apply(context(db, {
        boxKey: 'rara', qualityMissStreak: 3, relicMissStreak: 9,
    }, preview.before, preview.after));
    assert.equal(applied.after.stored, true);
    let row = await db.get("SELECT * FROM clover_box_pity_state WHERE player_id='player-1' AND box_key='rara' AND catalog_version=3");
    assert.ok(row);

    await executor.undo(context(db, {
        boxKey: 'rara', qualityMissStreak: 3, relicMissStreak: 9,
    }, preview.before, applied.after));
    row = await db.get("SELECT * FROM clover_box_pity_state WHERE player_id='player-1' AND box_key='rara' AND catalog_version=3");
    assert.equal(row, undefined);
});

test('quality correction cannot exceed hard-pity minus one', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executor = createAdminBoxPityExecutors()['player.box.pity.correct'];
    await assert.rejects(
        () => executor.preview(context(db, {
            boxKey: 'simples', qualityMissStreak: 12, relicMissStreak: 0,
        })),
        (error) => error?.code === 'invalid_pity_counter'
    );
    const valid = await executor.preview(context(db, {
        boxKey: 'simples', qualityMissStreak: 11, relicMissStreak: 0,
    }));
    assert.equal(valid.after.qualityMissStreak, 11);
    assert.equal(valid.after.quality.hardActive, true);
});

test('a new opening after preview blocks apply', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executor = createAdminBoxPityExecutors()['player.box.pity.correct'];
    const payload = { boxKey: 'simples', qualityMissStreak: 4, relicMissStreak: 6 };
    const preview = await executor.preview(context(db, payload));
    await db.run(
        `INSERT INTO clover_box_openings
         (player_id, box_key, catalog_version, reward_key, result_json, status)
         VALUES ('player-1', 'simples', 3, 'yulls_1000_3000', '{"type":"yulls","amount":1000}', 'completed')`
    );
    await assert.rejects(
        () => executor.apply(context(db, payload, preview.before, preview.after)),
        (error) => error?.code === 'box_pity_changed_after_preview'
    );
});

test('a later opening or pity mutation blocks undo', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_box_pity_state (
            player_id, box_key, catalog_version, quality_miss_streak,
            relic_miss_streak, initialized_from
         ) VALUES ('player-1', 'simples', 3, 1, 1, 'history_v1')`
    );
    const executor = createAdminBoxPityExecutors()['player.box.pity.correct'];
    const payload = { boxKey: 'simples', qualityMissStreak: 5, relicMissStreak: 8 };
    const preview = await executor.preview(context(db, payload));
    const applied = await executor.apply(context(db, payload, preview.before, preview.after));
    await db.run(
        `UPDATE clover_box_pity_state
         SET relic_miss_streak = relic_miss_streak + 1,
             last_reward_key = 'ph_5_10', last_opening_id = 99
         WHERE player_id='player-1' AND box_key='simples' AND catalog_version=3`
    );
    await assert.rejects(
        () => executor.undo(context(db, payload, preview.before, applied.after)),
        (error) => error?.code === 'box_pity_changed_after_apply'
    );
});
