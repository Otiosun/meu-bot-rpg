'use strict';

const crypto = require('crypto');
const { normalizeJid } = require('../groupAccess');
const { hasAccessPermission } = require('./accessControlService');
const base = require('./raidRewardProposalService');
const { mutationFingerprint } = require('./raidMutationIdempotency');

const INTENT_TABLE = 'clover_raid_reward_review_intents';
const EVENT_TABLE = 'clover_raid_reward_review_events';
const REVIEW_CAPTURE_TRIGGER = 'trg_clover_raid_reward_review_capture';
const EVENT_UPDATE_BLOCK_TRIGGER = 'trg_clover_raid_reward_review_event_update_block';
const EVENT_DELETE_BLOCK_TRIGGER = 'trg_clover_raid_reward_review_event_delete_block';
const DEFAULT_LEASE_MS = 90_000;

function optionalText(value) {
    const text = String(value || '').trim();
    return text || null;
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function createToken() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
}

function normalizeDecision(value) {
    const decision = String(value || '').trim().toLowerCase();
    if (!['approve', 'return', 'reject'].includes(decision)) {
        throw new base.RaidRewardProposalError('Decisao invalida.', 'invalid_review_decision');
    }
    return decision;
}

function statusForDecision(decision) {
    if (decision === 'approve') return 'delivered';
    if (decision === 'return') return 'returned';
    return 'rejected';
}

function proposalReviewPayload(input = {}) {
    return {
        proposalId: String(input.proposalId || '').trim(),
        actorId: normalizeJid(input.actorId) || String(input.actorId || '').trim(),
        decision: normalizeDecision(input.decision),
        note: optionalText(input.note),
    };
}

function leaseIsActive(row, now = Date.now()) {
    if (!row?.lease_expires_at) return false;
    const expiresAt = new Date(row.lease_expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now;
}

async function ensureRaidRewardProposalIdempotencySchema(db) {
    await base.ensureRaidRewardProposalSchema(db);
    void db;
}

async function readProposalRow(db, proposalId) {
    const id = Number(proposalId);
    const row = Number.isSafeInteger(id)
        ? await db.get(
            `SELECT id, raid_id, status, proposed_by, reviewed_by, review_note,
                    reviewed_at, delivery_key, delivery_result_json, snapshot_hash
             FROM clover_raid_reward_proposals
             WHERE id = ?`,
            [id]
        )
        : null;
    if (!row) {
        throw new base.RaidRewardProposalError('Proposta nao encontrada.', 'proposal_not_found');
    }
    return row;
}

async function readIntent(db, idempotencyKey) {
    return db.get(
        `SELECT * FROM ${INTENT_TABLE} WHERE idempotency_key = ?`,
        [idempotencyKey]
    );
}

async function readReviewEvent(db, idempotencyKey) {
    return db.get(
        `SELECT * FROM ${EVENT_TABLE} WHERE idempotency_key = ?`,
        [idempotencyKey]
    );
}

async function findSerializedProposal(db, proposalId, actorId, status) {
    const proposals = await base.listRaidRewardProposals(db, {
        actorId,
        status,
    });
    return (proposals || []).find((proposal) => String(proposal.id) === String(proposalId)) || null;
}

async function recoveredResult(db, event, actorId) {
    const current = await readProposalRow(db, event.proposal_id);
    const proposal = await findSerializedProposal(
        db,
        event.proposal_id,
        actorId,
        current.status
    );
    const delivery = safeJsonParse(event.delivery_result_json, null);
    return {
        ok: true,
        duplicate: true,
        idempotentReplay: true,
        historicalReplay: current.status !== event.proposal_status,
        proposal,
        ...(delivery ? { delivery } : {}),
        review: {
            proposalId: String(event.proposal_id),
            decision: event.decision,
            status: event.proposal_status,
            note: event.review_note || null,
            reviewedAt: event.reviewed_at || null,
        },
    };
}

async function authorizeReviewer(db, payload) {
    await base.assertReviewerNotProposalAuthor(db, payload.proposalId, payload.actorId);
    if (!payload.actorId || !await hasAccessPermission(db, payload.actorId, 'raid.reward.review')) {
        throw new base.RaidRewardProposalError(
            'Voce nao pode revisar recompensas de raid.',
            'forbidden'
        );
    }
}

async function prepareReviewIntent(db, input = {}, options = {}) {
    const idempotencyKey = optionalText(
        input.idempotencyKey || input.idempotency_key || options.idempotencyKey
    );
    if (!idempotencyKey) return { mode: 'direct' };

    await ensureRaidRewardProposalIdempotencySchema(db);
    const payload = proposalReviewPayload(input);
    await authorizeReviewer(db, payload);
    const row = await readProposalRow(db, payload.proposalId);
    const fingerprint = mutationFingerprint('review_raid_reward_proposal', payload);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const reviewEvent = await readReviewEvent(db, idempotencyKey);
        if (reviewEvent) {
            if (reviewEvent.fingerprint !== fingerprint) {
                throw new base.RaidRewardProposalError(
                    'Esta chave de idempotencia pertence a outra revisao de recompensa.',
                    'idempotency_conflict'
                );
            }
            await db.exec('COMMIT');
            return { mode: 'replay-event', idempotencyKey, payload, event: reviewEvent };
        }

        const intent = await readIntent(db, idempotencyKey);
        if (
            intent
            && (
                Number(intent.proposal_id) !== Number(row.id)
                || Number(intent.raid_id) !== Number(row.raid_id)
                || intent.actor_id !== payload.actorId
                || intent.decision !== payload.decision
                || intent.fingerprint !== fingerprint
            )
        ) {
            throw new base.RaidRewardProposalError(
                'Esta chave de idempotencia pertence a outra revisao de recompensa.',
                'idempotency_conflict'
            );
        }

        const storedResult = intent?.status === 'completed'
            ? safeJsonParse(intent.result_json, null)
            : null;
        if (storedResult && typeof storedResult === 'object') {
            await db.exec('COMMIT');
            return { mode: 'replay-result', idempotencyKey, payload, result: storedResult };
        }

        const now = Date.now();
        if (intent?.status === 'processing' && leaseIsActive(intent, now)) {
            throw new base.RaidRewardProposalError(
                'Esta revisao de recompensa ainda esta sendo processada.',
                'idempotency_in_progress',
                { retryable: true, leaseExpiresAt: intent.lease_expires_at }
            );
        }

        if (intent && intent.expected_snapshot_hash !== row.snapshot_hash) {
            throw new base.RaidRewardProposalError(
                'A proposta mudou desde a tentativa original e a chave nao pode ser reaplicada.',
                'idempotency_stale_intent',
                { proposalId: String(row.id) }
            );
        }
        if (row.status !== 'pending') {
            throw new base.RaidRewardProposalError(
                'A proposta ja nao esta pendente para esta tentativa.',
                'proposal_not_pending'
            );
        }

        const processingToken = createToken();
        const leaseExpiresAt = new Date(
            now + Number(options.leaseMs || DEFAULT_LEASE_MS)
        ).toISOString();
        if (intent) {
            await db.run(
                `UPDATE ${INTENT_TABLE}
                 SET status = 'processing', processing_token = ?, lease_expires_at = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE idempotency_key = ? AND fingerprint = ?`,
                [processingToken, leaseExpiresAt, idempotencyKey, fingerprint]
            );
        } else {
            await db.run(
                `INSERT INTO ${INTENT_TABLE}
                 (idempotency_key, proposal_id, raid_id, actor_id, decision, review_note,
                  fingerprint, expected_snapshot_hash, status, processing_token,
                  lease_expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    idempotencyKey,
                    Number(row.id),
                    Number(row.raid_id),
                    payload.actorId,
                    payload.decision,
                    payload.note,
                    fingerprint,
                    row.snapshot_hash || null,
                    processingToken,
                    leaseExpiresAt,
                ]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'execute',
            idempotencyKey,
            payload,
            fingerprint,
            processingToken,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function releaseReviewIntent(db, prepared) {
    if (!prepared?.idempotencyKey || !prepared?.processingToken) return;
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE ${INTENT_TABLE}
             SET status = 'pending', processing_token = NULL, lease_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE idempotency_key = ? AND fingerprint = ?
               AND processing_token = ? AND status = 'processing'`,
            [prepared.idempotencyKey, prepared.fingerprint, prepared.processingToken]
        );
        await db.exec('COMMIT');
    } catch {
        await db.exec('ROLLBACK').catch(() => null);
    }
}

async function completeReviewIntent(db, prepared, result) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const event = await readReviewEvent(db, prepared.idempotencyKey);
        if (!event || event.fingerprint !== prepared.fingerprint) {
            throw new base.RaidRewardProposalError(
                'A revisao foi aplicada, mas o recibo transacional nao foi encontrado.',
                'idempotency_review_receipt_missing',
                { retryable: true }
            );
        }
        await db.run(
            `UPDATE ${INTENT_TABLE}
             SET status = 'completed', result_json = ?, processing_token = NULL,
                 lease_expires_at = NULL, completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE idempotency_key = ? AND fingerprint = ?`,
            [JSON.stringify(result), prepared.idempotencyKey, prepared.fingerprint]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function reviewRaidRewardProposalIdempotent(db, input = {}, options = {}) {
    const prepared = await prepareReviewIntent(db, input, options);
    if (prepared.mode === 'direct') return base.reviewRaidRewardProposal(db, input);
    if (prepared.mode === 'replay-result') {
        return {
            ...prepared.result,
            duplicate: true,
            idempotentReplay: true,
        };
    }
    if (prepared.mode === 'replay-event') {
        return recoveredResult(db, prepared.event, prepared.payload.actorId);
    }

    let result;
    try {
        result = await base.reviewRaidRewardProposal(db, input);
    } catch (error) {
        await releaseReviewIntent(db, prepared);
        throw error;
    }

    // O trigger grava o review-event dentro da mesma transacao do dominio.
    // Se esta etapa falhar, o intent permanece processing e o retry recupera
    // o evento imutavel sem reaplicar a decisao a uma revisao posterior.
    await completeReviewIntent(db, prepared, result);
    return {
        ...result,
        idempotentReplay: false,
    };
}

module.exports = {
    DEFAULT_LEASE_MS,
    EVENT_TABLE,
    INTENT_TABLE,
    REVIEW_CAPTURE_TRIGGER,
    ensureRaidRewardProposalIdempotencySchema,
    prepareReviewIntent,
    readReviewEvent,
    recoveredResult,
    reviewRaidRewardProposalIdempotent,
};
