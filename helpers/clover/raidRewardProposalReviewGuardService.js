'use strict';

const idempotency = require('./raidRewardProposalIdempotencyService');
const { RaidRewardProposalError } = require('./raidRewardProposalService');

const STRICT_REVIEW_CONTEXT_TRIGGER = 'trg_clover_raid_reward_review_context_guard';

async function ensureStrictRewardProposalReviewContext(db) {
    await idempotency.ensureRaidRewardProposalIdempotencySchema(db);
    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${STRICT_REVIEW_CONTEXT_TRIGGER}
        BEFORE UPDATE OF status, reviewed_by ON clover_raid_reward_proposals
        WHEN OLD.status = 'pending'
             AND NEW.status IN ('returned', 'rejected', 'delivered')
             AND NEW.reviewed_by IS NOT NULL
             AND TRIM(NEW.reviewed_by) <> ''
             AND EXISTS (
                 SELECT 1
                 FROM ${idempotency.INTENT_TABLE} pending_intent
                 WHERE pending_intent.proposal_id = NEW.id
                   AND pending_intent.actor_id = NEW.reviewed_by
                   AND pending_intent.status = 'processing'
             )
             AND NOT EXISTS (
                 SELECT 1
                 FROM ${idempotency.INTENT_TABLE} intent
                 WHERE intent.idempotency_key = (
                     SELECT latest.idempotency_key
                     FROM ${idempotency.INTENT_TABLE} latest
                     WHERE latest.proposal_id = NEW.id
                       AND latest.actor_id = NEW.reviewed_by
                       AND latest.status = 'processing'
                     ORDER BY latest.updated_at DESC, latest.idempotency_key DESC
                     LIMIT 1
                 )
                   AND intent.decision = CASE NEW.status
                       WHEN 'delivered' THEN 'approve'
                       WHEN 'returned' THEN 'return'
                       ELSE 'reject'
                   END
                   AND COALESCE(intent.review_note, '') = COALESCE(NEW.review_note, '')
                   AND COALESCE(intent.expected_snapshot_hash, '') = COALESCE(OLD.snapshot_hash, '')
             )
        BEGIN
            SELECT RAISE(ABORT, 'raid_reward_review_context_mismatch');
        END
    `);
}

function normalizeGuardError(error) {
    if (!String(error?.message || '').includes('raid_reward_review_context_mismatch')) {
        return error;
    }
    return new RaidRewardProposalError(
        'A proposta mudou desde a intenção de revisão original. Atualize a fila antes de tentar novamente.',
        'idempotency_stale_intent',
        { retryable: false }
    );
}

async function reviewRaidRewardProposalGuarded(db, input = {}, options = {}) {
    await ensureStrictRewardProposalReviewContext(db);
    try {
        return await idempotency.reviewRaidRewardProposalIdempotent(db, input, options);
    } catch (error) {
        throw normalizeGuardError(error);
    }
}

module.exports = {
    STRICT_REVIEW_CONTEXT_TRIGGER,
    ensureStrictRewardProposalReviewContext,
    normalizeGuardError,
    reviewRaidRewardProposalGuarded,
};
