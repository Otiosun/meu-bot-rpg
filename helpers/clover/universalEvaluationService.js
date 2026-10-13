'use strict';

const crypto = require('crypto');
const { normalizeJid } = require('../groupAccess');

class UniversalEvaluationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'UniversalEvaluationError';
        this.code = code;
        this.details = details;
    }
}

const EVALUATION_CATEGORIES = Object.freeze({
    spell: Object.freeze({ key: 'spell', label: 'Feitiço' }),
    prototype: Object.freeze({ key: 'prototype', label: 'Protótipo' }),
    adaptation: Object.freeze({ key: 'adaptation', label: 'Adaptação' }),
    protocol: Object.freeze({ key: 'protocol', label: 'Protocolo' }),
    witch_recipe: Object.freeze({ key: 'witch_recipe', label: 'Receita do Gabinete' }),
    reforge: Object.freeze({ key: 'reforge', label: 'Reforja' }),
});

const CATEGORY_ALIASES = Object.freeze({
    spell: 'spell',
    feitico: 'spell',
    prototype: 'prototype',
    prototipo: 'prototype',
    adaptation: 'adaptation',
    adaptacao: 'adaptation',
    protocol: 'protocol',
    protocolo: 'protocol',
    witch_recipe: 'witch_recipe',
    receita: 'witch_recipe',
    receita_gabinete: 'witch_recipe',
    gabinete: 'witch_recipe',
    reforge: 'reforge',
    reforja: 'reforge',
});

const TERMINAL_STATUSES = new Set(['approved', 'denied', 'cancelled']);
const RESOLUTION_STATUSES = new Set(['approved', 'denied', 'awaiting_followup']);

function normalizeToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeEvaluationCategory(value) {
    const token = normalizeToken(value);
    const key = CATEGORY_ALIASES[token] || null;
    if (!key || !EVALUATION_CATEGORIES[key]) {
        throw new UniversalEvaluationError(
            'unsupported_evaluation_category',
            'Categoria de avaliação não suportada.',
            { input: String(value || ''), normalized: token }
        );
    }
    return key;
}

function categoryLabel(value) {
    const key = normalizeEvaluationCategory(value);
    return EVALUATION_CATEGORIES[key].label;
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function normalizeRequiredText(value, code, message) {
    const text = String(value || '').trim();
    if (!text) throw new UniversalEvaluationError(code, message);
    return text;
}

function normalizeProtocol(value) {
    const raw = String(value || '').trim().toUpperCase().replace(/^#/, '');
    const match = raw.match(/^A0*(\d+)$/);
    if (!match) {
        throw new UniversalEvaluationError('invalid_evaluation_protocol', 'Protocolo de avaliação inválido. Use algo como #A104.');
    }
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw new UniversalEvaluationError('invalid_evaluation_protocol', 'Protocolo de avaliação inválido.');
    }
    return `A${id}`;
}

function renderProtocol(value) {
    return `#${normalizeProtocol(value)}`;
}

function normalizeSelector(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new UniversalEvaluationError('invalid_evaluation_position', 'Posição da fila inválida.');
        }
        return { type: 'position', value };
    }

    const raw = String(value || '').trim();
    if (!raw) throw new UniversalEvaluationError('missing_evaluation_selector', 'Informe o protocolo ou a posição geral.');
    if (/^#?A\d+$/i.test(raw)) return { type: 'protocol', value: normalizeProtocol(raw) };
    if (/^\d+$/.test(raw)) {
        const position = Number(raw);
        if (!Number.isSafeInteger(position) || position <= 0) {
            throw new UniversalEvaluationError('invalid_evaluation_position', 'Posição da fila inválida.');
        }
        return { type: 'position', value: position };
    }
    throw new UniversalEvaluationError('invalid_evaluation_selector', 'Use um protocolo como #A104 ou uma posição geral numérica.');
}

function safeJson(value) {
    if (!value || typeof value !== 'object') return '{}';
    return JSON.stringify(value);
}

async function recordEventInTransaction(db, {
    submissionId,
    eventType,
    actorId = null,
    fromStatus = null,
    toStatus = null,
    reason = null,
    metadata = {},
}) {
    const inserted = await db.run(
        `INSERT INTO clover_evaluation_submission_events
         (submission_id, event_type, actor_id, from_status, to_status, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            submissionId,
            eventType,
            actorId ? normalizeJid(actorId) || String(actorId) : null,
            fromStatus,
            toStatus,
            reason ? String(reason).trim() : null,
            safeJson(metadata),
        ]
    );
    return inserted.lastID;
}

async function getSubmissionByIdInTransaction(db, id) {
    return db.get('SELECT * FROM clover_evaluation_submissions WHERE id = ?', [id]);
}

async function getSubmissionByProtocolInTransaction(db, protocol) {
    return db.get(
        'SELECT * FROM clover_evaluation_submissions WHERE protocol = ?',
        [normalizeProtocol(protocol)]
    );
}

async function getWaitingByGlobalPositionInTransaction(db, position) {
    const selector = normalizeSelector(position);
    if (selector.type !== 'position') {
        throw new UniversalEvaluationError('invalid_evaluation_position', 'Esta operação exige posição geral numérica.');
    }
    return db.get(
        `WITH waiting AS (
            SELECT s.*,
                   ROW_NUMBER() OVER (ORDER BY datetime(s.submitted_at) ASC, s.id ASC) AS global_position
            FROM clover_evaluation_submissions s
            WHERE s.status = 'waiting'
        )
        SELECT * FROM waiting WHERE global_position = ?`,
        [selector.value]
    );
}

async function resolveSelectorInTransaction(db, selectorInput) {
    const selector = normalizeSelector(selectorInput);
    if (selector.type === 'protocol') {
        return {
            selector,
            submission: await getSubmissionByProtocolInTransaction(db, selector.value),
        };
    }
    return {
        selector,
        submission: await getWaitingByGlobalPositionInTransaction(db, selector.value),
    };
}

async function createEvaluationSubmission(db, input = {}) {
    const category = normalizeEvaluationCategory(input.category);
    const playerId = normalizeRequiredText(input.playerId, 'missing_evaluation_player', 'Player da submissão não informado.');
    const whatsappJid = normalizeJid(input.whatsappJid || playerId) || normalizeRequiredText(
        input.whatsappJid || playerId,
        'missing_evaluation_whatsapp',
        'WhatsApp da submissão não informado.'
    );
    const originalPayload = normalizeRequiredText(
        input.originalPayload,
        'missing_evaluation_payload',
        'A submissão precisa do conteúdo original.'
    );
    const submissionKey = normalizeRequiredText(
        input.submissionKey,
        'missing_evaluation_idempotency_key',
        'A submissão precisa de uma chave idempotente.'
    );
    const originalPayloadHash = sha256(originalPayload);
    const normalizedPlayerId = normalizeJid(playerId) || playerId;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await db.get(
            'SELECT * FROM clover_evaluation_submissions WHERE submission_key = ?',
            [submissionKey]
        );
        if (existing) {
            const sameIntent = existing.category === category
                && existing.player_id === normalizedPlayerId
                && existing.original_payload_hash === originalPayloadHash;
            if (!sameIntent) {
                throw new UniversalEvaluationError(
                    'evaluation_submission_idempotency_conflict',
                    'Esta chave de submissão já foi usada com outro conteúdo.',
                    { submissionId: existing.id, protocol: existing.protocol }
                );
            }
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, submission: existing };
        }

        const inserted = await db.run(
            `INSERT INTO clover_evaluation_submissions
             (submission_key, category, player_id, whatsapp_jid, character_id,
              character_name_snapshot, original_payload, original_payload_hash,
              source_chat_id, source_message_id, source_quoted_message_id, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                submissionKey,
                category,
                normalizedPlayerId,
                whatsappJid,
                input.characterId ? String(input.characterId).trim() : null,
                input.characterName ? String(input.characterName).trim() : null,
                originalPayload,
                originalPayloadHash,
                input.sourceChatId ? String(input.sourceChatId).trim() : null,
                input.sourceMessageId ? String(input.sourceMessageId).trim() : null,
                input.sourceQuotedMessageId ? String(input.sourceQuotedMessageId).trim() : null,
                safeJson(input.metadata),
            ]
        );
        const submission = await getSubmissionByIdInTransaction(db, inserted.lastID);
        if (!submission?.protocol) {
            throw new UniversalEvaluationError('evaluation_protocol_missing', 'Falha ao gerar protocolo permanente da submissão.');
        }
        await recordEventInTransaction(db, {
            submissionId: submission.id,
            eventType: 'submitted',
            actorId: normalizedPlayerId,
            fromStatus: null,
            toStatus: 'waiting',
            metadata: { category },
        });
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, submission };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listWaitingSubmissions(db, options = {}) {
    const category = options.category ? normalizeEvaluationCategory(options.category) : null;
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const offset = Math.max(0, Number(options.offset) || 0);
    return db.all(
        `WITH waiting AS (
            SELECT s.*,
                   ROW_NUMBER() OVER (ORDER BY datetime(s.submitted_at) ASC, s.id ASC) AS global_position
            FROM clover_evaluation_submissions s
            WHERE s.status = 'waiting'
        )
        SELECT *
        FROM waiting
        WHERE (? IS NULL OR category = ?)
        ORDER BY global_position ASC
        LIMIT ? OFFSET ?`,
        [category, category, limit, offset]
    );
}

async function listPlayerSubmissions(db, playerId, options = {}) {
    const normalizedPlayerId = normalizeJid(playerId) || normalizeRequiredText(
        playerId,
        'missing_evaluation_player',
        'Player não informado.'
    );
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    return db.all(
        `WITH waiting_positions AS (
            SELECT id,
                   ROW_NUMBER() OVER (ORDER BY datetime(submitted_at) ASC, id ASC) AS global_position
            FROM clover_evaluation_submissions
            WHERE status = 'waiting'
        )
        SELECT s.*, wp.global_position
        FROM clover_evaluation_submissions s
        LEFT JOIN waiting_positions wp ON wp.id = s.id
        WHERE s.player_id = ?
        ORDER BY datetime(s.submitted_at) DESC, s.id DESC
        LIMIT ?`,
        [normalizedPlayerId, limit]
    );
}

async function getEvaluationSubmission(db, protocol) {
    return getSubmissionByProtocolInTransaction(db, protocol);
}

async function getEvaluationSubmissionEvents(db, protocol) {
    const submission = await getSubmissionByProtocolInTransaction(db, protocol);
    if (!submission) return [];
    return db.all(
        `SELECT * FROM clover_evaluation_submission_events
         WHERE submission_id = ?
         ORDER BY id ASC`,
        [submission.id]
    );
}

async function claimEvaluationSubmission(db, input = {}) {
    const reviewerId = normalizeJid(input.reviewerId) || normalizeRequiredText(
        input.reviewerId,
        'missing_evaluation_reviewer',
        'Avaliador não informado.'
    );
    await db.exec('BEGIN IMMEDIATE');
    try {
        const resolved = await resolveSelectorInTransaction(db, input.selector);
        const submission = resolved.submission;
        if (!submission) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_submission_not_found' };
        }
        if (submission.status === 'reviewing') {
            if (submission.reviewer_id === reviewerId) {
                await db.exec('COMMIT');
                return { ok: true, duplicate: true, submission };
            }
            await db.exec('ROLLBACK');
            return {
                ok: false,
                code: 'evaluation_already_claimed',
                submission,
                reviewerId: submission.reviewer_id,
            };
        }
        if (submission.status !== 'waiting') {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_not_waiting', submission };
        }

        const updated = await db.run(
            `UPDATE clover_evaluation_submissions
             SET status = 'reviewing', reviewer_id = ?, review_started_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'waiting'`,
            [reviewerId, submission.id]
        );
        if (Number(updated?.changes || 0) !== 1) {
            throw new UniversalEvaluationError('evaluation_claim_race', 'A submissão mudou enquanto era assumida.');
        }
        await recordEventInTransaction(db, {
            submissionId: submission.id,
            eventType: 'claimed',
            actorId: reviewerId,
            fromStatus: 'waiting',
            toStatus: 'reviewing',
            metadata: { selector: resolved.selector },
        });
        const claimed = await getSubmissionByIdInTransaction(db, submission.id);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, submission: claimed };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function claimNextEvaluationSubmission(db, reviewerId) {
    return claimEvaluationSubmission(db, { selector: 1, reviewerId });
}

async function returnEvaluationSubmissionToQueue(db, input = {}) {
    const protocol = normalizeProtocol(input.protocol);
    const actorId = normalizeJid(input.actorId || input.reviewerId) || normalizeRequiredText(
        input.actorId || input.reviewerId,
        'missing_evaluation_reviewer',
        'Avaliador não informado.'
    );
    const reason = input.override
        ? normalizeRequiredText(input.reason, 'missing_evaluation_override_reason', 'Override exige motivo.')
        : String(input.reason || '').trim() || null;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const submission = await getSubmissionByProtocolInTransaction(db, protocol);
        if (!submission) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_submission_not_found' };
        }
        if (submission.status === 'waiting') {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, submission };
        }
        if (submission.status !== 'reviewing') {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_not_reviewing', submission };
        }
        if (!input.override && submission.reviewer_id !== actorId) {
            await db.exec('ROLLBACK');
            return {
                ok: false,
                code: 'evaluation_reviewer_mismatch',
                reviewerId: submission.reviewer_id,
                submission,
            };
        }

        await db.run(
            `UPDATE clover_evaluation_submissions
             SET status = 'waiting', reviewer_id = NULL, review_started_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'reviewing'`,
            [submission.id]
        );
        await recordEventInTransaction(db, {
            submissionId: submission.id,
            eventType: input.override ? 'released_override' : 'released',
            actorId,
            fromStatus: 'reviewing',
            toStatus: 'waiting',
            reason,
            metadata: { previous_reviewer_id: submission.reviewer_id },
        });
        const returned = await getSubmissionByIdInTransaction(db, submission.id);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, submission: returned };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function takeoverEvaluationSubmission(db, input = {}) {
    const protocol = normalizeProtocol(input.protocol);
    const reviewerId = normalizeJid(input.reviewerId) || normalizeRequiredText(
        input.reviewerId,
        'missing_evaluation_reviewer',
        'Novo avaliador não informado.'
    );
    const reason = normalizeRequiredText(
        input.reason,
        'missing_evaluation_override_reason',
        'Tomada de avaliação exige motivo.'
    );

    await db.exec('BEGIN IMMEDIATE');
    try {
        const submission = await getSubmissionByProtocolInTransaction(db, protocol);
        if (!submission) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_submission_not_found' };
        }
        if (submission.status !== 'reviewing') {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_not_reviewing', submission };
        }
        if (submission.reviewer_id === reviewerId) {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, submission };
        }
        const previousReviewer = submission.reviewer_id;
        await db.run(
            `UPDATE clover_evaluation_submissions
             SET reviewer_id = ?, review_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'reviewing'`,
            [reviewerId, submission.id]
        );
        await recordEventInTransaction(db, {
            submissionId: submission.id,
            eventType: 'takeover',
            actorId: reviewerId,
            fromStatus: 'reviewing',
            toStatus: 'reviewing',
            reason,
            metadata: { previous_reviewer_id: previousReviewer },
        });
        const taken = await getSubmissionByIdInTransaction(db, submission.id);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, submission: taken };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cancelWaitingEvaluationSubmission(db, input = {}) {
    const protocol = normalizeProtocol(input.protocol);
    const playerId = normalizeJid(input.playerId) || normalizeRequiredText(
        input.playerId,
        'missing_evaluation_player',
        'Player não informado.'
    );
    const reason = String(input.reason || '').trim() || 'cancelled_by_player';

    await db.exec('BEGIN IMMEDIATE');
    try {
        const submission = await getSubmissionByProtocolInTransaction(db, protocol);
        if (!submission || submission.player_id !== playerId) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_submission_not_found' };
        }
        if (submission.status === 'cancelled') {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, submission };
        }
        if (submission.status !== 'waiting') {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_cannot_cancel', submission };
        }
        await db.run(
            `UPDATE clover_evaluation_submissions
             SET status = 'cancelled', decision_reason = ?, resolved_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'waiting'`,
            [reason, submission.id]
        );
        await recordEventInTransaction(db, {
            submissionId: submission.id,
            eventType: 'cancelled',
            actorId: playerId,
            fromStatus: 'waiting',
            toStatus: 'cancelled',
            reason,
        });
        const cancelled = await getSubmissionByIdInTransaction(db, submission.id);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, submission: cancelled };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function resolveEvaluationSubmissionAtomic(db, input = {}) {
    const protocol = normalizeProtocol(input.protocol);
    const reviewerId = normalizeJid(input.reviewerId) || normalizeRequiredText(
        input.reviewerId,
        'missing_evaluation_reviewer',
        'Avaliador não informado.'
    );
    const outcome = normalizeToken(input.outcome);
    if (!RESOLUTION_STATUSES.has(outcome)) {
        throw new UniversalEvaluationError('invalid_evaluation_outcome', 'Resultado de avaliação inválido.', { outcome });
    }
    const reason = String(input.reason || '').trim() || null;
    if (outcome === 'denied' && !reason) {
        throw new UniversalEvaluationError('missing_evaluation_denial_reason', 'Negativa exige motivo.');
    }
    const finalPayload = input.finalPayload === undefined || input.finalPayload === null
        ? null
        : String(input.finalPayload).trim();

    await db.exec('BEGIN IMMEDIATE');
    try {
        let submission = await getSubmissionByProtocolInTransaction(db, protocol);
        if (!submission) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_submission_not_found' };
        }
        if (TERMINAL_STATUSES.has(submission.status)) {
            if (submission.status === outcome) {
                await db.exec('COMMIT');
                return { ok: true, duplicate: true, submission, domainResult: null };
            }
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_already_resolved', submission };
        }
        if (submission.status === 'awaiting_followup') {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_awaiting_followup', submission };
        }

        if (submission.status === 'waiting') {
            if (input.allowClaimWaiting === false) {
                await db.exec('ROLLBACK');
                return { ok: false, code: 'evaluation_not_claimed', submission };
            }
            await db.run(
                `UPDATE clover_evaluation_submissions
                 SET status = 'reviewing', reviewer_id = ?, review_started_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'waiting'`,
                [reviewerId, submission.id]
            );
            await recordEventInTransaction(db, {
                submissionId: submission.id,
                eventType: 'claimed',
                actorId: reviewerId,
                fromStatus: 'waiting',
                toStatus: 'reviewing',
                metadata: { direct_resolution: true },
            });
            submission = await getSubmissionByIdInTransaction(db, submission.id);
        }

        if (submission.status !== 'reviewing') {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'evaluation_not_reviewing', submission };
        }
        if (submission.reviewer_id !== reviewerId) {
            await db.exec('ROLLBACK');
            return {
                ok: false,
                code: 'evaluation_reviewer_mismatch',
                reviewerId: submission.reviewer_id,
                submission,
            };
        }

        let domainResult = null;
        if (typeof input.domainMutator === 'function') {
            domainResult = await input.domainMutator({ db, submission });
        }

        const finalPayloadHash = finalPayload ? sha256(finalPayload) : null;
        const resolvedAtSql = outcome === 'awaiting_followup' ? 'NULL' : 'CURRENT_TIMESTAMP';
        const updated = await db.run(
            `UPDATE clover_evaluation_submissions
             SET status = ?, final_payload = ?, final_payload_hash = ?, decision_reason = ?,
                 resolved_at = ${resolvedAtSql}, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'reviewing' AND reviewer_id = ?`,
            [outcome, finalPayload, finalPayloadHash, reason, submission.id, reviewerId]
        );
        if (Number(updated?.changes || 0) !== 1) {
            throw new UniversalEvaluationError('evaluation_resolution_race', 'A submissão mudou durante a resolução.');
        }
        await recordEventInTransaction(db, {
            submissionId: submission.id,
            eventType: outcome,
            actorId: reviewerId,
            fromStatus: 'reviewing',
            toStatus: outcome,
            reason,
            metadata: { has_final_payload: Boolean(finalPayload) },
        });
        const resolved = await getSubmissionByIdInTransaction(db, submission.id);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, submission: resolved, domainResult };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listReviewingSubmissions(db, options = {}) {
    const reviewerId = options.reviewerId ? (normalizeJid(options.reviewerId) || String(options.reviewerId).trim()) : null;
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    return db.all(
        `SELECT * FROM clover_evaluation_submissions
         WHERE status = 'reviewing'
           AND (? IS NULL OR reviewer_id = ?)
         ORDER BY datetime(review_started_at) ASC, id ASC
         LIMIT ?`,
        [reviewerId, reviewerId, limit]
    );
}

module.exports = {
    CATEGORY_ALIASES,
    EVALUATION_CATEGORIES,
    TERMINAL_STATUSES,
    UniversalEvaluationError,
    cancelWaitingEvaluationSubmission,
    categoryLabel,
    claimEvaluationSubmission,
    claimNextEvaluationSubmission,
    createEvaluationSubmission,
    getEvaluationSubmission,
    getEvaluationSubmissionEvents,
    listPlayerSubmissions,
    listReviewingSubmissions,
    listWaitingSubmissions,
    normalizeEvaluationCategory,
    normalizeProtocol,
    normalizeSelector,
    renderProtocol,
    resolveEvaluationSubmissionAtomic,
    returnEvaluationSubmissionToQueue,
    takeoverEvaluationSubmission,
};
