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
    Module._load = function loadForFoundationTests(request, parent, isMain) {
        if (request === 'sqlite3') {
            return { verbose: () => ({ Database: class TestDriver {} }) };
        }
        if (request === 'sqlite') {
            return { open: async () => { throw new Error('open() não deve ser usado neste teste'); } };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    createAsyncAdapter = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return {
                    changes: Number(result.changes || 0),
                    lastID: Number(result.lastInsertRowid || 0),
                };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const {
    ensureCloverInventorySchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverRecruitmentSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const {
    YullsServiceError,
    addYulls,
    getYullsHistory,
    getYullsSummary,
    spendYulls,
} = require('../helpers/clover/yullsService');
const {
    PrServiceError,
    addGroupPromotionPr,
    addRecruitmentPr,
    getPrSummary,
} = require('../helpers/clover/prService');

Module._load = originalLoad;

Module._load = function loadEconomyWithPhStub(request, parent, isMain) {
    const parentFile = String(parent?.filename || '');
    if (request === './phService'
        && (parentFile.endsWith('recruitmentService.js') || parentFile.endsWith('boxService.js'))) {
        return {
            ensurePhState: async (db) => {
                await db.exec(`
                    CREATE TABLE IF NOT EXISTS test_ph_awards (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        player_id TEXT NOT NULL,
                        amount INTEGER NOT NULL,
                        related_id TEXT DEFAULT NULL
                    )
                `);
            },
            addPhInTransaction: async (db, playerId, amount, source, reason, createdBy, metadata, relatedId) => {
                const inserted = await db.run(
                    'INSERT INTO test_ph_awards (player_id, amount, related_id) VALUES (?, ?, ?)',
                    [playerId, amount, relatedId]
                );
                return { ledgerId: inserted.lastID, amount, after: { phAvailable: amount, phAccumulated: amount } };
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const {
    RecruitmentServiceError,
    configureRecruitmentEvent,
    ensureRecruitmentCode,
    submitReferralCode,
    tryValidateReferralFromEvaluation,
} = require('../helpers/clover/recruitmentService');
const {
    validateBoxCatalogs,
} = require('../helpers/clover/economyItemCatalog');
const {
    addCatalogItem,
    applyDurabilityLoss,
    calculateCondition,
    calculateReferencePrice,
    getStructuredInventory,
} = require('../helpers/clover/inventoryService');
const {
    getBoxDashboard,
    openBox,
} = require('../helpers/clover/boxService');

Module._load = originalLoad;

async function createTestDb() {
    const db = await createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            jogo_status TEXT DEFAULT 'liberado',
            jogo_liberado_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO jogadores (id, personagem_nome, dinheiro) VALUES ('p1', 'Recrutador', 5300);
        INSERT INTO jogadores (id, personagem_nome, dinheiro) VALUES ('p2', 'Novato', 0);
    `);
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverRecruitmentSchema(db);
    await ensureCloverInventorySchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    return db;
}

async function activateEvent(db) {
    const now = new Date();
    const startsAt = new Date(now.getTime() - 60 * 60 * 1000);
    const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    return configureRecruitmentEvent(db, { status: 'active', startsAt, endsAt });
}

async function insertUpEvaluation(db, playerId, key = `up:${playerId}:${Date.now()}`) {
    const inserted = await db.run(
        `INSERT INTO clover_quick_evaluations
         (message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
          scene_sent_at, evaluated_at, week_key, rewards_json, metadata_json)
         VALUES (?, 'on@g.us', ?, 'admin', 'cena_interativa', 'Cena Interativa',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '2026-07-13', '{}', '{}')`,
        [key, playerId]
    );
    return inserted.lastID;
}

test('preserva o saldo antigo como abertura e aplica mutações idempotentes', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    const initial = await getYullsSummary(db, 'p1');
    assert.equal(initial.balance, 5300);
    assert.equal(initial.entries, 1);

    const first = await addYulls(
        db,
        'p1',
        2000,
        'teste',
        'Recompensa de teste',
        'admin',
        { idempotencyKey: 'test:yulls:p1:1' }
    );
    const duplicate = await addYulls(
        db,
        'p1',
        2000,
        'teste',
        'Recompensa de teste',
        'admin',
        { idempotencyKey: 'test:yulls:p1:1' }
    );

    assert.equal(first.balanceAfter, 7300);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await getYullsSummary(db, 'p1')).balance, 7300);
});

test('detecta alteração legada antes da próxima mutação de Yulls', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    await getYullsSummary(db, 'p1');
    await db.run('UPDATE jogadores SET dinheiro = dinheiro + 500 WHERE id = ?', ['p1']);
    const result = await addYulls(db, 'p1', 100, 'teste', 'Após legado', 'admin');
    const history = await getYullsHistory(db, 'p1', 10);

    assert.equal(result.balanceAfter, 5900);
    assert.equal(history.some((entry) => entry.kind === 'sincronizacao_legada' && entry.amount === 500), true);
});

test('impede saldo negativo de Yulls', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    await assert.rejects(
        () => spendYulls(db, 'p2', 1, 'loja', 'Compra', 'p2'),
        (error) => error instanceof YullsServiceError && error.code === 'insufficient_yulls'
    );
});

test('limita somente PR de divulgação em grupos e mantém recrutamento fora do teto', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const options = { weekKey: '2026-07-13', eventKey: 'divulgacao_v1' };

    await addGroupPromotionPr(db, 'p1', 15, '15 PR aprovados', 'admin', options);
    await addGroupPromotionPr(db, 'p1', 5, '5 PR aprovados', 'admin', options);
    await assert.rejects(
        () => addGroupPromotionPr(db, 'p1', 1, 'Excedente', 'admin', options),
        (error) => error instanceof PrServiceError
            && error.code === 'weekly_group_limit_exceeded'
            && error.details.remaining === 0
    );

    await addRecruitmentPr(db, 'p1', 5, 'Recrutamento validado', 'system', {
        ...options,
        idempotencyKey: 'test:recruitment:p1:1',
    });
    const duplicate = await addRecruitmentPr(db, 'p1', 5, 'Recrutamento validado', 'system', {
        ...options,
        idempotencyKey: 'test:recruitment:p1:1',
    });
    const summary = await getPrSummary(db, 'p1', options);

    assert.equal(duplicate.duplicate, true);
    assert.equal(summary.balance, 25);
    assert.equal(summary.groupWeekEarned, 20);
    assert.equal(summary.groupWeekRemaining, 0);
});

test('cria o evento V1 em rascunho com os valores fechados', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    const event = await db.get(
        "SELECT * FROM clover_recruitment_events WHERE event_key = 'divulgacao_v1'"
    );
    assert.equal(event.status, 'draft');
    assert.equal(event.duration_days, 30);
    assert.equal(event.referral_window_days, 7);
    assert.equal(event.recruiter_pr_reward, 5);
    assert.equal(event.group_weekly_pr_limit, 20);
    assert.equal(event.recruit_yulls_reward, 10000);
    assert.equal(event.recruit_ph_reward, 30);
    assert.equal(event.recruit_item_reward, 'Caixa Simples');
    assert.equal(event.shop_enabled, 0);
});

test('valida recrutamento pelo primeiro UP e entrega todas as recompensas uma vez', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    await activateEvent(db);
    const code = await ensureRecruitmentCode(db, 'p1');

    const submitted = await submitReferralCode(db, 'p2', code, { via: 'site' });
    assert.equal(submitted.referral.status, 'pending');
    assert.equal(submitted.validation.validated, false);

    const evaluationId = await insertUpEvaluation(db, 'p2');
    const validated = await tryValidateReferralFromEvaluation(db, {
        playerId: 'p2',
        evaluationId,
        actorId: 'admin',
    });
    const repeated = await tryValidateReferralFromEvaluation(db, {
        playerId: 'p2',
        evaluationId,
        actorId: 'admin',
    });

    assert.equal(validated.validated, true);
    assert.equal(repeated.validated, false);
    assert.equal((await getPrSummary(db, 'p1')).balance, 5);
    assert.equal((await getYullsSummary(db, 'p2')).balance, 10000);
    assert.equal((await db.get('SELECT SUM(amount) AS total FROM test_ph_awards WHERE player_id = ?', ['p2'])).total, 30);
    const box = await db.get("SELECT * FROM clover_inventory_items WHERE player_id = 'p2'");
    assert.equal(box.item_name, 'Caixa Simples');
    assert.equal(box.kind, 'caixa_economia');
    assert.equal(box.template_key, 'box_simple_v1');
    const referral = await db.get("SELECT * FROM clover_recruitment_referrals WHERE recruit_player_id = 'p2'");
    assert.equal(referral.status, 'rewarded');
});

test('um UP anterior ao envio do código valida a indicação imediatamente', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    await activateEvent(db);
    const code = await ensureRecruitmentCode(db, 'p1');
    await insertUpEvaluation(db, 'p2', 'up-before-code');

    const submitted = await submitReferralCode(db, 'p2', code, { via: 'site' });
    assert.equal(submitted.validation.validated, true);
    assert.equal((await getPrSummary(db, 'p1')).balance, 5);
    assert.equal((await getYullsSummary(db, 'p2')).balance, 10000);
});

test('impede autoindicação e código enviado depois da janela', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    await activateEvent(db);
    const recruiterCode = await ensureRecruitmentCode(db, 'p1');

    await assert.rejects(
        () => submitReferralCode(db, 'p1', recruiterCode, { via: 'site' }),
        (error) => error instanceof RecruitmentServiceError && error.code === 'self_referral'
    );

    await db.run(
        "UPDATE jogadores SET jogo_liberado_at = datetime('now', '-8 days') WHERE id = 'p2'"
    );
    await assert.rejects(
        () => submitReferralCode(db, 'p2', recruiterCode, { via: 'site' }),
        (error) => error instanceof RecruitmentServiceError && error.code === 'referral_window_expired'
    );
});

test('catálogos das caixas fecham exatamente em 100%', () => {
    assert.deepEqual(
        validateBoxCatalogs().map(({ key, totalChance }) => ({ key, totalChance })),
        [
            { key: 'simples', totalChance: 100 },
            { key: 'rara', totalChance: 100 },
        ]
    );
});

test('qualidade e os quatro estados seguem a regra publicada', () => {
    assert.equal(calculateReferencePrice(1000, 'comum'), 1000);
    assert.equal(calculateReferencePrice(1001, 'refinada'), 1501);
    assert.equal(calculateReferencePrice(1001, 'superior'), 2502);
    assert.equal(calculateCondition(5, 5), 'integro');
    assert.equal(calculateCondition(4, 5), 'integro');
    assert.equal(calculateCondition(3, 5), 'desgastado');
    assert.equal(calculateCondition(2, 5), 'desgastado');
    assert.equal(calculateCondition(1, 5), 'danificado');
    assert.equal(calculateCondition(0, 5), 'quebrado');
});

test('inventário estruturado registra condição e histórico de desgaste', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    const added = await addCatalogItem(db, 'p1', 'armadura_couro', 1, {
        source: 'teste',
        createdBy: 'admin',
    });
    const itemId = added.items[0].id;
    const result = await applyDurabilityLoss(db, 'p1', itemId, 2, 'Golpe crítico na missão', 'admin');
    const inventory = await getStructuredInventory(db, 'p1');
    const history = await db.get(
        "SELECT * FROM clover_inventory_item_history WHERE item_id = ? AND action = 'desgaste'",
        [itemId]
    );

    assert.equal(result.item.durability_current, 3);
    assert.equal(result.item.condition, 'desgastado');
    assert.equal(inventory[0].reference_price, 3000);
    assert.match(history.metadata_json, /Golpe crítico na missão/);
});

test('abertura de Caixa Simples é atômica e idempotente', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    await addCatalogItem(db, 'p2', 'box_simple_v1', 1, { source: 'teste', bound: true });

    const first = await openBox(db, 'p2', 'simples', {
        idempotencyKey: 'test:box:p2:one',
        roll: 1,
        randomInt: () => 0,
    });
    const repeated = await openBox(db, 'p2', 'simples', {
        idempotencyKey: 'test:box:p2:one',
        roll: 100,
        randomInt: () => 0,
    });
    const dashboard = await getBoxDashboard(db, 'p2');

    assert.equal(first.reward.type, 'yulls');
    assert.equal(first.reward.amount, 1000);
    assert.equal(repeated.duplicate, true);
    assert.equal((await getYullsSummary(db, 'p2')).balance, 1000);
    assert.equal(dashboard.boxes.find((box) => box.key === 'simples').owned, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_box_openings')).total, 1);
});

test('prêmio de Caixa Simples adicional consome uma e devolve uma', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    await addCatalogItem(db, 'p2', 'box_simple_v1', 1, { source: 'teste', bound: true });

    const result = await openBox(db, 'p2', 'simples', {
        idempotencyKey: 'test:box:p2:extra',
        roll: 81,
        randomInt: () => 0,
    });
    const dashboard = await getBoxDashboard(db, 'p2');

    assert.equal(result.reward.templateKey, 'box_simple_v1');
    assert.equal(dashboard.boxes.find((box) => box.key === 'simples').owned, 1);
});
