'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const {
    createAndStoreFutureRoll,
    createAndStoreFutureSacrificeRoll,
    listFutureRolls,
} = require('../helpers/clover/preResetFutureRollService');
const { tryExecutePreResetSacrifice } = require('../helpers/clover/preResetSacrificeCommand');
const { purchaseReturnPointShopItem } = require('../helpers/clover/returnPointShopService');
const { creditReturnPoints } = require('../helpers/clover/returnPointsService');

const CAMPAIGN_KEY = 'mythic_launch_v1';
const PLAYER_ID = 'paid-sacrifice-lock-player';

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-paid-sacrifice-lock-'));
    const db = await database.criarBanco({ filename:path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive:true, force:true });
    });

    await db.run(
        `INSERT INTO jogadores
         (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
         VALUES (?,?,'aprovada','liberado','Personagem Antigo','Aparencia Antiga','approved')`,
        [PLAYER_ID, PLAYER_ID]
    );
    await db.run(
        `INSERT INTO clover_prereset_launch_rosters
         (campaign_key,authority_mode,revision,status,roster_hash,finalized_by,finalized_at)
         VALUES (?,'admin_roster',1,'finalized','paid-lock-fixture','admin',CURRENT_TIMESTAMP)`,
        [CAMPAIGN_KEY]
    );
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status)
         VALUES (?,?,1,'reset','pending')`,
        [CAMPAIGN_KEY, PLAYER_ID]
    );
    await db.run(
        `INSERT INTO clover_return_point_shop_gate
         (campaign_key,status,required_keep_count,roster_revision,roster_hash,keep_count_at_open,opened_by,opened_at)
         VALUES (?,'open',14,1,'paid-lock-fixture',14,'test',CURRENT_TIMESTAMP)`,
        [CAMPAIGN_KEY]
    );
    await db.run(
        `INSERT INTO clover_return_point_shop_eligible
         (campaign_key,player_id,roster_revision,roster_hash,outcome,captured_by)
         VALUES (?,?,1,'paid-lock-fixture','reset','test')`,
        [CAMPAIGN_KEY, PLAYER_ID]
    );
    return db;
}

function enablePreReset(t) {
    const launch = process.env.PRE_RESET_LAUNCH_ENABLED;
    const ret = process.env.PRE_RESET_RETURN_ENABLED;
    process.env.PRE_RESET_LAUNCH_ENABLED = 'true';
    process.env.PRE_RESET_RETURN_ENABLED = 'true';
    t.after(() => {
        if (launch === undefined) delete process.env.PRE_RESET_LAUNCH_ENABLED;
        else process.env.PRE_RESET_LAUNCH_ENABLED = launch;
        if (ret === undefined) delete process.env.PRE_RESET_RETURN_ENABLED;
        else process.env.PRE_RESET_RETURN_ENABLED = ret;
    });
}

async function seedFiveRollsAndPaidPurchase(db, suffix = '0001') {
    for (let i = 0; i < 5; i += 1) {
        assert.equal((await createAndStoreFutureRoll(db, PLAYER_ID)).ok, true);
    }
    const before = await listFutureRolls(db, PLAYER_ID);
    assert.deepEqual(before.map((row) => Number(row.roll_number)), [1,2,3,4,5]);

    const credit = await creditReturnPoints(db, PLAYER_ID, 100, {
        operationKey:`paid-sacrifice-lock:credit:${suffix}`,
        source:'fixture',
        reason:'Credito descartavel para teste.',
        createdBy:'test',
    });
    assert.equal(credit.balanceAfter, 100);

    const purchase = await purchaseReturnPointShopItem(db, PLAYER_ID, {
        itemKey:'reino_clover',
        targetRollNumber:1,
        idempotencyKey:`paid-sacrifice-lock:purchase:${suffix}`,
    });
    assert.equal(purchase.ok, true);
    assert.equal(purchase.balanceAfter, 0);

    const paid = await db.get(
        `SELECT id,status,entitlement_key,metadata_json FROM clover_prereset_purchases WHERE idempotency_key=?`,
        [`paid-sacrifice-lock:purchase:${suffix}`]
    );
    assert.equal(paid.status, 'completed');
    assert.equal(Number(JSON.parse(paid.metadata_json).targetRollNumber), 1);
    const entitlement = await db.get(
        'SELECT id,status,purchase_id,consumed_at FROM clover_prereset_entitlements WHERE purchase_id=?',
        [paid.id]
    );
    assert.equal(entitlement.status, 'active');
    return { before, paid, entitlement };
}

async function assertPaidStatePreserved(db, seeded) {
    const after = await listFutureRolls(db, PLAYER_ID);
    assert.deepEqual(after.map((row) => Number(row.roll_number)), [1,2,3,4,5]);
    assert.equal(after.some((row) => Number(row.roll_number) === 6), false);
    assert.equal((await db.get('SELECT status FROM clover_prereset_purchases WHERE id=?', [seeded.paid.id])).status, 'completed');
    const entitlementAfter = await db.get(
        'SELECT status,consumed_at FROM clover_prereset_entitlements WHERE id=?',
        [seeded.entitlement.id]
    );
    assert.equal(entitlementAfter.status, 'active');
    assert.equal(entitlementAfter.consumed_at, null);
}

test('PRE_RESET: comando bloqueia sacrificio apos compra paga vinculada ao roll', async (t) => {
    enablePreReset(t);
    const db = await fixture(t);
    const seeded = await seedFiveRollsAndPaidPurchase(db, '0001');

    const sent = [];
    const handled = await tryExecutePreResetSacrifice({
        sock:{ sendMessage:async (_jid, message) => { sent.push(message); return { key:{ id:'out' } }; } },
        m:{ key:{ id:'in', remoteJid:'grupo@g.us' } },
        idChat:'grupo@g.us',
        idJogador:PLAYER_ID,
        db,
        body:'confirmar',
    });
    assert.equal(handled, true);
    await assertPaidStatePreserved(db, seeded);
    assert.ok(sent.some((message) => {
        const text = String(message?.text || '');
        return text.includes('compra de Pontos de Retorno') && text.includes('sacrifício foi bloqueado');
    }));
});

test('PRE_RESET: motor transacional tambem recusa sacrificio com compra paga vinculada', async (t) => {
    enablePreReset(t);
    const db = await fixture(t);
    const seeded = await seedFiveRollsAndPaidPurchase(db, '0002');

    const result = await createAndStoreFutureSacrificeRoll(db, PLAYER_ID);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'paid_roll_purchase');
    await assertPaidStatePreserved(db, seeded);
});
