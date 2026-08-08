'use strict';

const {
    ensureYullsStateInTransaction,
    getReservedYullsInTransaction,
    getYullsSummary,
    mutateYullsInTransaction,
} = require('./yullsService');
const {
    adminAdjustPhInTransaction,
    ensurePhState,
    getPhSummary,
    reversePhLedgerInTransaction,
} = require('./phService');
const {
    getPaSummary,
    mutatePaInTransaction,
} = require('./paService');
const {
    adjustPoderMagicoInTransaction,
    ensureCharacterStatAdjustmentSchema,
} = require('./characterStatAdjustmentService');

const RESOURCE_KEYS = Object.freeze(['yulls', 'ph', 'pa', 'pm']);

class AdminResourceAdjustmentError extends Error {
    constructor(code, message, details = {}, status = 400) {
        super(message || code);
        this.name = 'AdminResourceAdjustmentError';
        this.code = code;
        this.details = details;
        this.status = status;
    }
}

function normalizeResource(value) {
    const raw = String(value || '').trim().toLowerCase();
    const aliases = {
        dinheiro: 'yulls',
        yull: 'yulls',
        pontos_habilidade: 'ph',
        ponto_habilidade: 'ph',
        poder_magico: 'pm',
        'poder mágico': 'pm',
    };
    const resource = aliases[raw] || raw;
    if (!RESOURCE_KEYS.includes(resource)) {
        throw new AdminResourceAdjustmentError(
            'unsupported_resource_adjustment',
            'Ajuste direto suporta Yulls, PH, PA e Poder Mágico.',
            { resource: raw, supported: RESOURCE_KEYS }
        );
    }
    return resource;
}

function signedInteger(value) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount === 0) {
        throw new AdminResourceAdjustmentError('invalid_resource_amount', 'O ajuste precisa ser um inteiro diferente de zero.');
    }
    return amount;
}

function labelFor(resource) {
    return ({ yulls: 'Yulls', ph: 'PH', pa: 'PA', pm: 'Poder Mágico' })[resource] || resource;
}

async function readResourceState(db, playerId, resource, options = {}) {
    const transactionManaged = options.transactionManaged === true;
    if (resource === 'yulls') {
        if (!transactionManaged) {
            const summary = await getYullsSummary(db, playerId);
            return {
                balance: Number(summary.balance || 0),
                reserved: Number(summary.reserved || 0),
                available: Number(summary.available || 0),
            };
        }
        await ensureYullsStateInTransaction(db, playerId);
        const player = await db.get('SELECT COALESCE(dinheiro, 0) AS dinheiro FROM jogadores WHERE id = ?', [playerId]);
        if (!player) throw new AdminResourceAdjustmentError('player_not_found', 'Jogador não encontrado.', { playerId }, 404);
        const balance = Number(player.dinheiro || 0);
        const reserved = await getReservedYullsInTransaction(db, playerId);
        return { balance, reserved, available: Math.max(0, balance - reserved) };
    }
    if (resource === 'ph') {
        if (!transactionManaged) {
            const summary = await getPhSummary(db, playerId);
            return {
                phAccumulated: Number(summary.phAccumulated || 0),
                phAvailable: Number(summary.phAvailable || 0),
                stageKey: summary.stageKey,
                stageName: summary.stageName,
                pbTotal: Number(summary.pbTotal || 0),
                pbSpent: Number(summary.pbSpent || 0),
                pbFree: Number(summary.pbFree || 0),
            };
        }
        await ensurePhState(db, playerId);
        const stats = await db.get(
            `SELECT ph_accumulated, ph_available, stage_key, pb_total
             FROM clover_character_stats WHERE player_id = ?`,
            [playerId]
        );
        if (!stats) throw new AdminResourceAdjustmentError('player_stats_not_found', 'Stats do jogador não encontrados.', { playerId }, 404);
        return {
            phAccumulated: Number(stats.ph_accumulated || 0),
            phAvailable: Number(stats.ph_available || 0),
            stageKey: String(stats.stage_key || '9'),
            pbTotal: Number(stats.pb_total || 0),
        };
    }
    if (resource === 'pa') {
        const summary = await getPaSummary(db, playerId);
        return { balance: Number(summary.balance || 0) };
    }
    await ensureCharacterStatAdjustmentSchema(db);
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new AdminResourceAdjustmentError('player_not_found', 'Jogador não encontrado.', { playerId }, 404);
    const row = await db.get(
        'SELECT COALESCE(poder_magico, 0) AS value FROM clover_character_stats WHERE player_id = ?',
        [playerId]
    );
    return { value: Number(row?.value || 0) };
}

function previewAfter(resource, before, amount, options = {}) {
    if (resource === 'yulls') {
        const balance = before.balance + amount;
        if (balance < 0 || (amount < 0 && before.available < Math.abs(amount))) {
            throw new AdminResourceAdjustmentError('insufficient_yulls', 'O ajuste excede os Yulls disponíveis.', { before, amount }, 409);
        }
        return { ...before, balance, available: before.available + amount };
    }
    if (resource === 'ph') {
        const affectAccumulated = options.affectAccumulated === true || (options.affectAccumulated === undefined && amount > 0);
        const accumulatedDelta = affectAccumulated ? amount : 0;
        const phAvailable = before.phAvailable + amount;
        const phAccumulated = before.phAccumulated + accumulatedDelta;
        if (phAvailable < 0) throw new AdminResourceAdjustmentError('insufficient_ph', 'O ajuste excede o PH disponível.', { before, amount }, 409);
        if (phAccumulated < 0) throw new AdminResourceAdjustmentError('insufficient_accumulated_ph', 'O ajuste excede o PH acumulado.', { before, amount }, 409);
        return {
            ...before,
            phAvailable,
            phAccumulated,
            accumulatedDelta,
            availableDelta: amount,
            affectAccumulated,
        };
    }
    if (resource === 'pa') {
        const balance = before.balance + amount;
        if (balance < 0) throw new AdminResourceAdjustmentError('insufficient_pa', 'O ajuste deixaria o PA negativo.', { before, amount }, 409);
        return { balance };
    }
    const value = before.value + amount;
    if (value < 0) throw new AdminResourceAdjustmentError('poder_magico_below_zero', 'O ajuste deixaria o Poder Mágico negativo.', { before, amount }, 409);
    return { value };
}

function comparableState(resource, state) {
    if (resource === 'yulls') return { balance: state.balance, reserved: state.reserved, available: state.available };
    if (resource === 'ph') return { phAccumulated: state.phAccumulated, phAvailable: state.phAvailable, stageKey: state.stageKey, pbTotal: state.pbTotal };
    if (resource === 'pa') return { balance: state.balance };
    return { value: state.value };
}

function statesEqual(resource, left, right) {
    return JSON.stringify(comparableState(resource, left)) === JSON.stringify(comparableState(resource, right));
}

async function assertLatestLedger(db, table, whereSql, params, expectedId, code, message) {
    const row = await db.get(`SELECT id FROM ${table} WHERE ${whereSql} ORDER BY id DESC LIMIT 1`, params);
    if (Number(row?.id || 0) !== Number(expectedId || 0)) {
        throw new AdminResourceAdjustmentError(code, message, { expectedLedgerId: Number(expectedId || 0), latestLedgerId: Number(row?.id || 0) }, 409);
    }
}

async function applyAdjustment(db, operation, unit, target, resource, amount, action, before) {
    const current = await readResourceState(db, target.playerId, resource, { transactionManaged: true });
    if (!statesEqual(resource, before, current)) {
        throw new AdminResourceAdjustmentError(
            'resource_changed_since_preview',
            `${labelFor(resource)} mudou depois da prévia. Simule novamente.`,
            { resource, preview: comparableState(resource, before), current: comparableState(resource, current) },
            409
        );
    }
    const effectKey = `${operation.code}:unit:${unit.id}:resource:${resource}`;
    const reason = String(action.payload?.reason || operation.reason || 'Ajuste administrativo').trim();

    if (resource === 'yulls') {
        return mutateYullsInTransaction(db, target.playerId, {
            amount,
            kind: 'ajuste_admin',
            source: 'admin_operation',
            reason,
            relatedId: operation.code,
            idempotencyKey: effectKey,
            createdBy: operation.actor.id,
            metadata: { resource_adjustment: true },
        });
    }
    if (resource === 'ph') {
        return adminAdjustPhInTransaction(db, target.playerId, amount, reason, operation.actor.id, {
            affectAccumulated: action.payload?.affectAccumulated,
            source: 'admin_operation',
            relatedId: operation.code,
            metadata: { resource_adjustment: true, effect_key: effectKey },
        });
    }
    if (resource === 'pa') {
        return mutatePaInTransaction(db, target.playerId, {
            amount,
            kind: 'ajuste_admin',
            source: 'admin_operation',
            reason,
            relatedId: operation.code,
            idempotencyKey: effectKey,
            createdBy: operation.actor.id,
            metadata: { resource_adjustment: true },
        });
    }
    return adjustPoderMagicoInTransaction(db, target.playerId, amount, {
        kind: 'ajuste_admin',
        source: 'admin_operation',
        reason,
        relatedId: operation.code,
        idempotencyKey: effectKey,
        createdBy: operation.actor.id,
        metadata: { resource_adjustment: true },
    });
}

async function undoAdjustment(db, operation, after) {
    const resource = after.resource;
    const playerId = after.playerId;
    const amount = Number(after.amount);
    if (resource === 'ph') {
        await reversePhLedgerInTransaction(
            db,
            playerId,
            after.ledgerId,
            `Desfazer ${operation.code}`,
            operation.actor.id,
            { relatedId: operation.code, metadata: { resource_adjustment_undo: true } }
        );
        return;
    }
    if (resource === 'yulls') {
        await assertLatestLedger(db, 'clover_yulls_ledger', 'player_id = ?', [playerId], after.ledgerId, 'yulls_changed_since_adjustment', 'Yulls receberam outro lançamento depois deste ajuste.');
        await mutateYullsInTransaction(db, playerId, {
            amount: -amount,
            kind: 'estorno',
            source: 'admin_operation_undo',
            reason: `Desfazer ${operation.code}`,
            relatedId: operation.code,
            idempotencyKey: `${operation.code}:undo:resource:yulls:${after.ledgerId}`,
            createdBy: operation.actor.id,
            metadata: { original_ledger_id: after.ledgerId },
        });
        return;
    }
    if (resource === 'pa') {
        await assertLatestLedger(db, 'clover_pa_ledger', 'player_id = ?', [playerId], after.ledgerId, 'pa_changed_since_adjustment', 'PA recebeu outro lançamento depois deste ajuste.');
        await mutatePaInTransaction(db, playerId, {
            amount: -amount,
            kind: 'estorno',
            source: 'admin_operation_undo',
            reason: `Desfazer ${operation.code}`,
            relatedId: operation.code,
            idempotencyKey: `${operation.code}:undo:resource:pa:${after.ledgerId}`,
            createdBy: operation.actor.id,
            metadata: { original_ledger_id: after.ledgerId },
        });
        return;
    }
    await assertLatestLedger(db, 'clover_character_stat_ledger', "player_id = ? AND stat_key = 'poder_magico'", [playerId], after.ledgerId, 'pm_changed_since_adjustment', 'Poder Mágico recebeu outro lançamento depois deste ajuste.');
    await adjustPoderMagicoInTransaction(db, playerId, -amount, {
        kind: 'estorno',
        source: 'admin_operation_undo',
        reason: `Desfazer ${operation.code}`,
        relatedId: operation.code,
        idempotencyKey: `${operation.code}:undo:resource:pm:${after.ledgerId}`,
        createdBy: operation.actor.id,
        metadata: { original_ledger_id: after.ledgerId },
    });
}

function createResourceAdjustmentExecutor() {
    return {
        async preview({ db, action, target }) {
            const resource = normalizeResource(action.payload?.resource || action.payload?.resourceKey || action.payload?.key);
            const amount = signedInteger(action.payload?.amount ?? action.payload?.delta);
            const before = await readResourceState(db, target.playerId, resource);
            const after = previewAfter(resource, before, amount, { affectAccumulated: action.payload?.affectAccumulated });
            return {
                summary: `${target.characterName || target.playerId}: ${amount > 0 ? '+' : ''}${amount} ${labelFor(resource)}`,
                before,
                after: {
                    ...after,
                    resource,
                    playerId: target.playerId,
                    amount,
                    affectAccumulated: resource === 'ph' ? after.affectAccumulated : undefined,
                },
            };
        },
        async apply({ db, operation, unit, action, target, before, after }) {
            const result = await applyAdjustment(db, operation, unit, target, after.resource, after.amount, action, before);
            const finalState = await readResourceState(db, target.playerId, after.resource, { transactionManaged: true });
            return {
                after: {
                    ...after,
                    ...finalState,
                    ledgerId: Number(result.ledgerId),
                },
                summary: `${target.characterName || target.playerId}: ${after.amount > 0 ? '+' : ''}${after.amount} ${labelFor(after.resource)} aplicado.`,
            };
        },
        async undo({ db, operation, after }) {
            await undoAdjustment(db, operation, after);
        },
    };
}

module.exports = {
    AdminResourceAdjustmentError,
    RESOURCE_KEYS,
    createResourceAdjustmentExecutor,
    normalizeResource,
    readResourceState,
};
