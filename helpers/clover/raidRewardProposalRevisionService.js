'use strict';

const PROPOSAL_REVISION_TABLE = 'clover_raid_reward_proposal_revisions';
const PROPOSAL_REVISION_INSERT_TRIGGER = 'trg_clover_raid_reward_proposal_revision_insert';
const PROPOSAL_REVISION_RESUBMIT_TRIGGER = 'trg_clover_raid_reward_proposal_revision_resubmit';
const PROPOSAL_REVISION_UPDATE_BLOCK_TRIGGER = 'trg_clover_raid_reward_proposal_revision_update_block';
const PROPOSAL_REVISION_DELETE_BLOCK_TRIGGER = 'trg_clover_raid_reward_proposal_revision_delete_block';

async function ensureProposalRevisionSchema(db) {
    void db;
}

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function serializeRevision(row) {
    if (!row) return null;
    return {
        proposalId: String(row.proposal_id),
        revisionNumber: Number(row.revision_number),
        submittedBy: row.submitted_by,
        submissionAction: row.submission_action,
        proposalStatus: row.proposal_status,
        snapshot: parseJson(row.snapshot_json, null),
        snapshotHash: row.snapshot_hash || null,
        snapshotVersion: Number(row.snapshot_version || 1),
        submittedAt: row.submitted_at || null,
    };
}

async function readProposalRevisions(db, proposalId) {
    const id = Number(proposalId);
    if (!Number.isSafeInteger(id)) return [];
    const rows = await db.all(
        `SELECT proposal_id, revision_number, submitted_by, submission_action,
                proposal_status, snapshot_json, snapshot_hash, snapshot_version, submitted_at
         FROM ${PROPOSAL_REVISION_TABLE}
         WHERE proposal_id = ?
         ORDER BY revision_number ASC`,
        [id]
    ).catch(() => []);
    return (rows || []).map(serializeRevision);
}

async function getProposalRevisionSummary(db, proposalId) {
    const revisions = await readProposalRevisions(db, proposalId);
    const current = revisions.length ? revisions[revisions.length - 1] : null;
    return {
        revisionCount: revisions.length,
        currentRevision: current?.revisionNumber || 0,
        currentRevisionHash: current?.snapshotHash || null,
        lastSubmittedBy: current?.submittedBy || null,
        lastSubmittedAt: current?.submittedAt || null,
    };
}

module.exports = {
    PROPOSAL_REVISION_DELETE_BLOCK_TRIGGER,
    PROPOSAL_REVISION_INSERT_TRIGGER,
    PROPOSAL_REVISION_RESUBMIT_TRIGGER,
    PROPOSAL_REVISION_TABLE,
    PROPOSAL_REVISION_UPDATE_BLOCK_TRIGGER,
    ensureProposalRevisionSchema,
    getProposalRevisionSummary,
    parseJson,
    readProposalRevisions,
    serializeRevision,
};
