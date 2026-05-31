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

    async markDead(recordId) {
        if (!this.db) return { changes: 0, record: null };

        const result = await this.db.run(
            `UPDATE records
             SET status = 'morto',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'ativo'`,
            [recordId]
        );

        return {
            changes: Number(result?.changes || 0),
            record: await this.getById(recordId),
        };
    }
}

module.exports = { RecordRepository };
