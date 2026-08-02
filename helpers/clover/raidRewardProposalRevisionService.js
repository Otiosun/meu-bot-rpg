'use strict';

const PROPOSAL_REVISION_TABLE = 'clover_raid_reward_proposal_revisions';
const PROPOSAL_REVISION_INSERT_TRIGGER = 'trg_clover_raid_reward_proposal_revision_insert';
const PROPOSAL_REVISION_RESUBMIT_TRIGGER = 'trg_clover_raid_reward_proposal_revision_resubmit';
const PROPOSAL_REVISION_UPDATE_BLOCK_TRIGGER = 'trg_clover_raid_reward_proposal_revision_update_block';
const PROPOSAL_REVISION_DELETE_BLOCK_TRIGGER = 'trg_clover_raid_reward_proposal_revision_delete_block';

async function ensureProposalRevisionSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${PROPOSAL_REVISION_TABLE} (
            proposal_id INTEGER NOT NULL,
            revision_number INTEGER NOT NULL CHECK (revision_number > 0),
            submitted_by TEXT NOT NULL,
            submission_action TEXT NOT NULL
                CHECK (submission_action IN ('created', 'resubmitted', 'legacy_current_snapshot')),
            proposal_status TEXT NOT NULL,
            snapshot_json TEXT DEFAULT NULL,
            snapshot_hash TEXT DEFAULT NULL,
            snapshot_version INTEGER NOT NULL DEFAULT 1,
            submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (proposal_id, revision_number),
            FOREIGN KEY (proposal_id) REFERENCES clover_raid_reward_proposals(id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_reward_proposal_revisions_submitter
        ON ${PROPOSAL_REVISION_TABLE} (submitted_by, proposal_id, revision_number)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_reward_proposal_revisions_hash
        ON ${PROPOSAL_REVISION_TABLE} (proposal_id, snapshot_hash)
    `);

    await db.run(
        `INSERT OR IGNORE INTO ${PROPOSAL_REVISION_TABLE}
         (proposal_id, revision_number, submitted_by, submission_action,
          proposal_status, snapshot_json, snapshot_hash, snapshot_version, submitted_at)
         SELECT id, 1, proposed_by, 'legacy_current_snapshot', status,
                snapshot_json, snapshot_hash, COALESCE(snapshot_version, 1),
                COALESCE(proposed_at, CURRENT_TIMESTAMP)
         FROM clover_raid_reward_proposals
         WHERE proposed_by IS NOT NULL AND TRIM(proposed_by) <> ''`
    );

    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${PROPOSAL_REVISION_INSERT_TRIGGER}
        AFTER INSERT ON clover_raid_reward_proposals
        WHEN NEW.proposed_by IS NOT NULL AND TRIM(NEW.proposed_by) <> ''
        BEGIN
            INSERT OR IGNORE INTO ${PROPOSAL_REVISION_TABLE}
            (proposal_id, revision_number, submitted_by, submission_action,
             proposal_status, snapshot_json, snapshot_hash, snapshot_version, submitted_at)
            VALUES (
                NEW.id,
                1,
                NEW.proposed_by,
                'created',
                NEW.status,
                NEW.snapshot_json,
                NEW.snapshot_hash,
                COALESCE(NEW.snapshot_version, 1),
                COALESCE(NEW.proposed_at, CURRENT_TIMESTAMP)
            );
        END
    `);

    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${PROPOSAL_REVISION_RESUBMIT_TRIGGER}
        AFTER UPDATE OF status, proposed_by, snapshot_json, snapshot_hash, snapshot_version
        ON clover_raid_reward_proposals
        WHEN OLD.status = 'returned' AND NEW.status = 'pending'
        BEGIN
            INSERT INTO ${PROPOSAL_REVISION_TABLE}
            (proposal_id, revision_number, submitted_by, submission_action,
             proposal_status, snapshot_json, snapshot_hash, snapshot_version, submitted_at)
            SELECT
                NEW.id,
                COALESCE(MAX(revision_number), 0) + 1,
                NEW.proposed_by,
                'resubmitted',
                NEW.status,
                NEW.snapshot_json,
                NEW.snapshot_hash,
                COALESCE(NEW.snapshot_version, 1),
                COALESCE(NEW.proposed_at, CURRENT_TIMESTAMP)
            FROM ${PROPOSAL_REVISION_TABLE}
            WHERE proposal_id = NEW.id;
        END
    `);

    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${PROPOSAL_REVISION_UPDATE_BLOCK_TRIGGER}
        BEFORE UPDATE ON ${PROPOSAL_REVISION_TABLE}
        BEGIN
            SELECT RAISE(ABORT, 'proposal_revision_immutable');
        END
    `);

    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${PROPOSAL_REVISION_DELETE_BLOCK_TRIGGER}
        BEFORE DELETE ON ${PROPOSAL_REVISION_TABLE}
        BEGIN
            SELECT RAISE(ABORT, 'proposal_revision_immutable');
        END
    `);
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
