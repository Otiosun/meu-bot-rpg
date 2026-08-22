'use strict';

const { isSameUser, normalizeJid } = require('../groupAccess');
const core = require('./raidRewardProposalCoreService');
const revisionService = require('./raidRewardProposalRevisionService');

const PROPOSAL_AUTHOR_TABLE = 'clover_raid_reward_proposal_authors';
const PROPOSAL_AUTHOR_INSERT_TRIGGER = 'trg_clover_raid_reward_proposal_author_insert';
const PROPOSAL_AUTHOR_RESUBMIT_TRIGGER = 'trg_clover_raid_reward_proposal_author_resubmit';
const PROPOSAL_SELF_REVIEW_TRIGGER = 'trg_clover_raid_reward_proposal_self_review_block';

async function ensureProposalAuthorTrackingSchema(db) {
    void db;
}

async function ensureRaidRewardProposalSchema(db) {
    await core.ensureRaidRewardProposalSchema(db);
    await ensureProposalAuthorTrackingSchema(db);
    await revisionService.ensureProposalRevisionSchema(db);
}

async function readProposalAuthorIds(db, proposalId) {
    const id = Number(proposalId);
    if (!Number.isSafeInteger(id)) return [];

    const rows = await db.all(
        `SELECT actor_id
         FROM ${PROPOSAL_AUTHOR_TABLE}
         WHERE proposal_id = ?
         ORDER BY first_seen_at ASC, actor_id ASC`,
        [id]
    ).catch(() => []);
    const proposal = await db.get(
        `SELECT proposed_by
         FROM clover_raid_reward_proposals
         WHERE id = ?`,
        [id]
    ).catch(() => null);

    return [...new Set([
        ...(rows || []).map((row) => normalizeJid(row.actor_id)).filter(Boolean),
        normalizeJid(proposal?.proposed_by),
    ].filter(Boolean))];
}

async function isProposalAuthor(db, proposalId, actorId) {
    const actor = normalizeJid(actorId);
    if (!actor) return false;
    const authors = await readProposalAuthorIds(db, proposalId);
    return authors.some((authorId) => isSameUser(actor, authorId));
}

async function assertReviewerNotProposalAuthor(db, proposalId, actorId) {
    if (await isProposalAuthor(db, proposalId, actorId)) {
        throw new core.RaidRewardProposalError(
            'Voce nao pode revisar uma proposta que criou ou reenviou.',
            'self_review_blocked',
            { proposalId: String(proposalId) }
        );
    }
}

function isSelfReviewConstraint(error) {
    return String(error?.message || '').includes('self_review_blocked');
}

function normalizeSelfReviewError(error, proposalId) {
    if (error?.code === 'self_review_blocked') return error;
    if (!isSelfReviewConstraint(error)) return error;
    return new core.RaidRewardProposalError(
        'Voce nao pode revisar uma proposta que criou ou reenviou.',
        'self_review_blocked',
        { proposalId: String(proposalId) }
    );
}

async function applyHistoricalReviewGuard(db, proposal, actorId) {
    if (!proposal?.id || !actorId) return proposal;
    const blocked = await isProposalAuthor(db, proposal.id, actorId);
    return {
        ...proposal,
        canReview: Boolean(proposal.canReview && !blocked),
        selfReviewBlocked: blocked,
    };
}

async function applyProposalGovernanceMetadata(db, proposal, actorId = null) {
    if (!proposal?.id) return proposal;
    const guarded = await applyHistoricalReviewGuard(db, proposal, actorId);
    const revision = await revisionService.getProposalRevisionSummary(db, proposal.id);
    return {
        ...guarded,
        ...revision,
    };
}

async function createRaidRewardProposal(db, input) {
    await ensureRaidRewardProposalSchema(db);
    const result = await core.createRaidRewardProposal(db, input);
    if (!result?.proposal) return result;
    return {
        ...result,
        proposal: await applyProposalGovernanceMetadata(db, result.proposal, input?.actorId),
    };
}

async function listRaidRewardProposals(db, input = {}) {
    await ensureRaidRewardProposalSchema(db);
    const proposals = await core.listRaidRewardProposals(db, input);
    return Promise.all((proposals || []).map((proposal) => (
        applyProposalGovernanceMetadata(db, proposal, input.actorId)
    )));
}

async function reviewRaidRewardProposal(db, input) {
    await ensureRaidRewardProposalSchema(db);
    await assertReviewerNotProposalAuthor(db, input?.proposalId, input?.actorId);
    try {
        const result = await core.reviewRaidRewardProposal(db, input);
        if (!result?.proposal) return result;
        return {
            ...result,
            proposal: await applyProposalGovernanceMetadata(db, result.proposal, input?.actorId),
        };
    } catch (error) {
        throw normalizeSelfReviewError(error, input?.proposalId);
    }
}

module.exports = {
    PROPOSAL_AUTHOR_INSERT_TRIGGER,
    PROPOSAL_AUTHOR_RESUBMIT_TRIGGER,
    PROPOSAL_AUTHOR_TABLE,
    PROPOSAL_SELF_REVIEW_TRIGGER,
    RaidRewardProposalError: core.RaidRewardProposalError,
    applyHistoricalReviewGuard,
    applyProposalGovernanceMetadata,
    assertReviewerNotProposalAuthor,
    createRaidRewardProposal,
    ensureProposalAuthorTrackingSchema,
    ensureRaidRewardProposalSchema,
    getProposalRevisionSummary: revisionService.getProposalRevisionSummary,
    isProposalAuthor,
    isSelfReviewConstraint,
    listRaidRewardProposals,
    normalizeSelfReviewError,
    readProposalAuthorIds,
    readProposalRevisions: revisionService.readProposalRevisions,
    reviewRaidRewardProposal,
};
