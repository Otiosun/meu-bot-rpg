'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const {
    applyLaunch,
    finalizeRoster,
    replaceKeepRoster,
} = require('../helpers/clover/preResetLaunchService');
const { openReturnPointShop } = require('../helpers/clover/returnPointShopGateService');
const {
    creditReturnPoints,
    debitReturnPoints,
    getReturnPointsBalance,
} = require('../helpers/clover/returnPointsService');

function policyRegistry() {
    return createPreResetPolicyRegistry({
        testOnly: true,
        policies: {
            PRE_RESET_MODE: { status: 'ENABLED', policyVersion: 'fulfillment-mode-v1' },
            SESSION_ELIGIBILITY: {
                status: 'ENABLED',
                policyVersion: 'fulfillment-session-v1',
                eligibleReleasedSessions: true,
            },
        },
    });
}

function adminContext() {
    return {
        actorId: 'admin-return-shop-fulfillment',
        env: {
            PRE_RESET_LAUNCH_ENABLED: 'true',
            PRE_RESET_RETURN_ENABLED: 'true',
            PRE_RESET: 'ON',
        },
        policyRegistry: policyRegistry(),
        capabilities: ['prereset.review', 'player.manage', 'operation.apply'],
    };
}

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-return-shop-fulfillment-'));
    const db = await database.criarBanco({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function seedResetPlayer(db, playerId) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, ficha_status, jogo_status, personagem_nome, personagem_aparencia,
          personagem_aparencia_status, dinheiro)
         VALUES (?, ?, 'aprovada', 'liberado', ?, ?, 'approved', ?)`,
        [playerId, `Player ${playerId}`, 'Legacy Yulls', 'Aparencia Legacy Yulls', 777]
    );
}

async function seedKeepPlayers(db, count = 14) {
    const ids = [];
    for (let index = 1; index <= count; index += 1) {
        const playerId = `return-shop-keep-${String(index).padStart(2, '0')}`;
        await seedResetPlayer(db, playerId);
        ids.push(playerId);
    }
    return ids;
}

async function seedCompletedYullsPurchase(db, playerId) {
    const credit = await creditReturnPoints(db, playerId, 10, {
        operationKey: 'return-shop-fulfillment:credit:0001',
        source: 'fixture',
        reason: 'Credito fixture para compra de 5.000 Yulls.',
        createdBy: 'system',
    });
    assert.equal(credit.balanceAfter, 10);

    const debit = await debitReturnPoints(db, playerId, 10, {
        operationKey: 'return-shop-fulfillment:debit:0001',
        source: 'return_point_shop',
        reason: 'Compra fixture de 5.000 Yulls.',
        createdBy: playerId,
    });
    assert.equal(debit.balanceAfter, 0);

    const metadata = JSON.stringify({
        catalogVersion: 'return-shop-v1',
        itemKey: 'yulls_5000',
        name: '5.000 Yulls',
        effectKind: 'future_yulls',
        effectValue: 5000,
        quantity: 1,
        targetRollNumber: null,
    });
    const entitlementKey = 'future_yulls:5000:r0:n1';
    const purchase = await db.run(
        `INSERT INTO clover_prereset_purchases
         (player_id, idempotency_key, catalog_item_key, entitlement_key,
          price_return_points, return_points_ledger_id, status, metadata_json)
         VALUES (?, ?, 'yulls_5000', ?, 10, ?, 'completed', ?)`,
        [playerId, 'return-shop-fulfillment:purchase:0001', entitlementKey, debit.ledgerId, metadata]
    );
    await db.run(
        `INSERT INTO clover_prereset_entitlements
         (player_id, entitlement_key, purchase_id, status, metadata_json)
         VALUES (?, ?, ?, 'active', ?)`,
        [playerId, entitlementKey, purchase.lastID, metadata]
    );
    return { purchaseId: Number(purchase.lastID), entitlementKey };
}

test('Return Shop: future_yulls e materializado uma vez depois do reset no launch', async (t) => {
    const db = await fixture(t);
    const playerId = 'return-shop-yulls-player';
    await seedResetPlayer(db, playerId);
    const keepPlayerIds = await seedKeepPlayers(db);

    const ctx = adminContext();
    await replaceKeepRoster(db, ctx, {
        operationKey: 'return-shop-fulfillment:roster:replace:0001',
        expectedRevision: 0,
        keepPlayerIds,
    });
    await finalizeRoster(db, ctx, {
        operationKey: 'return-shop-fulfillment:roster:finalize:0001',
        expectedRevision: 1,
    });

    const opened = await openReturnPointShop(db, ctx.actorId);
    assert.equal(opened.gate.open, true);
    assert.equal(opened.eligibilitySnapshot.keep, 14);
    assert.equal(opened.eligibilitySnapshot.reset, 1);

    const seeded = await seedCompletedYullsPurchase(db, playerId);
    assert.equal(await getReturnPointsBalance(db, playerId), 0);
    assert.equal((await db.get('SELECT dinheiro FROM jogadores WHERE id = ?', [playerId])).dinheiro, 777);

    const applied = await applyLaunch(db, ctx, {
        operationKey: 'return-shop-fulfillment:launch:0001',
    });
    assert.equal(applied.completed, true);

    const playerAfter = await db.get(
        'SELECT personagem_nome, ficha_status, jogo_status, dinheiro FROM jogadores WHERE id = ?',
        [playerId]
    );
    assert.deepEqual(playerAfter, {
        personagem_nome: '-',
        ficha_status: 'incompleta',
        jogo_status: 'bloqueado',
        dinheiro: 5000,
    });

    const entitlement = await db.get(
        `SELECT status, consumed_at FROM clover_prereset_entitlements
         WHERE player_id = ? AND entitlement_key = ?`,
        [playerId, seeded.entitlementKey]
    );
    assert.equal(entitlement.status, 'consumed');
    assert.ok(entitlement.consumed_at);

    const fulfillmentEntries = await db.all(
        `SELECT amount, kind, source, idempotency_key
         FROM clover_yulls_ledger
         WHERE player_id = ? AND source = 'return_point_shop_fulfillment'
         ORDER BY id`,
        [playerId]
    );
    assert.deepEqual(fulfillmentEntries, [{
        amount: 5000,
        kind: 'ganho',
        source: 'return_point_shop_fulfillment',
        idempotency_key: `return-shop:fulfillment:yulls:${seeded.purchaseId}`,
    }]);

    const replay = await applyLaunch(db, ctx, {
        operationKey: 'return-shop-fulfillment:launch:0001',
    });
    assert.equal(replay.duplicate, true);
    assert.equal((await db.get('SELECT dinheiro FROM jogadores WHERE id = ?', [playerId])).dinheiro, 5000);
    assert.equal((await db.get(
        `SELECT COUNT(*) AS total FROM clover_yulls_ledger
         WHERE player_id = ? AND source = 'return_point_shop_fulfillment'`,
        [playerId]
    )).total, 1);
});
