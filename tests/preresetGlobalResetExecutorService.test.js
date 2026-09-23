'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    executePreresetGlobalReset,
} = require('../helpers/clover/preresetGlobalResetExecutorService');

async function setup() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            jogo_bloqueio_motivo TEXT,
            esquadrao TEXT,
            estrelas INTEGER DEFAULT 0,
            dinheiro INTEGER DEFAULT 0,
            reino TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT,
            reason TEXT
        );

        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT,
            PRIMARY KEY (player_id, roll_number)
        );

        CREATE TABLE clover_return_points_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            entry_kind TEXT NOT NULL,
            operation_key TEXT,
            reason TEXT
        );

        CREATE TABLE clover_prereset_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            catalog_item_key TEXT NOT NULL,
            entitlement_key TEXT NOT NULL,
            price_return_points INTEGER NOT NULL DEFAULT 0,
            return_points_ledger_id INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'completed',
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_prereset_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            entitlement_key TEXT NOT NULL,
            purchase_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            consumed_at TEXT DEFAULT NULL
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

    await db.run(
        `INSERT INTO clover_return_point_shop_gate
         (campaign_key, status, required_keep_count, roster_revision,
          roster_hash, keep_count_at_open, opened_by, opened_at)
         VALUES ('mythic_launch_v1', 'open', 1, 1, 'hash-001', 1, 'owner@lid', CURRENT_TIMESTAMP)`
    );

    for (const [playerId, outcome] of [
        ['keep@lid', 'keep'],
        ['reset-a@lid', 'reset'],
        ['reset-b@lid', 'reset'],
    ]) {
        await db.run(
            `INSERT INTO jogadores
             (id, nome, display_name, nome_real, personagem_nome, ficha_status,
              historia_status, personagem_aparencia_status, jogo_status, esquadrao,
              estrelas, dinheiro, reino, magia, grimorio, patente)
             VALUES (?, ?, ?, ?, ?, 'aprovada', 'aprovada', 'approved', 'liberado',
                     'Touros Negros', 4, 900, 'Clover', 'Fogo', 'Trevo 3 folhas', 'Cavaleiro')`,
            [playerId, playerId, playerId, playerId, `Char ${playerId}`]
        );
        await db.run(
            `INSERT INTO clover_return_point_shop_eligible
             (campaign_key, player_id, roster_revision, roster_hash, outcome)
             VALUES ('mythic_launch_v1', ?, 1, 'hash-001', ?)`,
            [playerId, outcome]
        );
        await db.run(
            `INSERT INTO clover_ph_ledger (player_id, amount, kind, source, reason)
             VALUES (?, 10, 'ganho', 'seed', 'PH antigo')`,
            [playerId]
        );
        await db.run(
            `INSERT INTO player_rolls (player_id, roll_number, kingdom)
             VALUES (?, 1, 'Clover')`,
            [playerId]
        );
        await db.run(
            `INSERT INTO clover_return_points_ledger
             (player_id, amount, entry_kind, operation_key, reason)
             VALUES (?, 100, 'bonus', 'seed-pr', 'PR retorno')`,
            [playerId]
        );
        const purchase = await db.run(
            `INSERT INTO clover_prereset_purchases
             (player_id, idempotency_key, catalog_item_key, entitlement_key,
              price_return_points, return_points_ledger_id, status, metadata_json)
             VALUES (?, ?, 'roll_slot_bonus', 'roll_slot_bonus:slot_1', 0, 0, 'completed', '{}')`,
            [playerId, `manual:${playerId}`]
        );
        await db.run(
            `INSERT INTO clover_prereset_entitlements
             (player_id, entitlement_key, purchase_id, status, metadata_json)
             VALUES (?, 'roll_slot_bonus:slot_1', ?, 'active', '{"fulfillment_status":"pending"}')`,
            [playerId, purchase.lastID]
        );
    }

    return db;
}

test('dry-run do reset global nao altera jogadores nem economias de retorno', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const result = await executePreresetGlobalReset(db, {
        campaignKey: 'mythic_launch_v1',
        apply: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.deepEqual(result.plan.counts, { keep: 1, reset: 2, total: 3 });
    assert.deepEqual(result.preservationBefore, result.preservationAfter);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM jogadores WHERE personagem_nome LIKE 'Char %'")).total, 3);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM player_rolls')).total, 3);
});

test('apply do reset global reseta somente RESET e preserva PR e entitlements', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const result = await executePreresetGlobalReset(db, {
        campaignKey: 'mythic_launch_v1',
        apply: true,
        actorId: 'owner@lid',
        reason: 'Reset global de teste',
        operationPrefix: 'RG-TEST',
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.resetResults.length, 2);
    assert.deepEqual(result.skippedKeepPlayerIds, ['keep@lid']);
    assert.deepEqual(result.preservationBefore, result.preservationAfter);

    const keep = await db.get('SELECT personagem_nome FROM jogadores WHERE id = ?', ['keep@lid']);
    const resetA = await db.get('SELECT personagem_nome, jogo_status FROM jogadores WHERE id = ?', ['reset-a@lid']);
    const resetB = await db.get('SELECT personagem_nome, jogo_status FROM jogadores WHERE id = ?', ['reset-b@lid']);
    assert.equal(keep.personagem_nome, 'Char keep@lid');
    assert.equal(resetA.personagem_nome, '-');
    assert.equal(resetB.personagem_nome, '-');
    assert.equal(resetA.jogo_status, 'bloqueado');
    assert.equal(resetB.jogo_status, 'bloqueado');

    assert.equal((await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id = ?', ['keep@lid'])).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id IN (?, ?)', ['reset-a@lid', 'reset-b@lid'])).total, 0);
    assert.equal((await db.get('SELECT SUM(amount) AS total FROM clover_return_points_ledger')).total, 300);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_prereset_entitlements WHERE status = ?', ['active'])).total, 3);
});

test('apply do reset global pula player resetado individualmente antes', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await db.run(
        `UPDATE jogadores
         SET personagem_nome = '-', ficha_status = 'incompleta', jogo_status = 'bloqueado'
         WHERE id = ?`,
        ['reset-a@lid']
    );
    await db.run('DELETE FROM player_rolls WHERE player_id = ?', ['reset-a@lid']);

    const result = await executePreresetGlobalReset(db, {
        campaignKey: 'mythic_launch_v1',
        apply: true,
        actorId: 'owner@lid',
        reason: 'Reset global de teste',
        operationPrefix: 'RG-TEST',
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.resetResults.length, 2);
    assert.deepEqual(
        result.resetResults.find((row) => row.playerId === 'reset-a@lid'),
        {
            playerId: 'reset-a@lid',
            operationCode: null,
            deletedRows: 0,
            skipped: true,
            reason: 'already_reset',
        }
    );
    assert.equal(result.resetResults.find((row) => row.playerId === 'reset-b@lid').deletedRows, 2);
    assert.deepEqual(result.preservationBefore, result.preservationAfter);
});
