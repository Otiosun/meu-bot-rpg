const { BaseRepository } = require('./BaseRepository');

class DeadlyVoteRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'deadly_votes',
            idPrefix: 'dv',
            insertColumns: [
                'title',
                'code',
                'status',
                'max_slots',
                'reserved_slots',
                'created_by_manager_id',
                'started_at',
                'ended_at',
            ],
            updateColumns: [
                'title',
                'code',
                'status',
                'max_slots',
                'reserved_slots',
                'started_at',
                'ended_at',
                'updated_at',
            ],
        });
    }

    async getByCode(code) {
        if (!this.db) return null;
        return this.db.get('SELECT * FROM deadly_votes WHERE code = ?', [code]);
    }

    async listVotes({ status = null, limit = 20 } = {}) {
        if (!this.db) return [];

        if (status) {
            return this.db.all(
                `SELECT *
                 FROM deadly_votes
                 WHERE status = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
                [status, limit]
            );
        }

        return this.list({ limit });
    }
}

module.exports = { DeadlyVoteRepository };
