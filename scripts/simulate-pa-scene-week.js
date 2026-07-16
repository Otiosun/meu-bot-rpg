'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverAdminServiceSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverQuickEvaluationsSchema,
} = require('../database');
const { purchasePaShopItem } = require('../helpers/clover/paShopService');
const {
    auditPaSceneWeeks,
    getPaOriginSummary,
    payPaBySceneWeek,
    purchasePhBySceneWeek,
} = require('../helpers/clover/paSceneWeekService');
const {
    renderAudit,
    renderOriginStatus,
    renderPhPurchase,
    renderSceneWeekShop,
} = require('../helpers/clover/paCommandSceneWeekFinal');

const PLAYER = '5511999999999@s.whatsapp.net';
const ADMIN_PLAYER = '5511888888888@s.whatsapp.net';
const WEEK_A = '2026-07-06';
const WEEK_B = '2026-07-13';
const WEEK_C = '2026-06-22';
const WEEK_D = '2026-06-29';
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'pa-scene-week');

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
        `INSERT INTO jogadores (id, nome, display_name, personagem_nome, dinheiro, esquadrao, estrelas)
         VALUES (?, 'Avaliador', 'Avaliador', 'Cena Antiga', 0, 'Touros Negros', 0)`,
        [PLAYER]
    );
    await db.run(
        `INSERT INTO jogadores (id, nome, display_name, personagem_nome, dinheiro, esquadrao, estrelas)
         VALUES (?, 'Admin', 'Admin', 'Pagamento Antigo', 0, 'Águias Prateadas', 0)`,
        [ADMIN_PLAYER]
    );
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    return db;
}

async function insertQuickUsage(db, playerId, weekKey, ph, suffix) {
    await db.run(
        `INSERT INTO clover_quick_evaluations
         (message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
          ph_amount, week_key, bypass_weekly_limit, rewards_json, metadata_json)
         VALUES (?, 'grupo@g.us', ?, 'avaliador', 'outro', 'Outro', ?, ?, 0, '{}', '{}')`,
        [`quick:${suffix}`, playerId, ph, weekKey]
    );
}

async function insertPaEntry(db, evaluatorId, points, sceneWeekKey, serviceWeekKey, suffix, paidPoints = 0) {
    const status = paidPoints >= points ? 'paid' : paidPoints > 0 ? 'partial' : 'pending';
    const result = await db.run(
        `INSERT INTO clover_admin_service_entries
         (evaluator_id, target_player_id, modality_key, modality_label, weight, points,
          paid_points, status, source, service_week_key, scene_week_key, scene_sent_at,
          evaluated_at, created_by, reason, metadata_json)
         VALUES (?, ?, 'outro', 'Outro', 1, ?, ?, ?, 'quick_evaluation', ?, ?, ?, ?, 'test', ?, '{}')`,
        [
            evaluatorId,
            evaluatorId,
            points,
            paidPoints,
            status,
            serviceWeekKey,
            sceneWeekKey,
            `${sceneWeekKey} 12:00:00`,
            `${serviceWeekKey} 12:00:00`,
            `Teste ${suffix}`,
        ]
    );
    return result.lastID;
}

function writeArtifacts(data) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'origens.txt'), `${data.originText}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'loja.txt'), `${data.shopText}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'compra.txt'), `${data.purchaseText}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'auditoria.txt'), `${data.auditText}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(data.report, null, 2)}\n`, 'utf8');
}

async function main() {
    const db = await createDb();
    try {
        await insertQuickUsage(db, PLAYER, WEEK_A, 28, 'a');
        await insertQuickUsage(db, PLAYER, WEEK_B, 10, 'b');
        const entryA = await insertPaEntry(db, PLAYER, 10, WEEK_A, WEEK_B, 'a');
        const entryB = await insertPaEntry(db, PLAYER, 6, WEEK_B, WEEK_B, 'b');

        let summary = await getPaOriginSummary(db, PLAYER, PLAYER);
        assert.strictEqual(summary.pendingPa, 16);
        assert.strictEqual(summary.purchasablePh, 8);
        assert.strictEqual(summary.buckets.find((bucket) => bucket.weekKey === WEEK_A).purchasablePh, 2);
        assert.strictEqual(summary.buckets.find((bucket) => bucket.weekKey === WEEK_B).purchasablePh, 6);

        const purchase = await purchasePhBySceneWeek(db, PLAYER, {
            quantity: 8,
            createdBy: 'test',
            idempotencyKey: 'scene-week:purchase',
            purchaseWeekKey: WEEK_B,
        });
        assert.strictEqual(purchase.ok, true);
        assert.deepStrictEqual(
            purchase.originAllocations.map((item) => [item.weekKey, item.amount]),
            [[WEEK_A, 2], [WEEK_B, 6]]
        );

        const rowA = await db.get('SELECT * FROM clover_admin_service_entries WHERE id = ?', [entryA]);
        const rowB = await db.get('SELECT * FROM clover_admin_service_entries WHERE id = ?', [entryB]);
        assert.strictEqual(Number(rowA.paid_points), 2);
        assert.strictEqual(rowA.status, 'partial');
        assert.strictEqual(Number(rowB.paid_points), 6);
        assert.strictEqual(rowB.status, 'paid');

        const payouts = await db.all(
            `SELECT * FROM clover_admin_service_payouts
             WHERE evaluator_id = ? AND source = 'pa_shop_ph'
             ORDER BY week_key`,
            [PLAYER]
        );
        assert.deepStrictEqual(
            payouts.map((row) => [row.week_key, Number(row.ph_paid)]),
            [[WEEK_A, 2], [WEEK_B, 6]]
        );

        summary = await getPaOriginSummary(db, PLAYER, PLAYER);
        assert.strictEqual(summary.pendingPa, 8);
        assert.strictEqual(summary.purchasablePh, 0);
        assert.strictEqual(summary.blockedPa, 8);

        const balanceBeforeFailure = summary.pendingPa;
        const blockedPurchase = await purchasePhBySceneWeek(db, PLAYER, {
            quantity: 1,
            createdBy: 'test',
            idempotencyKey: 'scene-week:blocked',
        });
        assert.strictEqual(blockedPurchase.code, 'weekly_ph_limit');
        assert.strictEqual(blockedPurchase.available, 0);
        assert.strictEqual((await getPaOriginSummary(db, PLAYER, PLAYER)).pendingPa, balanceBeforeFailure);

        const yulls = await purchasePaShopItem(db, PLAYER, '2', {
            quantity: 1,
            weekKey: WEEK_B,
            idempotencyKey: 'scene-week:yulls',
        });
        assert.strictEqual(yulls.ok, true);
        assert.strictEqual(Number((await db.get('SELECT dinheiro FROM jogadores WHERE id = ?', [PLAYER])).dinheiro), 500);
        assert.strictEqual((await getPaOriginSummary(db, PLAYER, PLAYER)).pendingPa, 3);

        await insertQuickUsage(db, ADMIN_PLAYER, WEEK_C, 29, 'c');
        await insertQuickUsage(db, ADMIN_PLAYER, WEEK_D, 5, 'd');
        await insertPaEntry(db, ADMIN_PLAYER, 4, WEEK_C, WEEK_D, 'c');
        await insertPaEntry(db, ADMIN_PLAYER, 4, WEEK_D, WEEK_D, 'd');

        const adminPayout = await payPaBySceneWeek(db, ADMIN_PLAYER, {
            createdBy: 'owner',
            points: 5,
        });
        assert.strictEqual(adminPayout.ok, true);
        assert.deepStrictEqual(
            adminPayout.allocations.map((item) => [item.weekKey, item.amount]),
            [[WEEK_C, 1], [WEEK_D, 4]]
        );

        const historicalEntry = await insertPaEntry(db, ADMIN_PLAYER, 3, WEEK_A, WEEK_B, 'historico', 3);
        await db.run(
            `INSERT INTO clover_admin_service_payouts
             (evaluator_id, player_id, points_paid, ph_paid, week_key, source, reason,
              created_by, ledger_id, metadata_json)
             VALUES (?, ?, 3, 3, ?, 'pa_shop_ph', 'Registro antigo', 'test', NULL, ?)`,
            [
                ADMIN_PLAYER,
                ADMIN_PLAYER,
                WEEK_B,
                JSON.stringify({ consumed_entries: [{ entryId: historicalEntry, points: 3 }] }),
            ]
        );

        const audit = await auditPaSceneWeeks(db, { evaluatorId: ADMIN_PLAYER });
        assert.strictEqual(audit.mismatchCount, 1);
        assert.strictEqual(audit.wrongPh, 3);
        assert.strictEqual(audit.mismatches[0].recordedWeekKey, WEEK_B);
        assert.deepStrictEqual(audit.mismatches[0].expected, [{ weekKey: WEEK_A, amount: 3 }]);
        assert.strictEqual(audit.applyAutomatically, false);

        const originText = await renderOriginStatus(db, PLAYER);
        const shopText = await renderSceneWeekShop(db, PLAYER);
        const purchaseText = renderPhPurchase(purchase);
        const auditText = renderAudit(audit);
        for (const output of [originText, shopText, purchaseText, auditText]) {
            assert.strictEqual(typeof output, 'string');
            assert(!output.includes('undefined'));
            assert(!output.includes('[object Object]'));
            assert(output.length < 4096, `Saída longa demais: ${output.length}`);
        }
        assert(originText.includes(WEEK_A));
        assert(shopText.includes('semana da cena'));
        assert(purchaseText.includes(`${WEEK_A}:`));
        assert(auditText.includes('Nada foi corrigido automaticamente'));

        writeArtifacts({
            originText,
            shopText,
            purchaseText,
            auditText,
            report: {
                purchaseAllocations: purchase.originAllocations,
                blockedPurchase: {
                    code: blockedPurchase.code,
                    available: blockedPurchase.available,
                },
                remainingPaAfterYulls: (await getPaOriginSummary(db, PLAYER, PLAYER)).pendingPa,
                adminAllocations: adminPayout.allocations,
                audit,
            },
        });

        console.log('✓ PH dividido pela semana da cena');
        console.log('✓ semana lotada preserva o PA');
        console.log('✓ PA bloqueado para PH compra outros itens');
        console.log('✓ pagamento administrativo respeita múltiplas origens');
        console.log('✓ auditoria detecta histórico divergente sem alterar dados');
        console.log('✓ saídas do WhatsApp abaixo de 4096 caracteres');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});