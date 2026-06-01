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

    async listByUserIds(userIds = []) {
        if (!this.db) return [];
        const values = Array.from(new Set(
            (Array.isArray(userIds) ? userIds : [userIds])
                .map((value) => String(value || '').trim())
                .filter(Boolean)
        ));
        if (!values.length) return [];

        const placeholders = values.map(() => '?').join(', ');
        return this.db.all(
            `SELECT *
             FROM records
             WHERE user_id IN (${placeholders})
             ORDER BY created_at DESC`,
            values
        );
    }

    async listByPhoneIdentity(phoneNumber) {
        if (!this.db) return [];
        const phone = String(phoneNumber || '').replace(/\D/g, '');
        if (!phone) return [];

        return this.db.all(
            `SELECT *
             FROM records
             WHERE user_id LIKE ? OR user_id LIKE ? OR user_id = ?
             ORDER BY created_at DESC`,
            [`${phone}@%`, `${phone}:%@%`, phone]
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
