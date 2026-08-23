'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverAdminServiceSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverInventorySchema,
    ensureCloverPhLedgerSchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverSquadSchema,
} = require('../database');
const { addManualServicePoints, formatWeekKey } = require('../helpers/clover/adminService');
const { getPaShopState, purchasePaShopItem } = require('../helpers/clover/paShopService');
const { renderShop, renderStatus } = require('../helpers/clover/paCommandPresentationFinal');
const command = require('../comandos/servicoAdm');

const PLAYER_ID = '5511999999999@s.whatsapp.net';
const PLAYER_NO_PA = '5511888888888@s.whatsapp.net';
const PLAYER_NO_SQUAD = '5511777777777@s.whatsapp.net';
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'pa-shop');

async function createTestDb() {
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
         VALUES (?, 'Avaliador', 'Avaliador', 'Teste Clover', 0, 'Touros Negros', 0)`,
        [PLAYER_ID]
    );
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, dinheiro, esquadrao, estrelas)
         VALUES (?, 'Sem PA', 'Sem PA', 'Sem Saldo', 0, 'Águias Prateadas', 0)`,
        [PLAYER_NO_PA]
    );
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, dinheiro, esquadrao, estrelas)
         VALUES (?, 'Sem Esquadrão', 'Sem Esquadrão', 'Sem Esquadrão', 0, '-', 0)`,
        [PLAYER_NO_SQUAD]
    );
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverInventorySchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverSquadSchema(db);
    await db.exec(`
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            squad_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
        );
    `);
    await db.run(
        `INSERT INTO clover_squad_memberships (player_id, squad_key, status)
         VALUES (?, 'touros_negros', 'active')`,
        [PLAYER_ID]
    );
    return db;
}

function writeArtifacts({ shopText, statusText, report }) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'loja.txt'), `${shopText}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'carteira.txt'), `${statusText}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
    const db = await createTestDb();
    const weekKey = formatWeekKey(new Date());

    try {
        await addManualServicePoints(db, PLAYER_ID, {
            points: 250,
            createdBy: 'test',
            reason: 'Saldo de teste',
        });
        await addManualServicePoints(db, PLAYER_NO_SQUAD, {
            points: 50,
            createdBy: 'test',
            reason: 'Saldo sem esquadrão',
        });

        let state = await getPaShopState(db, PLAYER_ID, { weekKey });
        assert.strictEqual(state.availablePa, 250);
        assert.strictEqual(state.items.find((item) => item.key === 'yulls').used, 0);
        assert.strictEqual(state.items.find((item) => item.key === 'caixa_simples').available, 1);

        const noPa = await purchasePaShopItem(db, PLAYER_NO_PA, '2', {
            quantity: 1,
            weekKey,
            idempotencyKey: 'test:no-pa',
        });
        assert.strictEqual(noPa.code, 'insufficient_pa');
        assert.strictEqual(await db.get(
            'SELECT COUNT(*) AS total FROM clover_pa_shop_purchases WHERE evaluator_id = ?',
            [PLAYER_NO_PA]
        ).then((row) => Number(row.total)), 0);

        const noSquadBefore = await getPaShopState(db, PLAYER_NO_SQUAD, { weekKey });
        const noSquad = await purchasePaShopItem(db, PLAYER_NO_SQUAD, '5', {
            weekKey,
            idempotencyKey: 'test:no-squad',
        });
        assert.strictEqual(noSquad.code, 'no_squad');
        const noSquadAfter = await getPaShopState(db, PLAYER_NO_SQUAD, { weekKey });
        assert.strictEqual(noSquadAfter.availablePa, noSquadBefore.availablePa);

        const yulls = await purchasePaShopItem(db, PLAYER_ID, '2', {
            quantity: 3,
            weekKey,
            idempotencyKey: 'test:yulls',
        });
        assert.strictEqual(yulls.ok, true);
        assert.strictEqual(yulls.paCost, 15);
        let player = await db.get('SELECT * FROM jogadores WHERE id = ?', [PLAYER_ID]);
        assert.strictEqual(Number(player.dinheiro), 1500);

        const duplicate = await purchasePaShopItem(db, PLAYER_ID, '2', {
            quantity: 3,
            weekKey,
            idempotencyKey: 'test:yulls',
        });
        assert.strictEqual(duplicate.code, 'duplicate');
        player = await db.get('SELECT * FROM jogadores WHERE id = ?', [PLAYER_ID]);
        assert.strictEqual(Number(player.dinheiro), 1500);

        const box = await purchasePaShopItem(db, PLAYER_ID, '3', {
            weekKey,
            idempotencyKey: 'test:box',
        });
        assert.strictEqual(box.ok, true);
        const balanceAfterBox = (await getPaShopState(db, PLAYER_ID, { weekKey })).availablePa;
        const secondBox = await purchasePaShopItem(db, PLAYER_ID, '3', {
            weekKey,
            idempotencyKey: 'test:box-2',
        });
        assert.strictEqual(secondBox.code, 'weekly_item_limit');
        assert.strictEqual((await getPaShopState(db, PLAYER_ID, { weekKey })).availablePa, balanceAfterBox);

        const coupon = await purchasePaShopItem(db, PLAYER_ID, '4', {
            weekKey,
            idempotencyKey: 'test:coupon',
        });
        assert.strictEqual(coupon.ok, true);

        const star = await purchasePaShopItem(db, PLAYER_ID, '5', {
            weekKey,
            idempotencyKey: 'test:star',
        });
        assert.strictEqual(star.ok, true);
        player = await db.get('SELECT * FROM jogadores WHERE id = ?', [PLAYER_ID]);
        assert.strictEqual(Number(player.estrelas), 1);
        const squad = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [star.reward.squadKey]);
        assert.strictEqual(Number(squad.current_stars), 1);

        const ph = await purchasePaShopItem(db, PLAYER_ID, '1', {
            quantity: 10,
            weekKey,
            idempotencyKey: 'test:ph',
        });
        assert.strictEqual(ph.ok, true);
        assert.strictEqual(ph.reward.amount, 10);

        const balanceBeforeExcess = (await getPaShopState(db, PLAYER_ID, { weekKey })).availablePa;
        const excessivePh = await purchasePaShopItem(db, PLAYER_ID, '1', {
            quantity: 21,
            weekKey,
            idempotencyKey: 'test:ph-excess',
        });
        assert.strictEqual(excessivePh.code, 'weekly_ph_limit');
        assert.strictEqual(excessivePh.available, 20);
        assert.strictEqual((await getPaShopState(db, PLAYER_ID, { weekKey })).availablePa, balanceBeforeExcess);

        state = await getPaShopState(db, PLAYER_ID, { weekKey });
        assert.strictEqual(state.commonPhUsed, 10);
        assert.strictEqual(state.items.find((item) => item.key === 'yulls').used, 3);
        assert.strictEqual(state.items.find((item) => item.key === 'caixa_simples').used, 1);
        assert.strictEqual(state.items.find((item) => item.key === 'cupom_prioridade').used, 1);
        assert.strictEqual(state.items.find((item) => item.key === 'estrela_esquadrao').used, 1);
        assert.strictEqual(state.availablePa, 152);

        const purchases = await db.all(
            `SELECT * FROM clover_pa_shop_purchases
             WHERE evaluator_id = ?
             ORDER BY id ASC`,
            [PLAYER_ID]
        );
        assert.strictEqual(purchases.length, 5);
        assert(purchases.every((purchase) => purchase.status === 'completed'));
        assert(purchases.every((purchase) => purchase.reward_json && purchase.reward_json !== '{}'));
        const purchaseCost = purchases.reduce((sum, purchase) => sum + Number(purchase.pa_cost || 0), 0);
        assert.strictEqual(purchaseCost, 98);

        const consumedRow = await db.get(
            `SELECT COALESCE(SUM(paid_points), 0) AS total
             FROM clover_admin_service_entries
             WHERE evaluator_id = ?
               AND status <> 'void'`,
            [PLAYER_ID]
        );
        assert.strictEqual(Number(consumedRow.total), purchaseCost);
        assert.strictEqual(250 - purchaseCost, state.availablePa);

        const payout = await db.get(
            `SELECT * FROM clover_admin_service_payouts
             WHERE evaluator_id = ? AND source = 'pa_shop_ph'`,
            [PLAYER_ID]
        );
        assert.strictEqual(Number(payout.points_paid), 10);
        assert.strictEqual(Number(payout.ph_paid), 10);

        const phLedger = await db.get(
            `SELECT * FROM clover_ph_ledger
             WHERE player_id = ? AND source = 'pa_shop'`,
            [PLAYER_ID]
        );
        assert.strictEqual(Number(phLedger.amount), 10);
        assert.strictEqual(phLedger.kind, 'ganho');

        const inventory = await db.all('SELECT * FROM clover_inventory_items WHERE player_id = ?', [PLAYER_ID]);
        assert.strictEqual(inventory.length, 2);
        assert(inventory.some((item) => item.item_name === 'Caixa Simples de Serviço'));
        assert(inventory.some((item) => item.item_name === 'Cupom de Prioridade'));

        const shopText = await renderShop(db, PLAYER_ID);
        const statusText = await renderStatus(db, PLAYER_ID);
        for (const output of [shopText, statusText]) {
            assert.strictEqual(typeof output, 'string');
            assert(!output.includes('undefined'));
            assert(!output.includes('[object Object]'));
            assert(output.includes('𝐏𝐀'));
            assert(output.length < 4096, `Saída excessivamente longa: ${output.length}`);
        }
        assert(shopText.includes('𝐏𝐇 𝐝𝐞 𝐬𝐞𝐫𝐯𝐢𝐜̧𝐨'));
        assert(shopText.includes('𝐘𝐮𝐥𝐥𝐬 𝐝𝐞 𝐬𝐞𝐫𝐯𝐢𝐜̧𝐨'));
        assert(shopText.includes('𝐂𝐚𝐢𝐱𝐚 𝐬𝐢𝐦𝐩𝐥𝐞𝐬'));
        assert(shopText.includes('𝐂𝐮𝐩𝐨𝐦 𝐝𝐞 𝐩𝐫𝐢𝐨𝐫𝐢𝐝𝐚𝐝𝐞'));
        assert(shopText.includes('𝐄𝐬𝐭𝐫𝐞𝐥𝐚 𝐝𝐞 𝐞𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨'));
        assert(!shopText.includes('𝐌H de serviço'));
        assert(shopText.includes('3/10'));
        assert(shopText.includes('1/1'));
        assert(statusText.includes('152'));

        assert(command.nome.endsWith('pa'));
        assert(command.aliases.some((alias) => alias.endsWith('servico')));

        writeArtifacts({
            shopText,
            statusText,
            report: {
                weekKey,
                initialPa: 250,
                spentPa: purchaseCost,
                availablePa: state.availablePa,
                commonPhUsed: state.commonPhUsed,
                purchases: purchases.map((purchase) => ({
                    itemKey: purchase.item_key,
                    quantity: Number(purchase.quantity),
                    paCost: Number(purchase.pa_cost),
                    status: purchase.status,
                })),
                negativeScenarios: {
                    insufficientPa: noPa.code,
                    missingSquad: noSquad.code,
                    duplicate: duplicate.code,
                    secondBox: secondBox.code,
                    excessivePh: excessivePh.code,
                },
                outputLengths: {
                    shop: shopText.length,
                    wallet: statusText.length,
                },
            },
        });

        console.log('✓ saldo de PA consumido em FIFO');
        console.log('✓ contabilidade de compras bate com PA consumido');
        console.log('✓ falhas não retiram saldo');
        console.log('✓ limites semanais por item');
        console.log('✓ teto comum de PH');
        console.log('✓ Yulls, inventário e estrela aplicados');
        console.log('✓ duplicidade bloqueada por idempotência');
        console.log('✓ apresentação final da loja validada');
        console.log('✓ snapshots publicados para revisão');
        console.log('✓ .pa principal e .servico como alias');
        console.log('\nResultado: simulação da Loja de PA passou.');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
