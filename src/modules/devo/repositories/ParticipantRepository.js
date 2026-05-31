const { BaseRepository } = require('./BaseRepository');

class ParticipantRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'deadly_vote_participants',
            idPrefix: 'part',
            insertColumns: [
                'deadly_vote_id',
                'record_id',
                'invitation_id',
                'status',
                'joined_at',
                'resolved_at',
            ],
            updateColumns: ['status', 'joined_at', 'resolved_at', 'updated_at'],
        });
    }

    async listByDeadlyVoteId(deadlyVoteId) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT *
             FROM deadly_vote_participants
             WHERE deadly_vote_id = ?
             ORDER BY created_at DESC`,
            [deadlyVoteId]
        );
    }
}

module.exports = { ParticipantRepository };
