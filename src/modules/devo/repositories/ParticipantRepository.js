const { BaseRepository, buildId } = require('./BaseRepository');

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

    async getByVoteAndRecord(deadlyVoteId, recordId) {
        if (!this.db) return null;
        return this.db.get(
            `SELECT *
             FROM deadly_vote_participants
             WHERE deadly_vote_id = ? AND record_id = ?`,
            [deadlyVoteId, recordId]
        );
    }

    async createConfirmed({ deadlyVoteId, recordId, invitationId = null } = {}) {
        if (!this.db) return null;
        const id = buildId(this.idPrefix);

        await this.db.run(
            `INSERT INTO deadly_vote_participants (
                id,
                deadly_vote_id,
                record_id,
                invitation_id,
                status,
                joined_at
             )
             VALUES (?, ?, ?, ?, 'confirmado', CURRENT_TIMESTAMP)`,
            [id, deadlyVoteId, recordId, invitationId]
        );

        return this.getById(id);
    }
}

module.exports = { ParticipantRepository };
