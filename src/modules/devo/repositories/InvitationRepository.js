const { BaseRepository } = require('./BaseRepository');

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

    async getByVoteAndRecord(deadlyVoteId, recordId) {
        if (!this.db) return null;
        return this.db.get(
            `SELECT *
             FROM deadly_vote_invitations
             WHERE deadly_vote_id = ? AND record_id = ?`,
            [deadlyVoteId, recordId]
        );
    }

    async listPendingByRecordId(recordId) {
        return this.listByRecordId(recordId, { status: 'pendente' });
    }

    async listByRecordId(recordId, { status = null } = {}) {
        if (!this.db) return [];

        const params = [recordId];
        let statusClause = '';
        if (status) {
            statusClause = ' AND inv.status = ?';
            params.push(status);
        }

        return this.db.all(
            `SELECT
                inv.*,
                dv.title AS deadly_vote_title,
                dv.code AS deadly_vote_code,
                dv.status AS deadly_vote_status
             FROM deadly_vote_invitations inv
             INNER JOIN deadly_votes dv ON dv.id = inv.deadly_vote_id
             WHERE inv.record_id = ?${statusClause}
             ORDER BY inv.created_at DESC`,
            params
        );
    }
}

module.exports = { InvitationRepository };
