'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
} = require('../database/legacy');
const {
    addPh,
    addPhInTransaction,
    ensurePhState,
    getPhSummary,
    spendPhInTransaction,
} = require('../helpers/clover/phService');
const { runWithLifecycleContext } = require('../helpers/clover/lifecyclePolicy');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec("CREATE TABLE jogadores (id TEXT PRIMARY KEY, dinheiro INTEGER DEFAULT 0)");
    await db.run("INSERT INTO jogadores (id) VALUES ('player@lid')");
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensurePhState(db, 'player@lid');
    return db;
}

async function grantInTransaction(db, amount, relatedId) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await addPhInTransaction(
            db,
            'player@lid',
            amount,
            'authority_test',
            'grant idempotente',
            'system',
            { fixture: true },
            relatedId,
        );
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

test('PH transaction retry replays one canonical ledger entry and balance', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await grantInTransaction(db, 9, 'reward:fixture:1');
    const retry = await grantInTransaction(db, 9, 'reward:fixture:1');
    const summary = await getPhSummary(db, 'player@lid');
    const matching = await db.get(
        `SELECT COUNT(*) AS total FROM clover_ph_ledger
         WHERE player_id = ? AND source = ? AND related_id = ?`,
        ['player@lid', 'authority_test', 'reward:fixture:1'],
    );

    assert.equal(first.replayed, false);
    assert.equal(retry.replayed, true);
    assert.equal(retry.ledgerId, first.ledgerId);
    assert.equal(Number(matching.total), 1);
    assert.equal(summary.phAccumulated, 24);
    assert.equal(summary.phAvailable, 24);
});

test('PH transaction retry fails closed when the stable key changes meaning', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await grantInTransaction(db, 9, 'reward:fixture:conflict');
    await assert.rejects(
        grantInTransaction(db, 10, 'reward:fixture:conflict'),
        { code: 'ph_idempotency_conflict' },
    );
});

test('transaction-scoped PH grant rejects a deferred reset player', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE clover_prereset_launch_rosters (
            campaign_key TEXT PRIMARY KEY,
            status TEXT NOT NULL
        );
        CREATE TABLE clover_prereset_launch_players (
            campaign_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            outcome TEXT NOT NULL,
            status TEXT NOT NULL,
            last_error_code TEXT,
            PRIMARY KEY (campaign_key, player_id)
        );
    `);
    await db.run(
        "INSERT INTO clover_prereset_launch_rosters (campaign_key, status) VALUES ('mythic_launch_v1', 'completed')",
    );
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key, player_id, outcome, status, last_error_code)
         VALUES ('mythic_launch_v1', 'player@lid', 'reset', 'pending', 'reset_deferred')`,
    );

    await assert.rejects(
        grantInTransaction(db, 5, 'reward:fixture:deferred'),
        { code: 'future_character_pending' },
    );
    assert.equal(
        Number((await db.get("SELECT COUNT(*) AS total FROM clover_ph_ledger WHERE source = 'authority_test'")).total),
        0,
    );
});

test('canonical PH grant blocks current-world rewards during PRE_RESET even with initialized state', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assert.rejects(
        runWithLifecycleContext(
            { env: { PRE_RESET: 'ON' } },
            () => addPh(db, 'player@lid', 5, 'gameplay_reward', 'fixture', 'system'),
        ),
        { code: 'lifecycle_current_world_blocked' },
    );
    assert.equal((await getPhSummary(db, 'player@lid')).phAvailable, 15);
});

test('transaction-scoped PH debit blocks current-world spending during PRE_RESET', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.exec('BEGIN IMMEDIATE');
    try {
        await assert.rejects(
            runWithLifecycleContext(
                { env: { PRE_RESET: 'ON' } },
                () => spendPhInTransaction(db, 'player@lid', 5, 'skill_tree', 'fixture', 'player@lid', {}, 'spend:1'),
            ),
            { code: 'lifecycle_current_world_blocked' },
        );
        await db.exec('ROLLBACK');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
    assert.equal((await getPhSummary(db, 'player@lid')).phAvailable, 15);
});
