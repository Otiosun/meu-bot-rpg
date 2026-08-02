'use strict';

const { isSameUser, normalizeJid } = require('../groupAccess');
const core = require('./raidRewardProposalCoreService');

const PROPOSAL_AUTHOR_TABLE = 'clover_raid_reward_proposal_authors';
const PROPOSAL_AUTHOR_INSERT_TRIGGER = 'trg_clover_raid_reward_proposal_author_insert';
const PROPOSAL_AUTHOR_RESUBMIT_TRIGGER = 'trg_clover_raid_reward_proposal_author_resubmit';
const PROPOSAL_SELF_REVIEW_TRIGGER = 'trg_clover_raid_reward_proposal_self_review_block';

async function ensureProposalAuthorTrackingSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${PROPOSAL_AUTHOR_TABLE} (
            proposal_id INTEGER NOT NULL,
            actor_id TEXT NOT NULL,
            first_action TEXT NOT NULL
                CHECK (first_action IN ('created', 'resubmitted', 'legacy_current_proposer')),
            first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (proposal_id, actor_id),
            FOREIGN KEY (proposal_id) REFERENCES clover_raid_reward_proposals(id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_reward_proposal_authors_actor
        ON ${PROPOSAL_AUTHOR_TABLE} (actor_id, proposal_id)
    `);

    await db.run(
        `INSERT OR IGNORE INTO ${PROPOSAL_AUTHOR_TABLE}
         (proposal_id, actor_id, first_action)
         SELECT id, proposed_by, 'legacy_current_proposer'
         FROM clover_raid_reward_proposals
         WHERE proposed_by IS NOT NULL AND TRIM(proposed_by) <> ''`
    );

    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${PROPOSAL_AUTHOR_INSERT_TRIGGER}
        AFTER INSERT ON clover_raid_reward_proposals
        WHEN NEW.proposed_by IS NOT NULL AND TRIM(NEW.proposed_by) <> ''
        BEGIN
            INSERT OR IGNORE INTO ${PROPOSAL_AUTHOR_TABLE}
            (proposal_id, actor_id, first_action)
            VALUES (NEW.id, NEW.proposed_by, 'created');
        END
    `);

    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${PROPOSAL_AUTHOR_RESUBMIT_TRIGGER}
        AFTER UPDATE OF proposed_by ON clover_raid_reward_proposals
        WHEN NEW.proposed_by IS NOT NULL
             AND TRIM(NEW.proposed_by) <> ''
             AND COALESCE(NEW.proposed_by, '') <> COALESCE(OLD.proposed_by, '')
        BEGIN
            INSERT OR IGNORE INTO ${PROPOSAL_AUTHOR_TABLE}
            (proposal_id, actor_id, first_action)
            VALUES (NEW.id, NEW.proposed_by, 'resubmitted');
        END
    `);

    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${PROPOSAL_SELF_REVIEW_TRIGGER}
        BEFORE UPDATE OF status, reviewed_by ON clover_raid_reward_proposals
        WHEN NEW.reviewed_by IS NOT NULL
             AND TRIM(NEW.reviewed_by) <> ''
             AND EXISTS (
                 SELECT 1
                 FROM ${PROPOSAL_AUTHOR_TABLE} author
                 WHERE author.proposal_id = NEW.id
                   AND author.actor_id = NEW.reviewed_by
             )
        BEGIN
            SELECT RAISE(ABORT, 'self_review_blocked');
        END
    `);
}

async function ensureRaidRewardProposalSchema(db) {
    await core.ensureRaidRewardProposalSchema(db);
    await ensureProposalAuthorTrackingSchema(db);
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

async function createRaidRewardProposal(db, input) {
    await ensureRaidRewardProposalSchema(db);
    return core.createRaidRewardProposal(db, input);
}

async function listRaidRewardProposals(db, input = {}) {
    await ensureRaidRewardProposalSchema(db);
    const proposals = await core.listRaidRewardProposals(db, input);
    return Promise.all((proposals || []).map((proposal) => (
        applyHistoricalReviewGuard(db, proposal, input.actorId)
    )));
}

async function reviewRaidRewardProposal(db, input) {
    await ensureRaidRewardProposalSchema(db);
    await assertReviewerNotProposalAuthor(db, input?.proposalId, input?.actorId);
    try {
        return await core.reviewRaidRewardProposal(db, input);
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
    assertReviewerNotProposalAuthor,
    createRaidRewardProposal,
    ensureProposalAuthorTrackingSchema,
    ensureRaidRewardProposalSchema,
    isProposalAuthor,
    isSelfReviewConstraint,
    listRaidRewardProposals,
    normalizeSelfReviewError,
    readProposalAuthorIds,
    reviewRaidRewardProposal,
};
