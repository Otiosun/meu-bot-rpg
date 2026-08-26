'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { resetPlayer } = require('../helpers/clover/playerResetService');
const {
    abortGlobalPlayerResetPlan,
    applyGlobalPlayerReset,
    discoverTechnicalResetCandidates,
    getGlobalPlayerResetOperation,
    planGlobalPlayerReset,
    reconcileGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            personagem_idade INTEGER,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            dinheiro INTEGER DEFAULT 0,
            reino TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active',
            merged_into TEXT DEFAULT NULL
        );
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT,
            reason TEXT
        );
    `);
    const players = [
        ['a@lid', 'A', 'Pessoa A', 'Personagem A', 100, 0],
        ['b@lid', 'B', 'Pessoa B', 'Personagem B', 200, 0],
        ['c@lid', 'C', 'Pessoa C', '-', 300, 0],
        ['shadow@lid', 'Shadow', 'Shadow', 'Fantasma', 400, 1],
    ];
    for (const [id, nome, nomeReal, personagemNome, dinheiro, isShadow] of players) {
        await db.run(
            `INSERT INTO jogadores
             (id,nome,nome_real,personagem_nome,personagem_idade,ficha_status,historia_status,
              personagem_aparencia_status,jogo_status,dinheiro,is_shadow)
             VALUES (?,?,?,?,19,'aprovada','aprovada','approved','liberado',?,?)`,
            [id, nome, nomeReal, personagemNome, dinheiro, isShadow]
        );
    }
    await db.run(`INSERT INTO clover_ph_ledger (player_id,amount,kind,source,reason) VALUES ('a@lid',10,'ganho','teste','sentinela')`);
    await db.run(`INSERT INTO clover_ph_ledger (player_id,amount,kind,source,reason) VALUES ('b@lid',20,'ganho','teste','sentinela')`);
    return db;
}

function pinOperation(t, operationId) {
    const beforeEnabled = process.env.CLOVER_GLOBAL_RESET_ENABLED;
    const beforeId = process.env.CLOVER_GLOBAL_RESET_OPERATION_ID;
    const beforeAuthorization = process.env.CLOVER_RESET_EXECUTION_AUTHORIZED;
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    process.env.CLOVER_RESET_EXECUTION_AUTHORIZED = 'YES';
    t.after(() => {
        if (beforeEnabled === undefined) delete process.env.CLOVER_GLOBAL_RESET_ENABLED;
        else process.env.CLOVER_GLOBAL_RESET_ENABLED = beforeEnabled;
        if (beforeId === undefined) delete process.env.CLOVER_GLOBAL_RESET_OPERATION_ID;
        else process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = beforeId;
        if (beforeAuthorization === undefined) delete process.env.CLOVER_RESET_EXECUTION_AUTHORIZED;
        else process.env.CLOVER_RESET_EXECUTION_AUTHORIZED = beforeAuthorization;
    });
}

async function makePlan(db, playerIds = ['a@lid', 'b@lid', 'c@lid']) {
    return planGlobalPlayerReset(db, {
        actorId: OWNER,
        reason: 'Reset global sintético de segurança',
        playerIds,
        selectionSource: 'fixture explícita do teste',
        operationId: 'GR-TESTE-0001',
    });
}

test('dry-run congela população explícita sem mutar players e não trata discovery como autorização', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const discovered = await discoverTechnicalResetCandidates(db);
    assert.equal(discovered.write, false);
    assert.equal(discovered.authoritativeSelection, false);
    assert.deepEqual(discovered.playerIds, ['a@lid', 'b@lid', 'c@lid']);

    const before = await db.all('SELECT id, personagem_nome, dinheiro FROM jogadores ORDER BY id');
    const plan = await makePlan(db);
    const after = await db.all('SELECT id, personagem_nome, dinheiro FROM jogadores ORDER BY id');

    assert.equal(plan.dryRun, true);
    assert.equal(plan.mutatedPlayers, false);
    assert.equal(plan.selectedCount, 3);
    assert.equal(plan.expectedCount, 2);
    assert.equal(plan.skippedCount, 1);
    assert.deepEqual(after, before);

    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(journal.operation.status, 'planned');
    assert.deepEqual(journal.items.map((item) => item.status), ['pending', 'pending', 'skipped']);

    await assert.rejects(
        planGlobalPlayerReset(db, {
            actorId: OWNER,
            reason: 'Segundo ciclo não autorizado',
            playerIds: ['a@lid'],
            selectionSource: 'fixture',
            operationId: 'GR-TESTE-0002',
        }),
        (error) => error.code === 'global_reset_cycle_locked'
    );
});

test('dry-run usa a semântica canônica de personagem vazio e rejeita população efetiva vazia sem journal/lock órfão', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(`UPDATE jogadores SET personagem_nome='Nenhum' WHERE id='c@lid'`);
    const before = await db.get(`SELECT personagem_nome,dinheiro FROM jogadores WHERE id='c@lid'`);
    await assert.rejects(
        planGlobalPlayerReset(db, {
            actorId: OWNER,
            reason: 'Reset global vazio precisa falhar fechado',
            playerIds: ['c@lid'],
            selectionSource: 'fixture explícita sem personagem ativo',
            operationId: 'GR-VAZIO-0001',
        }),
        (error) => error.code === 'global_reset_empty_effective_population'
            && error.details?.selectedCount === 1
            && error.details?.skippedCount === 1
    );

    const after = await db.get(`SELECT personagem_nome,dinheiro FROM jogadores WHERE id='c@lid'`);
    assert.deepEqual(after, before);
    assert.equal((await db.get(`SELECT COUNT(*) AS total FROM clover_global_player_reset_operations`)).total, 0);
    assert.equal((await db.get(`SELECT COUNT(*) AS total FROM clover_global_player_reset_items`)).total, 0);
    assert.equal((await db.get(`SELECT COUNT(*) AS total FROM clover_global_player_reset_lock`)).total, 0);
});

test('apply exige kill switch, operation pin e autorização operacional final separados', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid', 'b@lid']);

    delete process.env.CLOVER_GLOBAL_RESET_ENABLED;
    delete process.env.CLOVER_GLOBAL_RESET_OPERATION_ID;
    delete process.env.CLOVER_RESET_EXECUTION_AUTHORIZED;
    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_kill_switch_off'
    );

    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = plan.operationId;
    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_execution_not_authorized'
    );

    pinOperation(t, plan.operationId);
    const result = await applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER });
    assert.equal(result.ok, true);
    assert.equal(result.expectedCount, 2);
    assert.equal(result.appliedCount, 2);
    assert.equal(result.failedCount, 0);

    const players = await db.all(`SELECT id, personagem_nome, ficha_status, jogo_status FROM jogadores WHERE id IN ('a@lid','b@lid') ORDER BY id`);
    assert.deepEqual(players, [
        { id: 'a@lid', personagem_nome: '-', ficha_status: 'incompleta', jogo_status: 'bloqueado' },
        { id: 'b@lid', personagem_nome: '-', ficha_status: 'incompleta', jogo_status: 'bloqueado' },
    ]);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 2);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total, 0);

    const reconciliation = await reconcileGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER });
    assert.equal(reconciliation.ok, true);
    assert.equal(reconciliation.status, 'reconciled');
    assert.equal(reconciliation.appliedCount, 2);
});

test('apply rejeita drift nos contadores congelados antes de adquirir executor ou mutar jogador', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid', 'b@lid']);
    pinOperation(t, plan.operationId);

    await db.run(
        `UPDATE clover_global_player_reset_operations SET expected_count=999 WHERE operation_id=?`,
        [plan.operationId]
    );
    const before = await db.all(`SELECT id,personagem_nome,dinheiro FROM jogadores WHERE id IN ('a@lid','b@lid') ORDER BY id`);

    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_frozen_counter_drift'
            && error.details?.frozen?.expectedCount === 999
            && error.details?.observed?.expectedCount === 2
    );

    const after = await db.all(`SELECT id,personagem_nome,dinheiro FROM jogadores WHERE id IN ('a@lid','b@lid') ORDER BY id`);
    assert.deepEqual(after, before);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 0);
    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(journal.operation.status, 'planned');
    assert.equal(journal.operation.execution_token, null);
    assert.equal(journal.operation.expected_count, 999);
});

test('apply exige ownership exato do lock global antes de adquirir executor', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid', 'b@lid']);
    pinOperation(t, plan.operationId);
    await db.run(`DELETE FROM clover_global_player_reset_lock WHERE operation_id=?`, [plan.operationId]);

    const before = await db.all(`SELECT id,personagem_nome,dinheiro FROM jogadores WHERE id IN ('a@lid','b@lid') ORDER BY id`);
    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_cycle_lock_missing'
    );
    const after = await db.all(`SELECT id,personagem_nome,dinheiro FROM jogadores WHERE id IN ('a@lid','b@lid') ORDER BY id`);
    assert.deepEqual(after, before);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 0);
    const operation = await db.get(
        `SELECT status,execution_token FROM clover_global_player_reset_operations WHERE operation_id=?`,
        [plan.operationId]
    );
    assert.deepEqual(operation, { status: 'planned', execution_token: null });
});

test('preflight de coorte detecta drift antes da primeira mutação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid', 'b@lid']);
    pinOperation(t, plan.operationId);

    await db.run(`UPDATE jogadores SET dinheiro=999 WHERE id='b@lid'`);
    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_planned_state_drift' && error.details?.phase === 'cohort_preflight'
    );

    const a = await db.get(`SELECT personagem_nome,dinheiro FROM jogadores WHERE id='a@lid'`);
    const b = await db.get(`SELECT personagem_nome,dinheiro FROM jogadores WHERE id='b@lid'`);
    assert.deepEqual(a, { personagem_nome: 'Personagem A', dinheiro: 100 });
    assert.deepEqual(b, { personagem_nome: 'Personagem B', dinheiro: 999 });
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 0);

    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(journal.operation.status, 'paused');
    assert.equal(journal.items.find((item) => item.player_id === 'b@lid').status, 'failed');
});

test('resume reconcilia child commit existente e não duplica reset', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid', 'b@lid']);
    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    const first = journal.items[0];

    await db.run(
        `UPDATE clover_global_player_reset_items
         SET status='processing',attempt_count=1,started_at=CURRENT_TIMESTAMP
         WHERE operation_id=? AND player_id=?`,
        [plan.operationId, first.player_id]
    );
    const child = await resetPlayer(db, {
        playerId: first.player_id,
        reason: 'Reset global sintético de segurança',
        actorId: OWNER,
        operationCode: first.reset_operation_code,
    });
    assert.equal(child.ok, true);

    pinOperation(t, plan.operationId);
    const resumed = await applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.appliedCount, 2);
    assert.equal(resumed.reconciledCount, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 2);

    const final = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.deepEqual(final.items.map((item) => item.status), ['reconciled', 'applied']);
});

test('reconcile só opera em estado recuperável e recusa journal adulterado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid', 'b@lid']);

    await assert.rejects(
        reconcileGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_reconcile_invalid_status'
    );

    await db.run(
        `UPDATE clover_global_player_reset_operations SET status='paused' WHERE operation_id=?`,
        [plan.operationId]
    );
    await db.run(
        `UPDATE clover_global_player_reset_items
         SET planned_snapshot_sha256='CORROMPIDO'
         WHERE operation_id=? AND player_id='a@lid'`,
        [plan.operationId]
    );
    const before = await db.get(
        `SELECT status,population_hash,expected_count FROM clover_global_player_reset_operations WHERE operation_id=?`,
        [plan.operationId]
    );

    await assert.rejects(
        reconcileGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_population_journal_drift'
    );

    const after = await db.get(
        `SELECT status,population_hash,expected_count FROM clover_global_player_reset_operations WHERE operation_id=?`,
        [plan.operationId]
    );
    assert.deepEqual(after, before);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 0);
});

test('dry-run pode ser abortado e liberar o lock somente antes de qualquer mutação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid']);
    const aborted = await abortGlobalPlayerResetPlan(db, {
        operationId: plan.operationId,
        actorId: OWNER,
        reason: 'Replanejar população antes de executar',
    });
    assert.equal(aborted.status, 'aborted');

    const second = await planGlobalPlayerReset(db, {
        actorId: OWNER,
        reason: 'Novo dry-run após abort seguro',
        playerIds: ['b@lid'],
        selectionSource: 'fixture explícita do teste',
        operationId: 'GR-TESTE-0002',
    });
    assert.equal(second.ok, true);
});

test('abort recusa operação sem ownership do lock e não mascara inconsistência', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, ['a@lid']);
    await db.run(`DELETE FROM clover_global_player_reset_lock WHERE operation_id=?`, [plan.operationId]);

    await assert.rejects(
        abortGlobalPlayerResetPlan(db, {
            operationId: plan.operationId,
            actorId: OWNER,
            reason: 'Abort precisa respeitar lock canônico',
        }),
        (error) => error.code === 'global_reset_cycle_lock_missing'
    );

    const operation = await db.get(
        `SELECT status,aborted_at FROM clover_global_player_reset_operations WHERE operation_id=?`,
        [plan.operationId]
    );
    assert.deepEqual(operation, { status: 'planned', aborted_at: null });
});
