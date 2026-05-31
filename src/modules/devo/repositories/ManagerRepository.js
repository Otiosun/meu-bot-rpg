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
}

module.exports = { ManagerRepository };
