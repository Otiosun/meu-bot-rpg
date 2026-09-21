'use strict';

const {
    ensureSpellReviewFlowSchema,
    findActiveEntryForPlayer,
    getSpellReviewCapacity,
    holdSpellReviewEntry,
    deferSpellReviewEntry,
} = require('./spellReviewFlowService');

class AdminSpellReviewError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminSpellReviewError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function actorId(operation = {}) {
    return operation.actor?.id
        || operation.actor_id
        || operation.created_by
        || operation.createdBy
        || 'admin-operation';
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function queueSnapshot(row) {
    if (!row) return null;
    return {
        id: Number(row.id || 0),
        status: row.status || null,
        reviewState: row.review_state || 'active',
        requestedAt: row.requested_at || null,
        calledAt: row.called_at || null,
        closedAt: row.closed_at || null,
        closedBy: row.closed_by || null,
        reason: row.reason || null,
        heldAt: row.held_at || null,
        heldBy: row.held_by || null,
        holdReason: row.hold_reason || null,
    };
}

async function getQueueRow(db, id) {
    await ensureSpellReviewFlowSchema(db);
    return db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [id]);
}

async function assertEntryStillMatches(db, playerId, snapshot, code = 'spell_review_changed_after_preview') {
    const current = await findActiveEntryForPlayer(db, playerId);
    if (!current || Number(current.id) !== Number(snapshot?.id) || !valuesMatch(queueSnapshot(current), snapshot)) {
        throw new AdminSpellReviewError(
            code,
            'A avaliação de feitiço mudou depois da prévia. Gere uma nova prévia.',
            409
        );
    }
    return current;
}

async function assertUndoStillMatches(db, snapshot) {
    const current = await getQueueRow(db, snapshot?.id);
    if (!current || !valuesMatch(queueSnapshot(current), snapshot)) {
        throw new AdminSpellReviewError(
            'spell_review_changed_after_apply',
            'A avaliação recebeu alteração posterior; o undo automático foi bloqueado.',
            409
        );
    }
    return current;
}

async function restoreQueueSnapshot(db, snapshot) {
    const result = await db.run(
        `UPDATE clover_spell_review_queue
         SET status = ?, review_state = ?, requested_at = ?, called_at = ?, closed_at = ?,
             closed_by = ?, reason = ?, held_at = ?, held_by = ?, hold_reason = ?
         WHERE id = ?`,
        [
            snapshot.status,
            snapshot.reviewState || 'active',
            snapshot.requestedAt,
            snapshot.calledAt,
            snapshot.closedAt,
            snapshot.closedBy,
            snapshot.reason,
            snapshot.heldAt,
            snapshot.heldBy,
            snapshot.holdReason,
            snapshot.id,
        ]
    );
    if (!Number(result?.changes || 0)) {
        throw new AdminSpellReviewError('spell_review_restore_failed', 'Não foi possível restaurar a avaliação.', 409);
    }
}

async function countActiveReviewSlots(db) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_spell_review_queue
         WHERE status = 'called'
           AND COALESCE(review_state, 'active') != 'pending'`
    );
    return Number(row?.total || 0);
}

function reasonFrom(action = {}, operation = {}, fallback) {
    const direct = String(action.payload?.reason || action.payload?.motivo || '').trim();
    const operationReason = String(operation.reason || '').trim();
    return direct || operationReason || fallback;
}

function holdExecutor() {
    return {
        async preview({ db, target, action, operation }) {
            const entry = await findActiveEntryForPlayer(db, target.playerId);
            if (!entry) throw new AdminSpellReviewError('spell_review_not_active', 'O personagem não possui avaliação ativa.', 404);
            if (entry.status !== 'called') {
                throw new AdminSpellReviewError('spell_review_not_called', 'A avaliação ainda não foi chamada e não pode ser suspensa.', 409);
            }
            if ((entry.review_state || 'active') === 'pending') {
                throw new AdminSpellReviewError('spell_review_already_pending', 'A avaliação já está suspensa.', 409);
            }
            const reason = reasonFrom(action, operation, 'avaliação suspensa pela Central ADM');
            return {
                summary: `${target.characterName || 'Personagem'}: suspender avaliação de feitiço`,
                before: { entry: queueSnapshot(entry), reason },
                after: { entry: { ...queueSnapshot(entry), reviewState: 'pending' } },
            };
        },
        async apply({ db, target, operation, before }) {
            await assertEntryStillMatches(db, target.playerId, before.entry);
            const result = await holdSpellReviewEntry(db, target.playerId, actorId(operation), before.reason);
            if (!result.ok) {
                throw new AdminSpellReviewError(result.code || 'spell_review_hold_failed', 'Não foi possível suspender a avaliação.', 409, result);
            }
            return {
                after: { entry: queueSnapshot(result.entry) },
                summary: `${target.characterName || 'Personagem'}: avaliação suspensa.`,
            };
        },
        async undo({ db, before, after }) {
            await assertUndoStillMatches(db, after.entry);
            await restoreQueueSnapshot(db, before.entry);
        },
    };
}

function deferExecutor() {
    return {
        async preview({ db, target, action, operation }) {
            const entry = await findActiveEntryForPlayer(db, target.playerId);
            if (!entry) throw new AdminSpellReviewError('spell_review_not_active', 'O personagem não possui avaliação ativa.', 404);
            const reason = reasonFrom(action, operation, 'avaliação adiada pela Central ADM');
            return {
                summary: `${target.characterName || 'Personagem'}: adiar avaliação para a fila`,
                before: { entry: queueSnapshot(entry), reason },
                after: { entry: { ...queueSnapshot(entry), status: 'waiting', reviewState: 'active' } },
            };
        },
        async apply({ db, target, operation, before }) {
            await assertEntryStillMatches(db, target.playerId, before.entry);
            const result = await deferSpellReviewEntry(db, target.playerId, actorId(operation), before.reason);
            if (!result.ok) {
                throw new AdminSpellReviewError(result.code || 'spell_review_defer_failed', 'Não foi possível adiar a avaliação.', 409, result);
            }
            return {
                after: { entry: queueSnapshot(result.entry) },
                summary: `${target.characterName || 'Personagem'}: avaliação devolvida ao fim da fila.`,
            };
        },
        async undo({ db, before, after }) {
            await assertUndoStillMatches(db, after.entry);
            await restoreQueueSnapshot(db, before.entry);
        },
    };
}

function resumeExecutor() {
    return {
        async preview({ db, target }) {
            const entry = await findActiveEntryForPlayer(db, target.playerId);
            if (!entry) throw new AdminSpellReviewError('spell_review_not_active', 'O personagem não possui avaliação ativa.', 404);
            if (entry.status !== 'called' || (entry.review_state || 'active') !== 'pending') {
                throw new AdminSpellReviewError('spell_review_not_pending', 'A avaliação não está suspensa.', 409);
            }
            const [capacity, active] = await Promise.all([
                getSpellReviewCapacity(db),
                countActiveReviewSlots(db),
            ]);
            if (active >= capacity) {
                throw new AdminSpellReviewError(
                    'spell_review_capacity_full',
                    'Não há vaga ativa para retomar esta avaliação.',
                    409,
                    { capacity, active }
                );
            }
            return {
                summary: `${target.characterName || 'Personagem'}: retomar avaliação de feitiço`,
                before: { entry: queueSnapshot(entry), capacity, active },
                after: { entry: { ...queueSnapshot(entry), reviewState: 'active', heldAt: null, heldBy: null, holdReason: null } },
            };
        },
        async apply({ db, target, operation, before }) {
            const current = await assertEntryStillMatches(db, target.playerId, before.entry);
            if (current.status !== 'called' || (current.review_state || 'active') !== 'pending') {
                throw new AdminSpellReviewError('spell_review_not_pending', 'A avaliação deixou de estar suspensa.', 409);
            }
            const [capacity, active] = await Promise.all([
                getSpellReviewCapacity(db),
                countActiveReviewSlots(db),
            ]);
            if (active >= capacity) {
                throw new AdminSpellReviewError(
                    'spell_review_capacity_full',
                    'A capacidade foi preenchida depois da prévia. Gere uma nova prévia.',
                    409,
                    { capacity, active }
                );
            }
            const updated = await db.run(
                `UPDATE clover_spell_review_queue
                 SET review_state = 'active',
                     held_at = NULL,
                     held_by = NULL,
                     hold_reason = NULL,
                     closed_by = ?,
                     reason = NULL
                 WHERE id = ?
                   AND status = 'called'
                   AND review_state = 'pending'`,
                [actorId(operation), current.id]
            );
            if (!Number(updated?.changes || 0)) {
                throw new AdminSpellReviewError('spell_review_changed', 'A avaliação mudou durante a aplicação.', 409);
            }
            const row = await getQueueRow(db, current.id);
            return {
                after: { entry: queueSnapshot(row) },
                summary: `${target.characterName || 'Personagem'}: avaliação retomada.`,
            };
        },
        async undo({ db, before, after }) {
            await assertUndoStillMatches(db, after.entry);
            await restoreQueueSnapshot(db, before.entry);
        },
    };
}

function createSpellReviewExecutors() {
    return {
        'player.spell.review.hold': holdExecutor(),
        'player.spell.review.defer': deferExecutor(),
        'player.spell.review.resume': resumeExecutor(),
    };
}

module.exports = {
    AdminSpellReviewError,
    countActiveReviewSlots,
    createSpellReviewExecutors,
    queueSnapshot,
    restoreQueueSnapshot,
};