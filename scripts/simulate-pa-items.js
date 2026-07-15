'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { ensureCloverInventorySchema } = require('../database');
const {
    callNextQueueEntry,
    ensureSpellbookSchema,
    getActiveQueueEntry,
    getQueuePosition,
    listActiveQueue,
    requeueActiveQueueEntry,
} = require('../helpers/clover/spellbookService');
const {
    activatePriorityCoupon,
    isPriorityQueueEntry,
    openSimplePaBox,
} = require('../helpers/clover/paItemUseService');
const { ensureCloverPaShopSchema } = require('../helpers/clover/paShopSchema');
const {
    renderBoxResult,
    renderPriorityResult,
    renderShopWithItemUse,
} = require('../helpers/clover/paCommandItemsFinal');

const PLAYER = '5511999999999@s.whatsapp.net';
const NORMAL_A = '5511888888888@s.whatsapp.net';
const NORMAL_B = '5511777777777@s.whatsapp.net';

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
        `INSERT INTO jogadores (id, nome, display_name, personagem_nome, dinheiro)
         VALUES (?, 'Avaliador', 'Avaliador', 'Teste Clover', 0)`,
        [PLAYER]
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome) VALUES (?, 'Normal A')`,
        [NORMAL_A]
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome) VALUES (?, 'Normal B')`,
        [NORMAL_B]
    );
    await ensureCloverInventorySchema(db);
    await ensureCloverPaShopSchema(db);
    await ensureSpellbookSchema(db);
    return db;
}

async function addInventory(db, playerId, { name, kind, quantity }) {
    return db.run(
        `INSERT INTO clover_inventory_items
         (player_id, item_name, description, quantity, kind, source, created_at)
         VALUES (?, ?, 'Item de teste', ?, ?, 'test', CURRENT_TIMESTAMP)`,
        [playerId, name, quantity, kind]
    );
}

async function inventoryQuantity(db, playerId, kind) {
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_inventory_items
         WHERE player_id = ? AND kind = ?`,
        [playerId, kind]
    );
    return Number(row?.total || 0);
}

async function main() {
    const db = await createDb();
    try {
        await addInventory(db, PLAYER, {
            name: 'Caixa Simples de Serviço',
            kind: 'caixa_pa',
            quantity: 2,
        });
        await addInventory(db, PLAYER, {
            name: 'Cupom de Prioridade',
            kind: 'cupom_pa',
            quantity: 2,
        });

        const yullsBox = await openSimplePaBox(db, PLAYER, {
            createdBy: PLAYER,
            idempotencyKey: 'box:yulls',
            roll: 10,
        });
        assert.strictEqual(yullsBox.ok, true);
        assert.strictEqual(yullsBox.reward.type, 'yulls');
        assert.strictEqual(yullsBox.reward.amount, 500);
        assert.strictEqual(yullsBox.remainingBoxes, 1);
        let player = await db.get('SELECT * FROM jogadores WHERE id = ?', [PLAYER]);
        assert.strictEqual(Number(player.dinheiro), 500);

        const duplicateBox = await openSimplePaBox(db, PLAYER, {
            createdBy: PLAYER,
            idempotencyKey: 'box:yulls',
            roll: 74,
        });
        assert.strictEqual(duplicateBox.code, 'duplicate');
        assert.strictEqual(await inventoryQuantity(db, PLAYER, 'caixa_pa'), 1);
        player = await db.get('SELECT * FROM jogadores WHERE id = ?', [PLAYER]);
        assert.strictEqual(Number(player.dinheiro), 500);

        const itemBox = await openSimplePaBox(db, PLAYER, {
            createdBy: PLAYER,
            idempotencyKey: 'box:item',
            roll: 80,
        });
        assert.strictEqual(itemBox.ok, true);
        assert.strictEqual(itemBox.reward.type, 'inventory');
        assert.strictEqual(itemBox.reward.itemName, 'Poção de Mana Simples');
        assert.strictEqual(itemBox.remainingBoxes, 0);

        const noBox = await openSimplePaBox(db, PLAYER, {
            createdBy: PLAYER,
            idempotencyKey: 'box:none',
            roll: 99,
        });
        assert.strictEqual(noBox.code, 'no_box');

        await db.run(
            `INSERT INTO clover_spell_review_queue (player_id, status, requested_at)
             VALUES (?, 'waiting', '2026-07-15 10:00:00')`,
            [NORMAL_A]
        );
        await db.run(
            `INSERT INTO clover_spell_review_queue (player_id, status, requested_at)
             VALUES (?, 'waiting', '2026-07-15 10:05:00')`,
            [PLAYER]
        );
        await db.run(
            `INSERT INTO clover_spell_review_queue (player_id, status, requested_at)
             VALUES (?, 'waiting', '2026-07-15 10:10:00')`,
            [NORMAL_B]
        );

        let entry = await getActiveQueueEntry(db, PLAYER);
        assert.strictEqual(await getQueuePosition(db, entry), 2);

        const priority = await activatePriorityCoupon(db, PLAYER, {
            createdBy: PLAYER,
            idempotencyKey: 'priority:1',
        });
        assert.strictEqual(priority.ok, true);
        assert.strictEqual(priority.position, 1);
        assert.strictEqual(priority.remainingCoupons, 1);
        assert.strictEqual(isPriorityQueueEntry(priority.entry), true);

        const duplicatePriority = await activatePriorityCoupon(db, PLAYER, {
            createdBy: PLAYER,
            idempotencyKey: 'priority:1',
        });
        assert.strictEqual(duplicatePriority.code, 'duplicate');
        assert.strictEqual(await inventoryQuantity(db, PLAYER, 'cupom_pa'), 1);

        const secondPriority = await activatePriorityCoupon(db, PLAYER, {
            createdBy: PLAYER,
            idempotencyKey: 'priority:2',
        });
        assert.strictEqual(secondPriority.code, 'already_priority');
        assert.strictEqual(await inventoryQuantity(db, PLAYER, 'cupom_pa'), 1);

        let queue = await listActiveQueue(db);
        assert.strictEqual(queue[0].player_id, PLAYER);
        const called = await callNextQueueEntry(db, 'admin');
        assert.strictEqual(called.ok, true);
        assert.strictEqual(called.entry.player_id, PLAYER);

        const requeued = await requeueActiveQueueEntry(db, PLAYER, 'admin', 'indisponível agora');
        assert.strictEqual(requeued.ok, true);
        entry = await getActiveQueueEntry(db, PLAYER);
        assert.strictEqual(isPriorityQueueEntry(entry), true);
        assert.strictEqual(await getQueuePosition(db, entry), 1);
        queue = await listActiveQueue(db);
        assert.strictEqual(queue[0].player_id, PLAYER);

        const uses = await db.all('SELECT * FROM clover_pa_item_uses ORDER BY id');
        assert.strictEqual(uses.length, 3);
        assert.strictEqual(uses.filter((use) => use.item_key === 'caixa_simples').length, 2);
        assert.strictEqual(uses.filter((use) => use.item_key === 'cupom_prioridade').length, 1);

        const boxText = renderBoxResult(itemBox);
        const priorityText = renderPriorityResult(priority);
        const shopText = await renderShopWithItemUse(db, PLAYER);
        for (const output of [boxText, priorityText, shopText]) {
            assert.strictEqual(typeof output, 'string');
            assert(!output.includes('undefined'));
            assert(!output.includes('[object Object]'));
            assert(output.length < 4096);
        }
        assert(shopText.includes('pa abrir'));
        assert(shopText.includes('pa prioridade'));
        assert(priorityText.includes('antes da fila comum'));

        console.log('✓ Caixa Simples consome uma unidade por abertura');
        console.log('✓ tabela fixa entrega Yulls ou consumível comum');
        console.log('✓ repetição da mesma mensagem não duplica recompensa');
        console.log('✓ Cupom só consome uma vez e não acumula prioridade');
        console.log('✓ prioridade passa a fila comum sem ultrapassar chamado');
        console.log('✓ prioridade permanece após reentrada causada por pular');
        console.log('✓ saídas visuais ficaram abaixo de 4.096 caracteres');
        console.log('\nResultado: simulação dos itens de PA passou.');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
