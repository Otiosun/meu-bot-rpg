const { BaseRepository } = require('./BaseRepository');

class RecordRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'records',
            idPrefix: 'rec',
            insertColumns: ['user_id', 'name', 'status', 'current_arcano_id'],
            updateColumns: ['name', 'status', 'current_arcano_id', 'updated_at'],
        });
    }

    async listByUserId(userId) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT *
             FROM records
             WHERE user_id = ?
             ORDER BY created_at DESC`,
            [userId]
        );
    }
}

module.exports = { RecordRepository };
