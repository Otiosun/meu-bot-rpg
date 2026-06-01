const { BaseRepository } = require('./BaseRepository');

function normalizeLimit(limit) {
    if (limit === null || limit === undefined) return null;
    const parsed = parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return 20;
    return Math.min(parsed, 50);
}

class InvitationRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'deadly_vote_invitations',
            idPrefix: 'inv',
            insertColumns: [
                'deadly_vote_id',
                'record_id',
                'status',
                'invited_by_manager_id',
                'accepted_at',
                'refused_at',
                'expires_at',
            ],
            updateColumns: [
                'status',
                'accepted_at',
                'refused_at',
                'expires_at',
                'updated_at',
            ],
        });
    }

    async listByDeadlyVoteId(deadlyVoteId) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT *
             FROM deadly_vote_invitations
             WHERE deadly_vote_id = ?
             ORDER BY created_at DESC`,
            [deadlyVoteId]
        );
    }

    async listByDeadlyVoteIdWithRecords(deadlyVoteId, limit = 20) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT
                inv.*,
                r.name AS record_name,
                r.user_id AS record_user_id,
                dv.title AS deadly_vote_title,
                dv.code AS deadly_vote_code
             FROM deadly_vote_invitations inv
             INNER JOIN records r ON r.id = inv.record_id
             INNER JOIN deadly_votes dv ON dv.id = inv.deadly_vote_id
             WHERE inv.deadly_vote_id = ?
             ORDER BY COALESCE(inv.accepted_at, inv.refused_at, inv.updated_at, inv.created_at) DESC, inv.created_at DESC
             LIMIT ?`,
            [deadlyVoteId, normalizeLimit(limit) || 20]
        );
    }

    async getByVoteAndRecord(deadlyVoteId, recordId) {
        if (!this.db) return null;
        return this.db.get(
            `SELECT *
             FROM deadly_vote_invitations
             WHERE deadly_vote_id = ? AND record_id = ?`,
            [deadlyVoteId, recordId]
        );
    }

    async getByIdWithVote(id) {
        if (!this.db) return null;
        return this.db.get(
            `SELECT
                inv.*,
                dv.title AS deadly_vote_title,
                dv.code AS deadly_vote_code,
                dv.status AS deadly_vote_status,
                dv.max_slots AS deadly_vote_max_slots,
                dv.reserved_slots AS deadly_vote_reserved_slots
             FROM deadly_vote_invitations inv
             INNER JOIN deadly_votes dv ON dv.id = inv.deadly_vote_id
             WHERE inv.id = ?`,
            [id]
        );
    }

    async getPendingByVoteAndRecord(deadlyVoteId, recordId) {
        if (!this.db) return null;
        return this.db.get(
            `SELECT *
             FROM deadly_vote_invitations
             WHERE deadly_vote_id = ? AND record_id = ? AND status = 'pendente'`,
            [deadlyVoteId, recordId]
        );
    }

    async markAccepted(id) {
        if (!this.db) return null;
        await this.db.run(
            `UPDATE deadly_vote_invitations
             SET status = 'aceito',
                 accepted_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pendente'`,
            [id]
        );
        return this.getByIdWithVote(id);
    }

    async markRefused(id) {
        if (!this.db) return null;
        await this.db.run(
            `UPDATE deadly_vote_invitations
             SET status = 'recusado',
                 refused_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pendente'`,
            [id]
        );
        return this.getByIdWithVote(id);
    }

    async markSemVaga(id) {
        if (!this.db) return null;
        await this.db.run(
            `UPDATE deadly_vote_invitations
             SET status = 'sem_vaga',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pendente'`,
            [id]
        );
        return this.getByIdWithVote(id);
    }

    async revokePendingByDeadlyVoteId(deadlyVoteId) {
        if (!this.db) return { changes: 0 };

        const result = await this.db.run(
            `UPDATE deadly_vote_invitations
             SET status = 'revogado',
                 updated_at = CURRENT_TIMESTAMP
             WHERE deadly_vote_id = ? AND status = 'pendente'`,
            [deadlyVoteId]
        );

        return { changes: Number(result?.changes || 0) };
    }

    async listPendingByRecordId(recordId) {
        return this.listByRecordId(recordId, { status: 'pendente' });
    }

    async listByRecordId(recordId, { status = null, limit = null } = {}) {
        if (!this.db) return [];

        const params = [recordId];
        let statusClause = '';
        if (status) {
            statusClause = ' AND inv.status = ?';
            params.push(status);
        }
        const safeLimit = normalizeLimit(limit);
        let limitClause = '';
        if (safeLimit) {
            limitClause = ' LIMIT ?';
            params.push(safeLimit);
        }
        const orderClause = safeLimit
            ? 'COALESCE(inv.accepted_at, inv.refused_at, inv.updated_at, inv.created_at) DESC, inv.created_at DESC'
            : 'inv.created_at DESC';

        return this.db.all(
            `SELECT
                inv.*,
                dv.title AS deadly_vote_title,
                dv.code AS deadly_vote_code,
                dv.status AS deadly_vote_status
             FROM deadly_vote_invitations inv
             INNER JOIN deadly_votes dv ON dv.id = inv.deadly_vote_id
             WHERE inv.record_id = ?${statusClause}
             ORDER BY ${orderClause}${limitClause}`,
            params
        );
    }

    async listByRecordIdWithVotes(recordId, limit = 20) {
        return this.listByRecordId(recordId, { limit });
    }
}

module.exports = { InvitationRepository };
