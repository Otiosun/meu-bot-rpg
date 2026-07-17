const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const originalLoad = Module._load;
Module._load = function loadForFoundationTests(request, parent, isMain) {
    if (request === 'sqlite3') {
        return { verbose: () => ({ Database: class TestDriver {} }) };
    }
    if (request === 'sqlite') {
        return { open: async () => { throw new Error('open() não deve ser usado neste teste'); } };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
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

function createAsyncAdapter() {
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
}

async function createTestDb() {
    const db = createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            dinheiro INTEGER DEFAULT 0,
            jogo_status TEXT DEFAULT 'liberado',
            jogo_liberado_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO jogadores (id, dinheiro) VALUES ('p1', 5300);
        INSERT INTO jogadores (id, dinheiro) VALUES ('p2', 0);
    `);
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverRecruitmentSchema(db);
    return db;
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
