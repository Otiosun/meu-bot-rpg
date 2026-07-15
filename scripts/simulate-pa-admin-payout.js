'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverAdminServiceSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverQuickEvaluationsSchema,
} = require('../database');
const {
    addManualServicePoints,
    formatWeekKey,
} = require('../helpers/clover/adminService');
const { payPaAsPhSafely } = require('../helpers/clover/paAdminPayoutService');
const { getPaShopState, purchasePaShopItem } = require('../helpers/clover/paShopService');

const PLAYER_ID = '5511666666666@s.whatsapp.net';
const HISTORICAL_WEEK = '2026-06-01';

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0
        )
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, dinheiro, esquadrao, estrelas)
         VALUES (?, 'ADM', 'ADM', 'ADM Teste', 0, 'Leões Carmesins', 0)`,
        [PLAYER_ID]
    );
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    return db;
}

async function availablePa(db) {
    return (await getPaShopState(db, PLAYER_ID)).availablePa;
}

async function main() {
    const db = await createDb();
    const currentWeek = formatWeekKey(new Date());

    try {
        await addManualServicePoints(db, PLAYER_ID, {
            points: 30,
            createdBy: 'test',
            reason: 'Saldo atual',
        });

        const shopSpend = await purchasePaShopItem(db, PLAYER_ID, '2', {
            quantity: 5,
            idempotencyKey: 'admin-payout:shop-spend',
            weekKey: currentWeek,
        });
        assert.strictEqual(shopSpend.ok, true);
        assert.strictEqual(shopSpend.paCost, 25);
        assert.strictEqual(await availablePa(db), 5);

        const clampedToBalance = await payPaAsPhSafely(db, PLAYER_ID, {
            createdBy: 'owner',
            points: 10,
        });
        assert.strictEqual(clampedToBalance.ok, true);
        assert.strictEqual(clampedToBalance.pointsPaid, 5);
        assert.strictEqual(clampedToBalance.phPaid, 5);
        assert.strictEqual(await availablePa(db), 0);

        await db.run(
            `INSERT INTO clover_admin_service_entries
             (evaluator_id, modality_key, modality_label, weight, points, paid_points,
              status, source, service_week_key, created_by, reason, metadata_json)
             VALUES (?, 'historico', 'PA histórico', 1, 10, 0,
                     'pending', 'test', ?, 'test', 'Teste de origem antiga', '{}')`,
            [PLAYER_ID, HISTORICAL_WEEK]
        );

        const historical = await payPaAsPhSafely(db, PLAYER_ID, {
            createdBy: 'owner',
            weekKey: HISTORICAL_WEEK,
            points: 10,
        });
        assert.strictEqual(historical.ok, true);
        assert.strictEqual(historical.pointsPaid, 10);
        assert.strictEqual(historical.serviceWeekKey, HISTORICAL_WEEK);
        assert.strictEqual(historical.payoutWeekKey, currentWeek);

        const historicalPayout = await db.get(
            `SELECT * FROM clover_admin_service_payouts
             WHERE evaluator_id = ?
               AND source = 'servico_adm_safe'
               AND points_paid = 10
             ORDER BY id DESC
             LIMIT 1`,
            [PLAYER_ID]
        );
        assert.strictEqual(historicalPayout.week_key, currentWeek);
        const historicalMetadata = JSON.parse(historicalPayout.metadata_json);
        assert.strictEqual(historicalMetadata.service_week_key, HISTORICAL_WEEK);
        assert.strictEqual(historicalMetadata.payout_week_key, currentWeek);

        await addManualServicePoints(db, PLAYER_ID, {
            points: 30,
            createdBy: 'test',
            reason: 'Completar teto atual',
        });
        const fillCap = await payPaAsPhSafely(db, PLAYER_ID, {
            createdBy: 'owner',
            points: 30,
        });
        assert.strictEqual(fillCap.ok, true);
        assert.strictEqual(fillCap.pointsPaid, 15);
        assert.strictEqual(fillCap.usedThisWeek, 15);

        const beforeBlocked = await availablePa(db);
        const blocked = await payPaAsPhSafely(db, PLAYER_ID, {
            createdBy: 'owner',
            points: 1,
        });
        assert.strictEqual(blocked.ok, false);
        assert.strictEqual(blocked.code, 'weekly_cap');
        assert.strictEqual(await availablePa(db), beforeBlocked);

        const payoutTotals = await db.get(
            `SELECT COALESCE(SUM(points_paid), 0) AS pa,
                    COALESCE(SUM(ph_paid), 0) AS ph
             FROM clover_admin_service_payouts
             WHERE evaluator_id = ?
               AND week_key = ?`,
            [PLAYER_ID, currentWeek]
        );
        assert.strictEqual(Number(payoutTotals.pa), 30);
        assert.strictEqual(Number(payoutTotals.ph), 30);

        const phLedger = await db.get(
            `SELECT COALESCE(SUM(amount), 0) AS total
             FROM clover_ph_ledger
             WHERE player_id = ?
               AND source = 'servico_adm'`,
            [PLAYER_ID]
        );
        assert.strictEqual(Number(phLedger.total), 30);

        console.log('✓ pagamento usa apenas PA disponível dentro da transação');
        console.log('✓ gasto concorrente da loja não permite PH excedente');
        console.log('✓ PA histórico mantém origem, mas PH usa a semana atual');
        console.log('✓ teto atual de 30 PH bloqueia nova conversão sem consumir PA');
        console.log('\nResultado: pagamento administrativo seguro passou.');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});