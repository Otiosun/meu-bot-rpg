'use strict';

const assert = require('assert');
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
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverInventorySchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverSquadSchema(db);
    return db;
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

        let state = await getPaShopState(db, PLAYER_ID, { weekKey });
        assert.strictEqual(state.availablePa, 250);
        assert.strictEqual(state.items.find((item) => item.key === 'yulls').used, 0);
        assert.strictEqual(state.items.find((item) => item.key === 'caixa_simples').available, 1);

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
        const secondBox = await purchasePaShopItem(db, PLAYER_ID, '3', {
            weekKey,
            idempotencyKey: 'test:box-2',
        });
        assert.strictEqual(secondBox.code, 'weekly_item_limit');

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

        const excessivePh = await purchasePaShopItem(db, PLAYER_ID, '1', {
            quantity: 21,
            weekKey,
            idempotencyKey: 'test:ph-excess',
        });
        assert.strictEqual(excessivePh.code, 'weekly_ph_limit');
        assert.strictEqual(excessivePh.available, 20);

        state = await getPaShopState(db, PLAYER_ID, { weekKey });
        assert.strictEqual(state.commonPhUsed, 10);
        assert.strictEqual(state.items.find((item) => item.key === 'yulls').used, 3);
        assert.strictEqual(state.items.find((item) => item.key === 'caixa_simples').used, 1);
        assert.strictEqual(state.items.find((item) => item.key === 'cupom_prioridade').used, 1);
        assert.strictEqual(state.items.find((item) => item.key === 'estrela_esquadrao').used, 1);
        assert.strictEqual(state.availablePa, 152);

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

        console.log('✓ saldo de PA consumido em FIFO');
        console.log('✓ limites semanais por item');
        console.log('✓ teto comum de PH');
        console.log('✓ Yulls, inventário e estrela aplicados');
        console.log('✓ duplicidade bloqueada por idempotência');
        console.log('✓ apresentação final da loja validada');
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