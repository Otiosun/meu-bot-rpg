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
}

module.exports = { InvitationRepository };
