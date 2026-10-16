'use strict';

const { tableExists } = require('./schemaMigrationService');
const { appendPhLedgerEntryInTransaction } = require('./phService');
const { spendYullsInTransaction } = require('./yullsService');
const { consumeInventoryItemInTransaction } = require('./inventoryService');

const KNOWN_EFFECT_TYPES = new Set([
    'ph',
    'return_bonus_ph',
    'yulls',
    'player_stars',
    'inventory_history',
    'squad_stars',
    'admin_service',
    'antighost_event',
    'recruitment',
]);

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function asPositiveInteger(value) {
    const number = Number(value || 0);
    return Number.isInteger(number) && number > 0 ? number : 0;
}

function effectKey(evaluationId, type, ref) {
    return `quick-eval:${evaluationId}:${type}:${ref}`;
}

async function assertIntegritySchema(db) {
    const required = [
        'clover_quick_evaluations',
        'clover_quick_evaluation_effects',
        'clover_quick_evaluation_corrections',
    ];
    for (const table of required) {
        if (!await tableExists(db, table)) {
            const error = new Error(`Schema de integridade da avaliação ausente: ${table}.`);
            error.code = 'quick_evaluation_integrity_schema_missing';
            error.table = table;
            throw error;
        }
    }
}

async function insertEffect(db, evaluationId, type, ref, amount = null, metadata = {}) {
    const cleanRef = String(ref ?? '').trim();
    if (!cleanRef) return false;
    const result = await db.run(
        `INSERT OR IGNORE INTO clover_quick_evaluation_effects
         (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
         VALUES (?, ?, ?, ?, 'applied', ?, ?)`,
        [
            evaluationId,
            type,
            cleanRef,
            amount === null || amount === undefined ? null : Number(amount),
            effectKey(evaluationId, type, cleanRef),
            JSON.stringify(metadata || {}),
        ]
    );
    return Number(result?.changes || 0) > 0;
}

async function reconcileQuickEvaluationEffectsInTransaction(db, evaluationId) {
    await assertIntegritySchema(db);
    const evaluation = await db.get(
        'SELECT * FROM clover_quick_evaluations WHERE id = ?',
        [evaluationId]
    );
    if (!evaluation) {
        const error = new Error('Avaliação de cena não encontrada.');
        error.code = 'quick_evaluation_not_found';
        throw error;
    }

    if (asPositiveInteger(evaluation.stars_amount) > 0) {
        await insertEffect(
            db,
            evaluation.id,
            'player_stars',
            evaluation.player_id,
            asPositiveInteger(evaluation.stars_amount),
            {}
        );
    }

    const directRelatedId = `quick_eval:${evaluation.id}`;

    if (await tableExists(db, 'clover_ph_ledger')) {
        const directPh = await db.all(
            `SELECT id, amount, metadata_json
             FROM clover_ph_ledger
             WHERE related_id = ? AND amount > 0
             ORDER BY id ASC`,
            [directRelatedId]
        );
        for (const row of directPh) {
            await insertEffect(db, evaluation.id, 'ph', row.id, row.amount, safeJsonParse(row.metadata_json));
        }

        const returnBonusRows = await db.all(
            `SELECT id, amount, metadata_json
             FROM clover_ph_ledger
             WHERE source = 'return_bonus' AND amount > 0
             ORDER BY id ASC`
        );
        for (const row of returnBonusRows) {
            const metadata = safeJsonParse(row.metadata_json);
            if (Number(metadata.evaluation_id) !== Number(evaluation.id)) continue;
            await insertEffect(db, evaluation.id, 'return_bonus_ph', row.id, row.amount, {
                bonus_id: metadata.bonus_id ?? null,
            });
        }
    }

    if (await tableExists(db, 'clover_yulls_ledger')) {
        const rows = await db.all(
            `SELECT id, amount, metadata_json
             FROM clover_yulls_ledger
             WHERE related_id = ? AND amount > 0
             ORDER BY id ASC`,
            [directRelatedId]
        );
        for (const row of rows) {
            await insertEffect(db, evaluation.id, 'yulls', row.id, row.amount, safeJsonParse(row.metadata_json));
        }
    }

    if (await tableExists(db, 'clover_inventory_item_history')) {
        const rows = await db.all(
            `SELECT id, item_id, quantity_delta, metadata_json
             FROM clover_inventory_item_history
             WHERE related_id = ? AND quantity_delta > 0
             ORDER BY id ASC`,
            [directRelatedId]
        );
        for (const row of rows) {
            await insertEffect(db, evaluation.id, 'inventory_history', row.id, row.quantity_delta, {
                ...safeJsonParse(row.metadata_json),
                item_id: row.item_id,
            });
        }
    }

    if (await tableExists(db, 'clover_squad_star_transactions')) {
        const rows = await db.all(
            `SELECT id, amount, squad_key, season_id, player_id, metadata_json
             FROM clover_squad_star_transactions
             WHERE related_id = ? AND amount > 0
             ORDER BY id ASC`,
            [directRelatedId]
        );
        for (const row of rows) {
            await insertEffect(db, evaluation.id, 'squad_stars', row.id, row.amount, {
                ...safeJsonParse(row.metadata_json),
                squad_key: row.squad_key,
                season_id: row.season_id,
                player_id: row.player_id,
            });
        }
    }

    if (await tableExists(db, 'clover_admin_service_entries')) {
        const rows = await db.all(
            `SELECT id, points, paid_points, status
             FROM clover_admin_service_entries
             WHERE evaluation_id = ?
             ORDER BY id ASC`,
            [evaluation.id]
        );
        for (const row of rows) {
            await insertEffect(db, evaluation.id, 'admin_service', row.id, row.points, {
                paid_points: Number(row.paid_points || 0),
                service_status: row.status,
            });
        }
    }

    if (await tableExists(db, 'clover_antighost_events')) {
        const rows = await db.all(
            `SELECT id, metadata_json
             FROM clover_antighost_events
             WHERE player_id = ? AND event_type = 'evaluation'
             ORDER BY id ASC`,
            [evaluation.player_id]
        );
        for (const row of rows) {
            const metadata = safeJsonParse(row.metadata_json);
            if (Number(metadata.evaluation_id) !== Number(evaluation.id)) continue;
            await insertEffect(db, evaluation.id, 'antighost_event', row.id, null, {});
        }
    }

    if (await tableExists(db, 'clover_recruitment_referrals')) {
        const rows = await db.all(
            `SELECT id, status
             FROM clover_recruitment_referrals
             WHERE validation_evaluation_id = ?
             ORDER BY id ASC`,
            [evaluation.id]
        );
        for (const row of rows) {
            await insertEffect(db, evaluation.id, 'recruitment', row.id, null, {
                referral_status: row.status,
            });
        }
    }

    return evaluation;
}

async function readEffects(db, evaluationId) {
    return db.all(
        `SELECT * FROM clover_quick_evaluation_effects
         WHERE evaluation_id = ?
         ORDER BY id ASC`,
        [evaluationId]
    );
}

function addBlocker(blockers, code, message, details = {}) {
    blockers.push({ code, message, ...details });
}

async function buildVoidPlanInTransaction(db, evaluation, effects) {
    const blockers = [];
    const appliedEffects = effects.filter((effect) => effect.status === 'applied');
    const unexpected = effects.filter((effect) => !['applied', 'reversed'].includes(effect.status));
    for (const effect of unexpected) {
        addBlocker(blockers, 'effect_not_stable', 'Há efeito em estado intermediário e a avaliação não pode ser anulada.', {
            effectId: effect.id,
            effectType: effect.effect_type,
            status: effect.status,
        });
    }
    for (const effect of appliedEffects) {
        if (!KNOWN_EFFECT_TYPES.has(effect.effect_type)) {
            addBlocker(blockers, 'unknown_effect_type', 'Há um efeito sem adaptador de estorno seguro.', {
                effectId: effect.id,
                effectType: effect.effect_type,
            });
        }
    }

    const phEffects = appliedEffects.filter((effect) => ['ph', 'return_bonus_ph'].includes(effect.effect_type));
    const phTotal = phEffects.reduce((sum, effect) => sum + asPositiveInteger(effect.amount), 0);
    if (phTotal > 0) {
        const stats = await db.get(
            `SELECT ph_available, ph_accumulated
             FROM clover_character_stats WHERE player_id = ?`,
            [evaluation.player_id]
        );
        if (!stats) {
            addBlocker(blockers, 'ph_state_missing', 'Estado de PH ausente; estorno automático bloqueado.');
        } else if (
            Number(stats.ph_available || 0) < phTotal
            || Number(stats.ph_accumulated || 0) < phTotal
        ) {
            addBlocker(blockers, 'ph_already_spent', 'O PH atual não comporta retirar tudo que esta avaliação concedeu.', {
                required: phTotal,
                available: Number(stats.ph_available || 0),
                accumulated: Number(stats.ph_accumulated || 0),
            });
        }
    }

    const yullsEffects = appliedEffects.filter((effect) => effect.effect_type === 'yulls');
    const yullsTotal = yullsEffects.reduce((sum, effect) => sum + asPositiveInteger(effect.amount), 0);
    if (yullsTotal > 0) {
        const player = await db.get('SELECT COALESCE(dinheiro, 0) AS dinheiro FROM jogadores WHERE id = ?', [evaluation.player_id]);
        let reserved = 0;
        if (await tableExists(db, 'clover_yulls_reservations')) {
            const row = await db.get(
                `SELECT COALESCE(SUM(amount), 0) AS total
                 FROM clover_yulls_reservations
                 WHERE player_id = ? AND status = 'active'
                   AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`,
                [evaluation.player_id]
            );
            reserved = Number(row?.total || 0);
        }
        const balance = Number(player?.dinheiro || 0);
        if (!player || balance - reserved < yullsTotal) {
            addBlocker(blockers, 'yulls_unavailable', 'O saldo disponível de Yulls não comporta o estorno integral.', {
                required: yullsTotal,
                balance,
                reserved,
            });
        }
    }

    const playerStarEffects = appliedEffects.filter((effect) => effect.effect_type === 'player_stars');
    const playerStarsTotal = playerStarEffects.reduce((sum, effect) => sum + asPositiveInteger(effect.amount), 0);
    if (playerStarsTotal > 0) {
        const player = await db.get('SELECT COALESCE(estrelas, 0) AS estrelas FROM jogadores WHERE id = ?', [evaluation.player_id]);
        if (!player || Number(player.estrelas || 0) < playerStarsTotal) {
            addBlocker(blockers, 'player_stars_unavailable', 'As Estrelas atuais do jogador não comportam o estorno integral.', {
                required: playerStarsTotal,
                current: Number(player?.estrelas || 0),
            });
        }
    }

    const inventoryEffects = appliedEffects.filter((effect) => effect.effect_type === 'inventory_history');
    const inventoryPlan = [];
    const inventoryTotals = new Map();
    for (const effect of inventoryEffects) {
        const history = await db.get(
            `SELECT * FROM clover_inventory_item_history
             WHERE id = ? AND player_id = ?`,
            [effect.effect_ref, evaluation.player_id]
        );
        if (!history || history.related_id !== `quick_eval:${evaluation.id}` || Number(history.quantity_delta || 0) <= 0) {
            addBlocker(blockers, 'inventory_provenance_mismatch', 'Não foi possível provar a origem de um item da avaliação.', {
                effectId: effect.id,
                historyId: effect.effect_ref,
            });
            continue;
        }
        const itemId = Number(history.item_id || 0);
        const quantity = Number(history.quantity_delta || 0);
        inventoryPlan.push({ effect, history, itemId, quantity });
        inventoryTotals.set(itemId, (inventoryTotals.get(itemId) || 0) + quantity);
    }
    for (const [itemId, required] of inventoryTotals.entries()) {
        const item = await db.get(
            'SELECT id, quantity FROM clover_inventory_items WHERE id = ? AND player_id = ?',
            [itemId, evaluation.player_id]
        );
        let reserved = 0;
        if (item && await tableExists(db, 'clover_inventory_reservations')) {
            const row = await db.get(
                `SELECT COALESCE(SUM(quantity), 0) AS total
                 FROM clover_inventory_reservations
                 WHERE inventory_item_id = ? AND status = 'active'
                   AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`,
                [itemId]
            );
            reserved = Number(row?.total || 0);
        }
        if (!item || Number(item.quantity || 0) - reserved < required) {
            addBlocker(blockers, 'inventory_unavailable', 'O inventário atual não comporta retirar exatamente os itens concedidos pela avaliação.', {
                itemId,
                required,
                owned: Number(item?.quantity || 0),
                reserved,
            });
        }
    }

    const squadEffects = appliedEffects.filter((effect) => effect.effect_type === 'squad_stars');
    const squadPlan = [];
    const squadTotals = new Map();
    for (const effect of squadEffects) {
        const transaction = await db.get(
            `SELECT * FROM clover_squad_star_transactions
             WHERE id = ?`,
            [effect.effect_ref]
        );
        if (
            !transaction
            || transaction.related_id !== `quick_eval:${evaluation.id}`
            || transaction.kind !== 'grant'
            || Number(transaction.amount || 0) <= 0
        ) {
            addBlocker(blockers, 'squad_star_provenance_mismatch', 'Não foi possível provar a origem de Estrelas de esquadrão.', {
                effectId: effect.id,
                transactionId: effect.effect_ref,
            });
            continue;
        }
        const amount = Number(transaction.amount || 0);
        squadPlan.push({ effect, transaction, amount });
        const aggregateKey = `${transaction.squad_key}\u0000${transaction.season_id || ''}`;
        const current = squadTotals.get(aggregateKey) || {
            squadKey: transaction.squad_key,
            seasonId: transaction.season_id,
            amount: 0,
        };
        current.amount += amount;
        squadTotals.set(aggregateKey, current);
    }
    for (const aggregate of squadTotals.values()) {
        const squad = await db.get(
            'SELECT current_stars, historical_stars FROM clover_squads WHERE squad_key = ?',
            [aggregate.squadKey]
        );
        const season = aggregate.seasonId
            ? await db.get(
                `SELECT season_stars FROM clover_squad_season_stars
                 WHERE squad_key = ? AND season_id = ?`,
                [aggregate.squadKey, aggregate.seasonId]
            )
            : null;
        if (
            !squad
            || Number(squad.current_stars || 0) < aggregate.amount
            || Number(squad.historical_stars || 0) < aggregate.amount
            || (aggregate.seasonId && (!season || Number(season.season_stars || 0) < aggregate.amount))
        ) {
            addBlocker(blockers, 'squad_stars_unavailable', 'As Estrelas do esquadrão não comportam o estorno integral.', aggregate);
        }
    }

    const adminEffects = appliedEffects.filter((effect) => effect.effect_type === 'admin_service');
    const adminPlan = [];
    for (const effect of adminEffects) {
        const entry = await db.get(
            'SELECT * FROM clover_admin_service_entries WHERE id = ? AND evaluation_id = ?',
            [effect.effect_ref, evaluation.id]
        );
        if (!entry) {
            addBlocker(blockers, 'admin_service_missing', 'Registro de serviço ADM da avaliação não foi encontrado.', {
                effectId: effect.id,
            });
            continue;
        }
        if (entry.status !== 'pending' || Number(entry.paid_points || 0) !== 0) {
            addBlocker(blockers, 'admin_service_already_settled', 'O serviço ADM desta avaliação já foi liquidado e exige reconciliação manual.', {
                serviceEntryId: entry.id,
                status: entry.status,
                paidPoints: Number(entry.paid_points || 0),
            });
            continue;
        }
        adminPlan.push({ effect, entry });
    }

    const returnBonusPlan = [];
    for (const effect of phEffects.filter((item) => item.effect_type === 'return_bonus_ph')) {
        const metadata = safeJsonParse(effect.metadata_json);
        let bonusId = Number(metadata.bonus_id || 0);
        if (!bonusId) {
            const ledger = await db.get('SELECT metadata_json FROM clover_ph_ledger WHERE id = ?', [effect.effect_ref]);
            bonusId = Number(safeJsonParse(ledger?.metadata_json).bonus_id || 0);
        }
        const bonus = bonusId && await tableExists(db, 'clover_return_bonuses')
            ? await db.get('SELECT * FROM clover_return_bonuses WHERE id = ?', [bonusId])
            : null;
        if (!bonus || Number(bonus.evaluation_id || 0) !== Number(evaluation.id) || bonus.status !== 'fulfilled') {
            addBlocker(blockers, 'return_bonus_state_mismatch', 'O bônus de retorno não está em um estado reversível comprovável.', {
                bonusId: bonusId || null,
                effectId: effect.id,
            });
            continue;
        }
        returnBonusPlan.push({ effect, bonus });
    }

    const recruitmentEffects = appliedEffects.filter((effect) => effect.effect_type === 'recruitment');
    for (const effect of recruitmentEffects) {
        addBlocker(blockers, 'recruitment_requires_manual_reconciliation', 'Esta avaliação validou um recrutamento; o estorno automático foi bloqueado para não retirar recompensas de terceiros no escuro.', {
            referralId: Number(effect.effect_ref),
        });
    }

    return {
        ok: blockers.length === 0,
        blockers,
        evaluation,
        effects,
        appliedEffects,
        phEffects,
        phTotal,
        yullsEffects,
        yullsTotal,
        playerStarEffects,
        playerStarsTotal,
        inventoryPlan,
        squadPlan,
        adminPlan,
        returnBonusPlan,
        antighostEffects: appliedEffects.filter((effect) => effect.effect_type === 'antighost_event'),
    };
}

async function recomputeAntiGhostActivityInTransaction(db, playerId, evaluationId, actorId) {
    if (!await tableExists(db, 'clover_antighost_activity')) return;
    const activity = await db.get('SELECT * FROM clover_antighost_activity WHERE player_id = ?', [playerId]);
    if (!activity) return;

    const lastEvaluation = await db.get(
        `SELECT MAX(COALESCE(scene_sent_at, evaluated_at, created_at)) AS value
         FROM clover_quick_evaluations
         WHERE player_id = ? AND status = 'applied'`,
        [playerId]
    );
    const candidates = [
        ['on_message', activity.last_on_message_at],
        ['off_message', activity.last_off_message_at],
        ['command', activity.last_command_at],
        ['evaluation', lastEvaluation?.value || null],
        ['community', activity.last_community_seen_at],
    ].filter((entry) => entry[1]);
    candidates.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    const latest = candidates[0] || [null, null];

    await db.run(
        `UPDATE clover_antighost_activity
         SET last_evaluation_at = ?,
             last_activity_at = ?,
             last_activity_kind = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [lastEvaluation?.value || null, latest[1], latest[0], playerId]
    );

    if (await tableExists(db, 'clover_antighost_events')) {
        await db.run(
            `INSERT INTO clover_antighost_events
             (player_id, event_type, occurred_at, metadata_json)
             VALUES (?, 'evaluation_voided', CURRENT_TIMESTAMP, ?)`,
            [playerId, JSON.stringify({ evaluation_id: evaluationId, actor_id: actorId })]
        );
    }
}

async function applySquadStarReversalInTransaction(db, item, evaluationId, actorId, reason) {
    const { transaction, amount } = item;
    await db.run(
        `UPDATE clover_squads
         SET current_stars = current_stars - ?,
             historical_stars = historical_stars - ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [amount, amount, transaction.squad_key]
    );
    if (transaction.season_id) {
        await db.run(
            `UPDATE clover_squad_season_stars
             SET season_stars = season_stars - ?, updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ? AND season_id = ?`,
            [amount, transaction.squad_key, transaction.season_id]
        );
    }

    const transactionKey = `quick-eval:void:${evaluationId}:squad-stars:${transaction.id}`;
    const inserted = await db.run(
        `INSERT INTO clover_squad_star_transactions
         (transaction_key, squad_key, season_id, player_id, amount, kind, source,
          reason, related_id, created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'adjustment', 'quick_evaluation_void', ?, ?, ?, ?)`,
        [
            transactionKey,
            transaction.squad_key,
            transaction.season_id,
            transaction.player_id,
            -amount,
            reason,
            `quick_eval_void:${evaluationId}`,
            actorId,
            JSON.stringify({ original_transaction_id: transaction.id, evaluation_id: evaluationId }),
        ]
    );

    if (await tableExists(db, 'clover_squad_star_ledger')) {
        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, evaluation_id, amount, kind, source, reason,
              created_by, created_at, metadata_json)
             VALUES (?, ?, ?, ?, 'ganho', 'quick_evaluation_void', ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                transaction.squad_key,
                transaction.player_id,
                evaluationId,
                -amount,
                reason,
                actorId,
                JSON.stringify({
                    original_transaction_id: transaction.id,
                    native_transaction_id: inserted.lastID,
                    reversal: true,
                }),
            ]
        );
    }
}

async function getQuickEvaluationIntegritySnapshot(db, evaluationId) {
    await assertIntegritySchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const evaluation = await reconcileQuickEvaluationEffectsInTransaction(db, evaluationId);
        const effects = await readEffects(db, evaluationId);
        const corrections = await db.all(
            `SELECT * FROM clover_quick_evaluation_corrections
             WHERE evaluation_id = ? ORDER BY id ASC`,
            [evaluationId]
        );
        await db.exec('ROLLBACK');
        return { evaluation, effects, corrections };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function preflightVoidQuickEvaluation(db, evaluationId) {
    await assertIntegritySchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const evaluation = await reconcileQuickEvaluationEffectsInTransaction(db, evaluationId);
        if (evaluation.status === 'voided') {
            const correction = await db.get(
                `SELECT * FROM clover_quick_evaluation_corrections
                 WHERE evaluation_id = ? AND correction_type = 'void'
                 ORDER BY id DESC LIMIT 1`,
                [evaluation.id]
            );
            await db.exec('ROLLBACK');
            return { ok: true, duplicate: true, evaluation, correction, blockers: [] };
        }
        const effects = await readEffects(db, evaluation.id);
        const plan = await buildVoidPlanInTransaction(db, evaluation, effects);
        await db.exec('ROLLBACK');
        return plan;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function voidQuickEvaluation(db, evaluationId, { actorId, reason } = {}) {
    const actor = String(actorId || '').trim();
    const why = String(reason || '').trim();
    if (!actor) {
        const error = new Error('Informe quem está anulando a avaliação.');
        error.code = 'missing_void_actor';
        throw error;
    }
    if (!why) {
        const error = new Error('Informe o motivo da anulação.');
        error.code = 'missing_void_reason';
        throw error;
    }

    await assertIntegritySchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const evaluation = await reconcileQuickEvaluationEffectsInTransaction(db, evaluationId);
        if (evaluation.status === 'voided') {
            const correction = await db.get(
                `SELECT * FROM clover_quick_evaluation_corrections
                 WHERE evaluation_id = ? AND correction_type = 'void'
                 ORDER BY id DESC LIMIT 1`,
                [evaluation.id]
            );
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, evaluation, correction, deliveryIntent: null };
        }

        const effects = await readEffects(db, evaluation.id);
        const plan = await buildVoidPlanInTransaction(db, evaluation, effects);
        if (!plan.ok) {
            await db.exec('ROLLBACK');
            return { ok: false, blocked: true, blockers: plan.blockers, evaluation };
        }

        const before = {
            evaluation_status: evaluation.status,
            effects: plan.appliedEffects.map((effect) => ({
                id: effect.id,
                type: effect.effect_type,
                ref: effect.effect_ref,
                amount: effect.amount,
            })),
        };

        if (plan.phTotal > 0) {
            const existing = await db.get(
                `SELECT id FROM clover_ph_ledger
                 WHERE player_id = ? AND source = 'quick_evaluation_void' AND related_id = ?
                 LIMIT 1`,
                [evaluation.player_id, `quick_eval_void:${evaluation.id}`]
            );
            if (!existing) {
                await appendPhLedgerEntryInTransaction(db, evaluation.player_id, {
                    amount: -plan.phTotal,
                    kind: 'estorno',
                    source: 'quick_evaluation_void',
                    reason: why,
                    relatedId: `quick_eval_void:${evaluation.id}`,
                    createdBy: actor,
                    metadata: {
                        evaluation_id: evaluation.id,
                        accumulated_delta: -plan.phTotal,
                        available_delta: -plan.phTotal,
                        original_ledger_ids: plan.phEffects.map((effect) => Number(effect.effect_ref)),
                    },
                });
            }
        }

        if (plan.yullsTotal > 0) {
            await spendYullsInTransaction(
                db,
                evaluation.player_id,
                plan.yullsTotal,
                'quick_evaluation_void',
                why,
                actor,
                {
                    relatedId: `quick_eval_void:${evaluation.id}`,
                    idempotencyKey: `yulls:quick_eval_void:${evaluation.id}`,
                    metadata: {
                        evaluation_id: evaluation.id,
                        original_ledger_ids: plan.yullsEffects.map((effect) => Number(effect.effect_ref)),
                    },
                }
            );
        }

        if (plan.playerStarsTotal > 0) {
            await db.run(
                `UPDATE jogadores
                 SET estrelas = estrelas - ?
                 WHERE id = ?`,
                [plan.playerStarsTotal, evaluation.player_id]
            );
        }

        for (const item of plan.inventoryPlan) {
            await consumeInventoryItemInTransaction(
                db,
                { id: item.itemId },
                item.quantity,
                {
                    action: 'estorno_avaliacao',
                    source: 'quick_evaluation_void',
                    relatedId: `quick_eval_void:${evaluation.id}`,
                    idempotencyKey: `quick-eval:void:${evaluation.id}:inventory-history:${item.history.id}`,
                    createdBy: actor,
                    metadata: {
                        evaluation_id: evaluation.id,
                        original_history_id: item.history.id,
                    },
                }
            );
        }

        for (const item of plan.squadPlan) {
            await applySquadStarReversalInTransaction(db, item, evaluation.id, actor, why);
        }

        for (const item of plan.adminPlan) {
            const updated = await db.run(
                `UPDATE clover_admin_service_entries
                 SET status = 'void', voided_at = CURRENT_TIMESTAMP, voided_by = ?, reason = ?
                 WHERE id = ? AND evaluation_id = ? AND status = 'pending' AND COALESCE(paid_points, 0) = 0`,
                [actor, why, item.entry.id, evaluation.id]
            );
            if (Number(updated?.changes || 0) !== 1) {
                const error = new Error('O serviço ADM mudou durante o estorno.');
                error.code = 'admin_service_race';
                throw error;
            }
        }

        for (const item of plan.returnBonusPlan) {
            const updated = await db.run(
                `UPDATE clover_return_bonuses
                 SET status = CASE
                         WHEN datetime(expires_at) > CURRENT_TIMESTAMP THEN 'active'
                         ELSE 'expired'
                     END,
                     fulfilled_at = NULL,
                     evaluation_id = NULL,
                     scene_message_key = NULL,
                     scene_sent_at = NULL
                 WHERE id = ? AND evaluation_id = ? AND status = 'fulfilled'`,
                [item.bonus.id, evaluation.id]
            );
            if (Number(updated?.changes || 0) !== 1) {
                const error = new Error('O bônus de retorno mudou durante o estorno.');
                error.code = 'return_bonus_race';
                throw error;
            }
        }

        const evaluationUpdate = await db.run(
            `UPDATE clover_quick_evaluations
             SET status = 'voided', voided_at = CURRENT_TIMESTAMP, voided_by = ?, void_reason = ?
             WHERE id = ? AND status = 'applied'`,
            [actor, why, evaluation.id]
        );
        if (Number(evaluationUpdate?.changes || 0) !== 1) {
            const error = new Error('A avaliação mudou durante o estorno.');
            error.code = 'quick_evaluation_void_race';
            throw error;
        }

        await recomputeAntiGhostActivityInTransaction(db, evaluation.player_id, evaluation.id, actor);

        await db.run(
            `UPDATE clover_quick_evaluation_effects
             SET status = 'reversed', reversed_at = CURRENT_TIMESTAMP, reversed_by = ?
             WHERE evaluation_id = ? AND status = 'applied'`,
            [actor, evaluation.id]
        );

        const after = {
            evaluation_status: 'voided',
            reversed_effect_count: plan.appliedEffects.length,
            ph_reversed: plan.phTotal,
            yulls_reversed: plan.yullsTotal,
            player_stars_reversed: plan.playerStarsTotal,
            inventory_effects_reversed: plan.inventoryPlan.length,
            squad_star_effects_reversed: plan.squadPlan.length,
            admin_service_effects_voided: plan.adminPlan.length,
            return_bonuses_restored: plan.returnBonusPlan.length,
        };

        const correctionKey = `quick-eval:void:${evaluation.id}`;
        const inserted = await db.run(
            `INSERT INTO clover_quick_evaluation_corrections
             (evaluation_id, correction_type, reason, actor_id, idempotency_key, before_json, after_json)
             VALUES (?, 'void', ?, ?, ?, ?, ?)`,
            [
                evaluation.id,
                why,
                actor,
                correctionKey,
                JSON.stringify(before),
                JSON.stringify(after),
            ]
        );
        const correction = await db.get(
            'SELECT * FROM clover_quick_evaluation_corrections WHERE id = ?',
            [inserted.lastID]
        );

        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            evaluationId: evaluation.id,
            correction,
            reversed: after,
            deliveryIntent: {
                type: 'quick_evaluation_voided',
                evaluationId: evaluation.id,
                playerId: evaluation.player_id,
                actorId: actor,
                reason: why,
            },
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    KNOWN_EFFECT_TYPES,
    buildVoidPlanInTransaction,
    getQuickEvaluationIntegritySnapshot,
    preflightVoidQuickEvaluation,
    reconcileQuickEvaluationEffectsInTransaction,
    voidQuickEvaluation,
};
