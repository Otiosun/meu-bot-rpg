'use strict';

const { createItemExecutors } = require('./itemAdminService');
const { addPhInTransaction, getPhSummary } = require('./phService');
const { addYullsInTransaction } = require('./yullsService');
const { addPaInTransaction, mutatePaInTransaction } = require('./paService');
const { adjustPoderMagicoInTransaction } = require('./characterStatAdjustmentService');
const { undoRewardEffects } = require('./adminRewardService');
const {
    normalizeRewardEntriesV2,
    previewDelegatedRewardEffect,
    applyDelegatedRewardEffect,
    undoDelegatedRewardEffect,
} = require('./adminRewardServiceV2');
const {
    getWeeklyPhCapSummary,
    planWeeklyGrant,
    recordWeeklyPhUsageInTransaction,
    voidWeeklyPhUsageInTransaction,
} = require('./weeklyPhCapService');
const {
    grantPlayerStarsInTransaction,
    reversePlayerStarsInTransaction,
} = require('./playerStarRewardService');

class AdminQuickRewardError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminQuickRewardError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function positiveInteger(value, field, maximum = 1_000_000_000) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
        throw new AdminQuickRewardError('invalid_quick_reward_field', `${field} inválido.`, 400, {
            field,
            maximum,
        });
    }
    return number;
}

function optionalLabel(value) {
    const text = String(value || '').trim();
    return text ? text.slice(0, 160) : null;
}

function normalizeQuickEntries(value) {
    const source = Array.isArray(value) ? value : [];
    if (!source.length) {
        throw new AdminQuickRewardError(
            'empty_quick_reward',
            'Adicione pelo menos um efeito à concessão rápida.'
        );
    }
    if (source.length > 30) {
        throw new AdminQuickRewardError(
            'quick_reward_too_large',
            'A concessão rápida aceita no máximo 30 efeitos.'
        );
    }

    let starSeen = false;
    return source.map((entry, index) => {
        const rawType = String(entry?.type || entry?.kind || entry?.tipo || '').trim().toLowerCase();
        if (['stars', 'star', 'estrela', 'estrelas'].includes(rawType)) {
            if (starSeen) {
                throw new AdminQuickRewardError(
                    'duplicate_quick_stars',
                    'Use apenas uma entrada de Estrelas por concessão rápida.'
                );
            }
            starSeen = true;
            return {
                type: 'stars',
                amount: positiveInteger(entry.amount ?? entry.quantidade ?? entry.value, `Estrelas da entrada ${index + 1}`, 100_000),
                label: optionalLabel(entry.label || entry.name || entry.nome) || 'Estrelas',
            };
        }
        try {
            return normalizeRewardEntriesV2([entry])[0];
        } catch (error) {
            throw new AdminQuickRewardError(
                error?.code || 'invalid_quick_reward_entry',
                error?.message || `Entrada ${index + 1} inválida.`,
                Number(error?.status || 400),
                error?.details || null
            );
        }
    });
}

async function playerRow(db, playerId) {
    const player = await db.get(
        `SELECT id, personagem_nome, COALESCE(dinheiro, 0) AS dinheiro,
                COALESCE(estrelas, 0) AS estrelas, esquadrao
         FROM jogadores WHERE id = ?`,
        [playerId]
    );
    if (!player) throw new AdminQuickRewardError('player_not_found', 'Jogador não encontrado.', 404);
    return player;
}

async function paBalance(db, playerId) {
    const row = await db.get(
        'SELECT COALESCE(SUM(amount), 0) AS balance FROM clover_pa_ledger WHERE player_id = ?',
        [playerId]
    ).catch(() => ({ balance: 0 }));
    return Number(row?.balance || 0);
}

async function pmBalance(db, playerId) {
    const row = await db.get(
        `SELECT COALESCE(poder_magico, 0) AS value
         FROM clover_character_stats WHERE player_id = ?`,
        [playerId]
    );
    return Number(row?.value || 0);
}

async function previewQuickEntries(db, operation, target, entries, unitId = 'preview') {
    const player = await playerRow(db, target.playerId);
    const itemExecutor = createItemExecutors()['player.item.grant'];
    let yulls = Number(player.dinheiro || 0);
    let ph = null;
    let pa = null;
    let pm = null;
    let stars = Number(player.estrelas || 0);
    const effects = [];

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.type === 'yulls') {
            effects.push({
                type: 'yulls',
                entryIndex: index,
                amount: entry.amount,
                label: entry.label,
                before: yulls,
                after: yulls + entry.amount,
            });
            yulls += entry.amount;
            continue;
        }
        if (entry.type === 'ph') {
            ph ||= await getPhSummary(db, target.playerId);
            if (entry.capPolicy === 'weekly') {
                const cap = await getWeeklyPhCapSummary(
                    db,
                    target.playerId,
                    entry.effectiveDate || new Date()
                );
                const weeklyPlan = planWeeklyGrant(cap, entry.amount);
                if (weeklyPlan.applied <= 0) {
                    throw new AdminQuickRewardError(
                        'weekly_ph_cap_exhausted',
                        `${target.characterName || player.personagem_nome || target.playerId} já atingiu o teto semanal de PH.`,
                        409,
                        { cap, requested: entry.amount }
                    );
                }
                effects.push({
                    type: 'ph',
                    entryIndex: index,
                    amount: weeklyPlan.applied,
                    requestedAmount: entry.amount,
                    capPolicy: 'weekly',
                    weeklyPlan,
                    label: entry.label,
                    before: ph,
                    after: {
                        ...ph,
                        phAccumulated: ph.phAccumulated + weeklyPlan.applied,
                        phAvailable: ph.phAvailable + weeklyPlan.applied,
                    },
                });
            } else {
                effects.push({
                    type: 'ph',
                    entryIndex: index,
                    amount: entry.amount,
                    requestedAmount: entry.amount,
                    capPolicy: entry.capPolicy || 'outside_weekly',
                    label: entry.label,
                    before: ph,
                    after: {
                        ...ph,
                        phAccumulated: ph.phAccumulated + entry.amount,
                        phAvailable: ph.phAvailable + entry.amount,
                    },
                });
            }
            ph = effects[effects.length - 1].after;
            continue;
        }
        if (entry.type === 'pa') {
            pa ??= await paBalance(db, target.playerId);
            effects.push({
                type: 'pa',
                entryIndex: index,
                amount: entry.amount,
                label: entry.label,
                before: pa,
                after: pa + entry.amount,
            });
            pa += entry.amount;
            continue;
        }
        if (entry.type === 'pm') {
            pm ??= await pmBalance(db, target.playerId);
            effects.push({
                type: 'pm',
                entryIndex: index,
                amount: entry.amount,
                label: entry.label,
                before: pm,
                after: pm + entry.amount,
            });
            pm += entry.amount;
            continue;
        }
        if (entry.type === 'stars') {
            effects.push({
                type: 'stars',
                entryIndex: index,
                amount: entry.amount,
                label: entry.label,
                before: stars,
                after: stars + entry.amount,
                squad: player.esquadrao || null,
            });
            stars += entry.amount;
            continue;
        }

        if (['title', 'trait', 'hook'].includes(entry.type)) {
            const quickDelegatedPreview = await previewDelegatedRewardEffect({
                db,
                operation,
                target,
                unitId,
                entry,
                index,
            });
            effects.push(quickDelegatedPreview);
            continue;
        }

        const preview = await itemExecutor.preview({
            db,
            operation,
            action: {
                type: 'player.item.grant',
                payload: {
                    templateKey: entry.templateKey,
                    quantity: entry.quantity,
                },
            },
            target,
            unit: { id: `${unitId}-${index}` },
        });
        effects.push({
            type: entry.type,
            entryIndex: index,
            templateKey: entry.templateKey,
            quantity: entry.quantity,
            label: entry.label || preview.after.itemName,
            preview: preview.after,
        });
    }
    return effects;
}

async function assertWeeklyPlanFresh(db, playerId, effect) {
    const current = await getWeeklyPhCapSummary(
        db,
        playerId,
        effect.weeklyPlan.effectiveDate
    );
    if (
        current.weekKey !== effect.weeklyPlan.weekKey
        || Number(current.used) !== Number(effect.weeklyPlan.before)
    ) {
        throw new AdminQuickRewardError(
            'quick_reward_weekly_ph_changed_after_preview',
            'O consumo semanal de PH mudou depois da prévia. Gere uma nova prévia.',
            409,
            { preview: effect.weeklyPlan, current }
        );
    }
}

async function applyQuickEntries(db, operation, target, unit, entries, previews) {
    const itemExecutor = createItemExecutors()['player.item.grant'];
    const effects = [];

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const preview = previews[index];
        const effectKey = `${operation.code}:unit:${unit.id}:quick:${index}`;

        if (entry.type === 'yulls') {
            const result = await addYullsInTransaction(
                db,
                target.playerId,
                entry.amount,
                'admin_quick_reward',
                operation.reason || 'Concessão rápida',
                operation.actor.id,
                {
                    relatedId: operation.code,
                    idempotencyKey: effectKey,
                    metadata: { quickReward: true, entryIndex: index },
                }
            );
            effects.push({ type: 'yulls', entryIndex: index, amount: entry.amount, label: entry.label, ...result });
            continue;
        }

        if (entry.type === 'ph') {
            let amount = entry.amount;
            if (entry.capPolicy === 'weekly') {
                await assertWeeklyPlanFresh(db, target.playerId, preview);
                amount = Number(preview.weeklyPlan.applied);
            }
            const result = await addPhInTransaction(
                db,
                target.playerId,
                amount,
                'admin_quick_reward',
                `${operation.reason || 'Concessão rápida'} — ${entry.capPolicy === 'weekly' ? 'dentro do teto semanal' : entry.capPolicy === 'adjustment' ? 'ajuste administrativo' : 'fora do teto semanal'}`,
                operation.actor.id,
                {
                    quickReward: true,
                    entryIndex: index,
                    operationCode: operation.code,
                    cap_policy: entry.capPolicy,
                    outside_weekly_cap: entry.capPolicy !== 'weekly',
                    effective_date: preview?.weeklyPlan?.effectiveDate || entry.effectiveDate || null,
                },
                effectKey
            );
            let weeklyUsage = null;
            if (entry.capPolicy === 'weekly') {
                weeklyUsage = await recordWeeklyPhUsageInTransaction(db, {
                    usageKey: effectKey,
                    playerId: target.playerId,
                    weekKey: preview.weeklyPlan.weekKey,
                    effectiveDate: preview.weeklyPlan.effectiveDate,
                    requestedAmount: entry.amount,
                    appliedAmount: amount,
                    operationCode: operation.code,
                    source: 'admin_quick_reward',
                    reason: operation.reason || 'Concessão rápida',
                    createdBy: operation.actor.id,
                    metadata: { quickReward: true, entryIndex: index },
                });
            }
            effects.push({
                type: 'ph',
                entryIndex: index,
                amount,
                requestedAmount: entry.amount,
                capPolicy: entry.capPolicy,
                weeklyPlan: preview?.weeklyPlan || null,
                weeklyUsage,
                label: entry.label,
                ...result,
            });
            continue;
        }

        if (entry.type === 'pa') {
            const result = await addPaInTransaction(
                db,
                target.playerId,
                entry.amount,
                'admin_quick_reward',
                operation.reason || 'Concessão rápida',
                operation.actor.id,
                {
                    relatedId: operation.code,
                    idempotencyKey: effectKey,
                    metadata: { quickReward: true, entryIndex: index },
                }
            );
            effects.push({ type: 'pa', entryIndex: index, amount: entry.amount, label: entry.label, ...result });
            continue;
        }

        if (entry.type === 'pm') {
            const result = await adjustPoderMagicoInTransaction(db, target.playerId, entry.amount, {
                kind: 'ganho',
                source: 'admin_quick_reward',
                reason: operation.reason || 'Concessão rápida',
                relatedId: operation.code,
                idempotencyKey: effectKey,
                createdBy: operation.actor.id,
                metadata: { quickReward: true, entryIndex: index },
            });
            effects.push({ type: 'pm', entryIndex: index, amount: entry.amount, label: entry.label, ...result });
            continue;
        }

        if (entry.type === 'stars') {
            const result = await grantPlayerStarsInTransaction(db, {
                transactionKey: effectKey,
                playerId: target.playerId,
                amount: entry.amount,
                source: 'admin_quick_reward',
                reason: operation.reason || 'Concessão rápida',
                relatedId: operation.code,
                createdBy: operation.actor.id,
                metadata: { quickReward: true, entryIndex: index },
            });
            effects.push({
                type: 'stars',
                entryIndex: index,
                amount: entry.amount,
                label: entry.label,
                transactionKey: effectKey,
                ...result,
            });
            continue;
        }

        if (['title', 'trait', 'hook'].includes(entry.type)) {
            const quickDelegatedApplied = await applyDelegatedRewardEffect({
                db,
                operation,
                target,
                unit,
                entry,
                index,
                preview,
            });
            effects.push(quickDelegatedApplied);
            continue;
        }

        const applied = await itemExecutor.apply({
            db,
            operation,
            action: {
                type: 'player.item.grant',
                payload: {
                    templateKey: entry.templateKey,
                    quantity: entry.quantity,
                },
            },
            target,
            unit: { ...unit, id: `${unit.id}-${index}` },
            after: {
                playerId: target.playerId,
                templateKey: entry.templateKey,
                itemName: entry.label || entry.templateKey,
                quantity: entry.quantity,
            },
        });
        effects.push({
            type: entry.type,
            entryIndex: index,
            templateKey: entry.templateKey,
            quantity: entry.quantity,
            label: entry.label || applied.after?.itemName || entry.templateKey,
            snapshot: applied.after,
        });
    }

    return effects;
}

async function assertLatestLedger(db, table, whereSql, params, expectedId, code, message) {
    const row = await db.get(
        `SELECT id FROM ${table} WHERE ${whereSql} ORDER BY id DESC LIMIT 1`,
        params
    );
    if (Number(row?.id || 0) !== Number(expectedId || 0)) {
        throw new AdminQuickRewardError(code, message, 409, {
            expectedLedgerId: Number(expectedId || 0),
            latestLedgerId: Number(row?.id || 0),
        });
    }
}

async function undoQuickEffects(db, operation, playerId, effects) {
    const baseEffects = (effects || [])
        .filter((effect) => ['item', 'box', 'ph', 'yulls'].includes(effect.type))
        .map((effect) => effect.type === 'box' ? { ...effect, type: 'item' } : effect);
    await undoRewardEffects(db, operation, playerId, baseEffects);

    for (const effect of [...(effects || [])].reverse()) {
        if (effect.type === 'ph' && effect.capPolicy === 'weekly' && effect.weeklyUsage?.usageKey) {
            await voidWeeklyPhUsageInTransaction(
                db,
                effect.weeklyUsage.usageKey,
                operation.actor.id,
                `Desfazer ${operation.code}`
            );
            continue;
        }
        if (effect.type === 'pa') {
            await assertLatestLedger(
                db,
                'clover_pa_ledger',
                'player_id = ?',
                [playerId],
                effect.ledgerId,
                'quick_reward_pa_changed_since_apply',
                'O PA recebeu outro lançamento depois desta concessão.'
            );
            await mutatePaInTransaction(db, playerId, {
                amount: -Math.abs(effect.amount),
                kind: 'estorno',
                source: 'admin_quick_reward_undo',
                reason: `Desfazer ${operation.code}`,
                relatedId: operation.code,
                idempotencyKey: `${operation.code}:quick-undo:pa:${effect.entryIndex}`,
                createdBy: operation.actor.id,
                metadata: { original_ledger_id: effect.ledgerId },
            });
            continue;
        }
        if (effect.type === 'pm') {
            await assertLatestLedger(
                db,
                'clover_character_stat_ledger',
                "player_id = ? AND stat_key = 'poder_magico'",
                [playerId],
                effect.ledgerId,
                'quick_reward_pm_changed_since_apply',
                'O Poder Mágico recebeu outro lançamento depois desta concessão.'
            );
            await adjustPoderMagicoInTransaction(db, playerId, -Math.abs(effect.amount), {
                kind: 'estorno',
                source: 'admin_quick_reward_undo',
                reason: `Desfazer ${operation.code}`,
                relatedId: operation.code,
                idempotencyKey: `${operation.code}:quick-undo:pm:${effect.entryIndex}`,
                createdBy: operation.actor.id,
                metadata: { original_ledger_id: effect.ledgerId },
            });
            continue;
        }
        if (effect.type === 'stars' && effect.transactionKey) {
            await reversePlayerStarsInTransaction(db, effect.transactionKey, {
                createdBy: operation.actor.id,
                reason: `Desfazer ${operation.code}`,
                relatedId: operation.code,
            });
        }
        if (['title', 'trait', 'hook'].includes(effect.type)) {
            await undoDelegatedRewardEffect({ db, operation, playerId, effect });
        }
    }
}

function createQuickRewardExecutor(fallbackRewardExecutor) {
    return {
        async preview(context) {
            const quickEntries = context.action?.payload?.quickEntries;
            if (!Array.isArray(quickEntries)) {
                return fallbackRewardExecutor.preview(context);
            }
            const entries = normalizeQuickEntries(quickEntries);
            const effects = await previewQuickEntries(
                context.db,
                context.operation,
                context.target,
                entries,
                context.unit?.id || 'preview'
            );
            return {
                summary: `${context.target.characterName || context.target.playerId}: concessão rápida`,
                before: {
                    playerId: context.target.playerId,
                    effects: effects.map((effect) => ({
                        type: effect.type,
                        before: effect.before ?? null,
                        weeklyPlan: effect.weeklyPlan || null,
                    })),
                },
                after: {
                    playerId: context.target.playerId,
                    characterName: context.target.characterName || context.target.playerId,
                    quickReward: true,
                    entries,
                    effects,
                },
            };
        },

        async apply(context) {
            const quickEntries = context.action?.payload?.quickEntries;
            if (!Array.isArray(quickEntries)) {
                return fallbackRewardExecutor.apply(context);
            }
            const entries = normalizeQuickEntries(quickEntries);
            const effects = await applyQuickEntries(
                context.db,
                context.operation,
                context.target,
                context.unit,
                entries,
                context.after?.effects || []
            );
            return {
                after: {
                    ...context.after,
                    quickReward: true,
                    entries,
                    effects,
                },
                summary: `${context.target.characterName || context.target.playerId}: concessão rápida aplicada.`,
            };
        },

        async undo(context) {
            if (!context.after?.quickReward) {
                return fallbackRewardExecutor.undo(context);
            }
            await undoQuickEffects(
                context.db,
                context.operation,
                context.after.playerId || context.target?.playerId,
                context.after.effects || []
            );
        },
    };
}

module.exports = {
    AdminQuickRewardError,
    createQuickRewardExecutor,
    normalizeQuickEntries,
    previewQuickEntries,
    undoQuickEffects,
};
