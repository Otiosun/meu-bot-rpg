const { BaseRepository } = require('./BaseRepository');

class ManagerRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'manager_profiles',
            idPrefix: 'mgr',
            insertColumns: ['user_id', 'codename', 'animal', 'number', 'permission_level', 'active'],
            updateColumns: ['codename', 'animal', 'number', 'permission_level', 'active', 'updated_at'],
        });
    }

    async getByUserId(userId) {
        if (!this.db) return null;
        return this.db.get('SELECT * FROM manager_profiles WHERE user_id = ?', [userId]);
    }

    async getByUserIds(userIds = []) {
        if (!this.db) return null;
        const values = Array.from(new Set(
            (Array.isArray(userIds) ? userIds : [userIds])
                .map((value) => String(value || '').trim())
                .filter(Boolean)
        ));
        if (!values.length) return null;

        const placeholders = values.map(() => '?').join(', ');
        return this.db.get(
            `SELECT *
             FROM manager_profiles
             WHERE user_id IN (${placeholders})
             ORDER BY created_at DESC
             LIMIT 1`,
            values
        );
    }
}

module.exports = { ManagerRepository };
