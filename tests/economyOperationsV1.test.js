'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let createAsyncAdapter;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createAsyncAdapter = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    Module._load = function loadSqliteFallback(request, parent, isMain) {
        if (request === 'sqlite3') return { verbose: () => ({ Database: class TestDriver {} }) };
        if (request === 'sqlite') return { open: async () => { throw new Error('open() não deve ser usado'); } };
        return originalLoad.call(this, request, parent, isMain);
    };
    createAsyncAdapter = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return { changes: Number(result.changes || 0), lastID: Number(result.lastInsertRowid || 0) };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const {
    ensureCloverEconomySchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverRaidSchema,
} = require('../database');
Module._load = originalLoad;

const { addCatalogItem, applyDurabilityLoss } = require('../helpers/clover/inventoryService');
const { getYullsSummary } = require('../helpers/clover/yullsService');
const {
    EconomyServiceError,
    calculateRepairQuote,
    cancelPurchase,
    confirmNpcSale,
    confirmPurchase,
    confirmRepair,
    getEconomicWeekKey,
    grantInitialPackage,
    paySalaryForWeek,
    previewNpcSale,
    previewPurchase,
    previewRepair,
    processDueEconomyOperations,
    shiftWeekKey,
    useConsumable,
} = require('../helpers/clover/economyService');

const PLAYER = '5511999999999@s.whatsapp.net';

async function createTestDb(options = {}) {
    const db = await createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-', display_name TEXT DEFAULT '-', personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL, personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-', personagem_aparencia_status TEXT DEFAULT 'approved',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            reino TEXT DEFAULT 'Clover', classe TEXT DEFAULT '-', familia TEXT DEFAULT '-', raca TEXT DEFAULT 'Humano',
            grimorio TEXT DEFAULT '-', magia TEXT DEFAULT '-', formas TEXT DEFAULT '-', esquadrao TEXT DEFAULT 'Coringas Magenta',
            estrelas INTEGER DEFAULT 0, patente TEXT DEFAULT 'Júnior 2ª Classe', aptidao_comum TEXT DEFAULT '-',
            aptidao_rara TEXT DEFAULT '-', marca_comum TEXT DEFAULT '-', marca_rara TEXT DEFAULT '-',
            anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, patente)
         VALUES (?, 'Player de Teste', ?, ?)`,
        [PLAYER, options.money ?? 50000, options.patent || 'Júnior 2ª Classe']
    );
    await ensureCloverEconomySchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverRaidSchema(db);
    return db;
}

test('compra reserva saldo, confirma uma vez e devolve com retenção de 10%', async (t) => {
    const db = await createTestDb({ money: 10000 });
    t.after(() => db.close());
    const preview = await previewPurchase(db, PLAYER, 'kit_campo', 2, { idempotencyKey: 'buy-preview-1' });
    assert.equal(preview.purchase.total, 1700);
    let wallet = await getYullsSummary(db, PLAYER);
    assert.equal(wallet.total, 10000);
    assert.equal(wallet.reserved, 1700);
    assert.equal(wallet.available, 8300);

    const confirmed = await confirmPurchase(db, PLAYER, preview.purchase.key);
    const duplicate = await confirmPurchase(db, PLAYER, preview.purchase.key);
    assert.equal(confirmed.purchase.status, 'completed');
    assert.equal(duplicate.duplicate, true);
    wallet = await getYullsSummary(db, PLAYER);
    assert.equal(wallet.total, 8300);
    assert.equal(wallet.reserved, 0);

    const returned = await cancelPurchase(db, PLAYER, preview.purchase.key);
    assert.equal(returned.refunded, 1530);
    assert.equal((await getYullsSummary(db, PLAYER)).total, 9830);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id = ?', [PLAYER])).total, 0);
});

test('encomenda regional express aplica 15% e depois 25%, sem bloquear o inventário para sempre', async (t) => {
    const db = await createTestDb({ money: 20000 });
    t.after(() => db.close());
    const preview = await previewPurchase(db, PLAYER, 'pocao_antidoto', 1, {
        express: true,
        idempotencyKey: 'regional-preview-1',
    });
    assert.equal(preview.purchase.subtotal, 5000);
    assert.equal(preview.purchase.regionalFee, 750);
    assert.equal(preview.purchase.expressFee, 1437);
    assert.equal(preview.purchase.total, 7187);
    const confirmed = await confirmPurchase(db, PLAYER, preview.purchase.key);
    assert.equal(confirmed.purchase.status, 'in_transport');
    assert.equal(confirmed.items[0].status, 'em_transporte');

    await db.run(
        "UPDATE clover_economy_purchase_intents SET deliver_at = datetime('now', '-1 minute') WHERE intent_key = ?",
        [preview.purchase.key]
    );
    await processDueEconomyOperations(db);
    const delivered = await db.get('SELECT status FROM clover_inventory_items WHERE id = ?', [confirmed.items[0].id]);
    assert.equal(delivered.status, 'disponivel');
});

test('serviço da Casa de Cura gera recibo econômico sem criar item artificial', async (t) => {
    const db = await createTestDb({ money: 5000 });
    t.after(() => db.close());
    const preview = await previewPurchase(db, PLAYER, 'tratamento_leve_npc', 1, { idempotencyKey: 'healing-preview-1' });
    const confirmed = await confirmPurchase(db, PLAYER, preview.purchase.key);
    assert.equal(confirmed.purchase.status, 'completed');
    assert.equal(confirmed.items.length, 0);
    assert.equal((await getYullsSummary(db, PLAYER)).total, 3000);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id = ?', [PLAYER])).total, 0);
});

test('revenda de equipamento usa condição e conclui item + Yulls atomicamente', async (t) => {
    const db = await createTestDb({ money: 0 });
    t.after(() => db.close());
    const armor = await addCatalogItem(db, PLAYER, 'armadura_couro', 1, { source: 'teste' });
    const itemId = armor.items[0].id;
    await applyDurabilityLoss(db, PLAYER, itemId, 2, 'Choque de teste', 'narrador');
    const preview = await previewNpcSale(db, PLAYER, itemId, 1, { idempotencyKey: 'sale-preview-1' });
    assert.equal(preview.item.condition, 'desgastado');
    assert.equal(preview.sale.offerPercent, 30);
    assert.equal(preview.sale.offerTotal, 900);
    await confirmNpcSale(db, PLAYER, preview.sale.key);
    assert.equal((await getYullsSummary(db, PLAYER)).total, 900);
    assert.equal(await db.get('SELECT id FROM clover_inventory_items WHERE id = ?', [itemId]), undefined);
});

test('equipamento quebrado continua vendável por 5% do valor de referência', async (t) => {
    const db = await createTestDb({ money: 0 });
    t.after(() => db.close());
    const armor = await addCatalogItem(db, PLAYER, 'armadura_couro', 1, { source: 'teste' });
    const itemId = armor.items[0].id;
    await applyDurabilityLoss(db, PLAYER, itemId, 3, 'Quebra parcial', 'narrador');
    await applyDurabilityLoss(db, PLAYER, itemId, 2, 'Quebra final', 'narrador');
    const preview = await previewNpcSale(db, PLAYER, itemId, 1, { idempotencyKey: 'broken-sale-preview-1' });
    assert.equal(preview.item.condition, 'quebrado');
    assert.equal(preview.sale.offerPercent, 5);
    assert.equal(preview.sale.offerTotal, 150);
    await confirmNpcSale(db, PLAYER, preview.sale.key);
    assert.equal((await getYullsSummary(db, PLAYER)).total, 150);
});

test('reparo cobra a fórmula publicada e restaura o item ao terminar', async (t) => {
    const db = await createTestDb({ money: 10000 });
    t.after(() => db.close());
    const armor = await addCatalogItem(db, PLAYER, 'armadura_couro', 1, { source: 'teste' });
    const itemId = armor.items[0].id;
    await applyDurabilityLoss(db, PLAYER, itemId, 3, 'Impacto crítico', 'narrador');
    await applyDurabilityLoss(db, PLAYER, itemId, 2, 'Dano final', 'narrador');
    const broken = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [itemId]);
    const quote = calculateRepairQuote({ ...broken, condition: calculateConditionSafe(broken) });
    assert.equal(quote.pointCost, 300);
    assert.equal(quote.brokenSurcharge, 150);
    assert.equal(quote.total, 1650);

    const preview = await previewRepair(db, PLAYER, itemId, { idempotencyKey: 'repair-preview-1' });
    assert.equal(preview.repair.total, 1650);
    const confirmed = await confirmRepair(db, PLAYER, preview.repair.key);
    assert.equal(confirmed.repair.status, 'in_progress');
    assert.equal((await db.get('SELECT status FROM clover_inventory_items WHERE id = ?', [itemId])).status, 'em_reparo');

    await db.run(
        "UPDATE clover_repair_orders SET deliver_at = datetime('now', '-1 minute') WHERE order_key = ?",
        [preview.repair.key]
    );
    await processDueEconomyOperations(db);
    const repaired = await db.get('SELECT durability_current, durability_max, status FROM clover_inventory_items WHERE id = ?', [itemId]);
    assert.equal(repaired.durability_current, 5);
    assert.equal(repaired.durability_max, 5);
    assert.equal(repaired.status, 'disponivel');
    assert.equal((await getYullsSummary(db, PLAYER)).total, 8350);
});

function calculateConditionSafe(row) {
    return row.durability_current === 0 ? 'quebrado' : 'integro';
}

test('terceiro aprimoramento físico registra sobrecarga sem depender de alteração automática de atributo', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const potions = await addCatalogItem(db, PLAYER, 'pocao_forca', 3, { source: 'teste' });
    const itemId = potions.items[0].id;
    const base = { contextType: 'raid', contextId: 'raid-teste', via: 'site' };
    assert.equal((await useConsumable(db, PLAYER, itemId, { ...base, idempotencyKey: 'use-1' })).result, 'used');
    assert.equal((await useConsumable(db, PLAYER, itemId, { ...base, idempotencyKey: 'use-2' })).result, 'used');
    const third = await useConsumable(db, PLAYER, itemId, { ...base, idempotencyKey: 'use-3' });
    assert.equal(third.result, 'overload');
    assert.equal(third.narratorApplies, true);
    const active = await db.get("SELECT effect_key FROM clover_active_item_effects WHERE player_id = ? AND status = 'active'", [PLAYER]);
    assert.equal(active.effect_key, 'cansado_sobrecarga_alquimica');
});

test('salário reconhece serviço elegível, usa a patente e paga uma única vez', async (t) => {
    const db = await createTestDb({ money: 0, patent: 'Júnior 2ª Classe' });
    t.after(() => db.close());
    const weekKey = shiftWeekKey(getEconomicWeekKey(), -1);
    await db.run(
        `INSERT INTO clover_quick_evaluations
         (message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
          week_key, bypass_weekly_limit, salary_eligible, salary_service_type)
         VALUES ('salary-scene-1', 'on@g.us', ?, 'adm@s.whatsapp.net',
                 'missao_auto_narrada', 'Missão Auto-Narrada', ?, 0, 1, 'missao_auto_narrada')`,
        [PLAYER, weekKey]
    );
    const paid = await paySalaryForWeek(db, PLAYER, weekKey);
    const duplicate = await paySalaryForWeek(db, PLAYER, weekKey);
    assert.equal(paid.paid, true);
    assert.equal(paid.claim.amount, 750);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await getYullsSummary(db, PLAYER)).total, 750);
});

test('pacote inicial entrega 500 Yulls e três itens vinculados apenas uma vez', async (t) => {
    const db = await createTestDb({ money: 0 });
    t.after(() => db.close());
    const granted = await grantInitialPackage(db, PLAYER, 'espada_curta', { via: 'site' });
    const duplicate = await grantInitialPackage(db, PLAYER, 'espada_curta', { via: 'site' });
    assert.equal(granted.items.length, 3);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await getYullsSummary(db, PLAYER)).total, 500);
    const rows = await db.all('SELECT bound, transferable FROM clover_inventory_items WHERE player_id = ?', [PLAYER]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.bound === 1 && row.transferable === 0));
});

test('compra regional respeita limite pessoal de cinco unidades por semana', async (t) => {
    const db = await createTestDb({ money: 100000 });
    t.after(() => db.close());
    const first = await previewPurchase(db, PLAYER, 'pocao_antidoto', 5, { idempotencyKey: 'regional-limit-1' });
    await confirmPurchase(db, PLAYER, first.purchase.key);
    await assert.rejects(
        () => previewPurchase(db, PLAYER, 'pocao_antidoto', 1, { idempotencyKey: 'regional-limit-2' }),
        (error) => error instanceof EconomyServiceError && error.code === 'weekly_purchase_limit'
    );
});
