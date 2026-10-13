'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { criarBanco } = require('../database');
const {
    addPhInTransaction,
    ensurePhState,
    getPhSummary,
    spendPh,
} = require('../helpers/clover/phService');
const {
    addYullsInTransaction,
    getYullsSummary,
} = require('../helpers/clover/yullsService');
const {
    addCatalogItem,
    addCatalogItemInTransaction,
    ensureInventoryV1,
} = require('../helpers/clover/inventoryService');
const { recordEvaluationService } = require('../helpers/clover/adminService');
const { ensureAntiGhostSchema } = require('../helpers/clover/antiGhostService');
const {
    getQuickEvaluationIntegritySnapshot,
    preflightVoidQuickEvaluation,
    voidQuickEvaluation,
} = require('../helpers/clover/quickEvaluationIntegrityService');

async function makeDb() {
    const filename = path.join(
        os.tmpdir(),
        `clover-gate2-${process.pid}-${crypto.randomUUID()}.sqlite`
    );
    return criarBanco({ filename });
}

async function insertPlayer(db, id = '5511999999999@s.whatsapp.net') {
    await db.run(
        `INSERT INTO jogadores (id, nome, personagem_nome, dinheiro, estrelas, jogo_status)
         VALUES (?, 'Conta Teste', 'Aster', 0, 0, 'liberado')`,
        [id]
    );
    return id;
}

async function insertEvaluation(db, playerId, overrides = {}) {
    const inserted = await db.run(
        `INSERT INTO clover_quick_evaluations
         (message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
          ph_amount, yulls_amount, stars_amount, inventory_text, scene_sent_at,
          evaluated_at, week_key, bypass_weekly_limit, rewards_json, metadata_json)
         VALUES (?, 'on@g.us', ?, 'admin@s.whatsapp.net', ?, ?, ?, ?, ?, ?,
                 '2026-10-13 12:00:00', '2026-10-13 12:05:00', '2026-10-12', ?, '{}', '{}')`,
        [
            overrides.messageKey || `eval-${Date.now()}-${Math.random()}`,
            playerId,
            overrides.modalityKey || 'treino_solo',
            overrides.modalityLabel || 'Treino Solo',
            Number(overrides.ph || 0),
            Number(overrides.yulls || 0),
            Number(overrides.stars || 0),
            overrides.inventoryText || null,
            overrides.bypassWeeklyLimit ? 1 : 0,
        ]
    );
    return Number(inserted.lastID);
}

async function pickStackableTemplate(db) {
    await ensureInventoryV1(db);
    const row = await db.get(
        `SELECT template_key
         FROM clover_item_templates
         WHERE active = 1 AND stackable = 1 AND default_durability IS NULL
         ORDER BY template_key ASC LIMIT 1`
    );
    assert.ok(row?.template_key, 'catálogo precisa ter ao menos um item stackable para o teste');
    return row.template_key;
}

test('Gate 2 migrations 55/56 são canônicas e correções são imutáveis', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const versions = await db.all(
        `SELECT version, migration_key FROM clover_schema_migrations
         WHERE version IN (55, 56) ORDER BY version`
    );
    assert.deepEqual(versions.map((row) => Number(row.version)), [55, 56]);
    assert.deepEqual(versions.map((row) => row.migration_key), [
        '0055_scene_evaluation_integrity',
        '0056_scene_evaluation_void_accounting',
    ]);

    const playerId = await insertPlayer(db);
    const evaluationId = await insertEvaluation(db, playerId);
    const result = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'admin@s.whatsapp.net',
        reason: 'teste de imutabilidade',
    });
    assert.equal(result.ok, true, JSON.stringify(result.blockers || []));
    assert.ok(result.correction?.id);
    await assert.rejects(
        db.run(
            `UPDATE clover_quick_evaluation_corrections SET reason = 'alterado' WHERE id = ?`,
            [result.correction.id]
        ),
        /quick_evaluation_correction_immutable/
    );
});

test('manifesto captura inventário empilhado e void restaura todos os saldos atomicamente', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await ensurePhState(db, playerId);
    const phBefore = await getPhSummary(db, playerId);
    const yullsBefore = await getYullsSummary(db, playerId);
    const templateKey = await pickStackableTemplate(db);

    await addCatalogItem(db, playerId, templateKey, 2, {
        source: 'gate2_baseline',
        createdBy: 'system',
    });
    const baselineItem = await db.get(
        'SELECT * FROM clover_inventory_items WHERE player_id = ? AND template_key = ? ORDER BY id LIMIT 1',
        [playerId, templateKey]
    );
    assert.equal(Number(baselineItem.quantity), 2);

    const evaluationId = await insertEvaluation(db, playerId, {
        ph: 10,
        yulls: 250,
        stars: 3,
        inventoryText: templateKey,
    });

    await db.exec('BEGIN IMMEDIATE');
    await addPhInTransaction(
        db,
        playerId,
        10,
        'ficha_avaliacao',
        'Gate 2',
        'admin@s.whatsapp.net',
        { gate2: true },
        `quick_eval:${evaluationId}`
    );
    await addYullsInTransaction(
        db,
        playerId,
        250,
        'ficha_avaliacao',
        'Gate 2',
        'admin@s.whatsapp.net',
        {
            relatedId: `quick_eval:${evaluationId}`,
            idempotencyKey: `gate2:yulls:${evaluationId}`,
        }
    );
    await db.run('UPDATE jogadores SET estrelas = estrelas + 3 WHERE id = ?', [playerId]);
    await addCatalogItemInTransaction(db, playerId, templateKey, 2, {
        source: 'ficha_avaliacao',
        relatedId: `quick_eval:${evaluationId}`,
        createdBy: 'admin@s.whatsapp.net',
    });
    await db.exec('COMMIT');

    const stacked = await db.get(
        'SELECT * FROM clover_inventory_items WHERE id = ?',
        [baselineItem.id]
    );
    assert.equal(Number(stacked.quantity), 4);

    const snapshot = await getQuickEvaluationIntegritySnapshot(db, evaluationId);
    const types = snapshot.effects.map((effect) => effect.effect_type);
    assert.ok(types.includes('ph'));
    assert.ok(types.includes('yulls'));
    assert.ok(types.includes('player_stars'));
    assert.ok(types.includes('inventory_history'));
    const inventoryEffect = snapshot.effects.find((effect) => effect.effect_type === 'inventory_history');
    assert.equal(Number(inventoryEffect.amount), 2);

    const voided = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'admin@s.whatsapp.net',
        reason: 'ficha lançada no personagem errado',
    });
    assert.equal(voided.ok, true, JSON.stringify(voided.blockers || []));
    assert.equal(voided.duplicate, false);

    const evaluation = await db.get('SELECT * FROM clover_quick_evaluations WHERE id = ?', [evaluationId]);
    assert.equal(evaluation.status, 'voided');
    assert.equal(Number(evaluation.bypass_weekly_limit), 1);
    assert.equal(Number(JSON.parse(evaluation.metadata_json).voided_by_correction), 1);

    const phAfter = await getPhSummary(db, playerId);
    const yullsAfter = await getYullsSummary(db, playerId);
    const playerAfter = await db.get('SELECT estrelas FROM jogadores WHERE id = ?', [playerId]);
    const itemAfter = await db.get('SELECT quantity FROM clover_inventory_items WHERE id = ?', [baselineItem.id]);
    assert.equal(phAfter.phAvailable, phBefore.phAvailable);
    assert.equal(phAfter.phAccumulated, phBefore.phAccumulated);
    assert.equal(yullsAfter.balance, yullsBefore.balance);
    assert.equal(Number(playerAfter.estrelas), 0);
    assert.equal(Number(itemAfter.quantity), 2);

    const effectsAfter = await db.all(
        'SELECT status FROM clover_quick_evaluation_effects WHERE evaluation_id = ?',
        [evaluationId]
    );
    assert.ok(effectsAfter.length >= 4);
    assert.ok(effectsAfter.every((effect) => effect.status === 'reversed'));

    const duplicate = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'admin@s.whatsapp.net',
        reason: 'segunda tentativa',
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    const corrections = await db.get(
        'SELECT COUNT(*) AS total FROM clover_quick_evaluation_corrections WHERE evaluation_id = ?',
        [evaluationId]
    );
    assert.equal(Number(corrections.total), 1);
});

test('PH já gasto bloqueia o pacote inteiro sem meio-estorno', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await ensurePhState(db, playerId);
    const evaluationId = await insertEvaluation(db, playerId, { ph: 10, yulls: 100 });

    await db.exec('BEGIN IMMEDIATE');
    await addPhInTransaction(db, playerId, 10, 'ficha_avaliacao', 'Gate 2', 'admin', {}, `quick_eval:${evaluationId}`);
    await addYullsInTransaction(db, playerId, 100, 'ficha_avaliacao', 'Gate 2', 'admin', {
        relatedId: `quick_eval:${evaluationId}`,
        idempotencyKey: `gate2:block:yulls:${evaluationId}`,
    });
    await db.exec('COMMIT');
    await spendPh(db, playerId, 20, 'gate2_test', 'gasto posterior', 'player');

    const yullsBefore = await getYullsSummary(db, playerId);
    const result = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'admin',
        reason: 'tentativa bloqueada',
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.ok(result.blockers.some((blocker) => blocker.code === 'ph_already_spent'));
    const evaluation = await db.get('SELECT status FROM clover_quick_evaluations WHERE id = ?', [evaluationId]);
    assert.equal(evaluation.status, 'applied');
    const yullsAfter = await getYullsSummary(db, playerId);
    assert.equal(yullsAfter.balance, yullsBefore.balance);
    const reversal = await db.get(
        `SELECT COUNT(*) AS total FROM clover_ph_ledger
         WHERE source = 'quick_evaluation_void' AND related_id = ?`,
        [`quick_eval_void:${evaluationId}`]
    );
    assert.equal(Number(reversal.total), 0);
});

test('serviço ADM pago bloqueia anulação sem alterar a avaliação', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    const evaluationId = await insertEvaluation(db, playerId, { modalityKey: 'treino_solo', modalityLabel: 'Treino Solo' });
    const service = await recordEvaluationService(db, {
        evaluatorId: 'admin@s.whatsapp.net',
        evaluationId,
        targetPlayerId: playerId,
        modalityKey: 'treino_solo',
        modalityLabel: 'Treino Solo',
        sceneWeekKey: '2026-10-12',
        sceneSentAt: '2026-10-13 12:00:00',
        evaluatedAt: '2026-10-13 12:05:00',
        chatId: 'on@g.us',
    });
    assert.equal(service.ok, true);
    await db.run(
        `UPDATE clover_admin_service_entries
         SET status = 'paid', paid_points = points
         WHERE evaluation_id = ?`,
        [evaluationId]
    );

    const result = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'owner',
        reason: 'corrigir avaliação',
    });
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((blocker) => blocker.code === 'admin_service_already_settled'));
    const evaluation = await db.get('SELECT status FROM clover_quick_evaluations WHERE id = ?', [evaluationId]);
    assert.equal(evaluation.status, 'applied');
});

test('efeito de recrutamento é bloqueador fail-closed', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    const evaluationId = await insertEvaluation(db, playerId);
    await db.run(
        `INSERT INTO clover_quick_evaluation_effects
         (evaluation_id, effect_type, effect_ref, status, idempotency_key, metadata_json)
         VALUES (?, 'recruitment', '77', 'applied', ?, '{}')`,
        [evaluationId, `quick-eval:${evaluationId}:recruitment:77`]
    );

    const preflight = await preflightVoidQuickEvaluation(db, evaluationId);
    assert.equal(preflight.ok, false);
    assert.ok(preflight.blockers.some((blocker) => blocker.code === 'recruitment_requires_manual_reconciliation'));
    const result = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'owner',
        reason: 'não deve passar',
    });
    assert.equal(result.ok, false);
    const evaluation = await db.get('SELECT status FROM clover_quick_evaluations WHERE id = ?', [evaluationId]);
    assert.equal(evaluation.status, 'applied');
});

test('bônus de retorno é revertido junto e volta ao estado reutilizável', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await ensurePhState(db, playerId);
    await ensureAntiGhostSchema(db);
    const phBefore = await getPhSummary(db, playerId);
    const evaluationId = await insertEvaluation(db, playerId);

    const bonusInsert = await db.run(
        `INSERT INTO clover_return_bonuses
         (player_id, status, bonus_label, bonus_ph, outside_weekly_limit,
          offered_at, expires_at, fulfilled_at, evaluation_id, created_by)
         VALUES (?, 'fulfilled', 'Retorno', 5, 1,
                 CURRENT_TIMESTAMP, '2099-01-01 00:00:00', CURRENT_TIMESTAMP, ?, 'system')`,
        [playerId, evaluationId]
    );
    const bonusId = Number(bonusInsert.lastID);

    await db.exec('BEGIN IMMEDIATE');
    await addPhInTransaction(
        db,
        playerId,
        5,
        'return_bonus',
        'Bônus de retorno',
        'system',
        { evaluation_id: evaluationId, bonus_id: bonusId },
        `return_bonus:${bonusId}:eval:${evaluationId}`
    );
    await db.exec('COMMIT');

    const snapshot = await getQuickEvaluationIntegritySnapshot(db, evaluationId);
    assert.ok(snapshot.effects.some((effect) => effect.effect_type === 'return_bonus_ph'));

    const result = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'owner',
        reason: 'avaliação inválida',
    });
    assert.equal(result.ok, true, JSON.stringify(result.blockers || []));
    const bonus = await db.get('SELECT * FROM clover_return_bonuses WHERE id = ?', [bonusId]);
    assert.equal(bonus.status, 'active');
    assert.equal(bonus.evaluation_id, null);
    assert.equal(bonus.fulfilled_at, null);
    const phAfter = await getPhSummary(db, playerId);
    assert.equal(phAfter.phAvailable, phBefore.phAvailable);
    assert.equal(phAfter.phAccumulated, phBefore.phAccumulated);
});

test('falha no fim da transação desfaz todos os estornos', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    const evaluationId = await insertEvaluation(db, playerId, { stars: 3 });
    await db.run('UPDATE jogadores SET estrelas = estrelas + 3 WHERE id = ?', [playerId]);
    const preflight = await preflightVoidQuickEvaluation(db, evaluationId);
    assert.equal(preflight.ok, true, JSON.stringify(preflight.blockers || []));
    await db.exec(`
        CREATE TRIGGER gate2_force_correction_failure
        BEFORE INSERT ON clover_quick_evaluation_corrections
        BEGIN
            SELECT RAISE(ABORT, 'gate2_forced_failure');
        END
    `);

    await assert.rejects(
        voidQuickEvaluation(db, evaluationId, {
            actorId: 'owner',
            reason: 'forçar rollback',
        }),
        /gate2_forced_failure/
    );

    const evaluation = await db.get('SELECT status FROM clover_quick_evaluations WHERE id = ?', [evaluationId]);
    const player = await db.get('SELECT estrelas FROM jogadores WHERE id = ?', [playerId]);
    const effects = await db.all('SELECT status FROM clover_quick_evaluation_effects WHERE evaluation_id = ?', [evaluationId]);
    assert.equal(evaluation.status, 'applied');
    assert.equal(Number(player.estrelas), 3);
    assert.ok(effects.every((effect) => effect.status === 'applied'));
});