const { RecordRepository } = require('../repositories');

class RecordService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.record || new RecordRepository(this.db);
    }

    async listByUserId(userId) {
        return this.repository.listByUserId(userId);
    }

    async createRecord(targetUserId, name) {
        if (!targetUserId) throw new Error('targetUserId is required');
        const safeName = String(name || '').trim();
        if (!safeName) throw new Error('name is required');

        if (!this.db) throw new Error('Database connection missing');
        if (typeof this.repository.tableExists === 'function' && !await this.repository.tableExists()) {
            throw new Error('Records table unavailable');
        }

        const existing = await this.repository.listByUserId(targetUserId);
        if (existing && existing.length) throw new Error('record already exists for user');

        const created = await this.repository.create({
            user_id: targetUserId,
            name: safeName,
            status: 'ativo',
        });

        return created;
    }

    async getById(recordId) {
        return this.repository.getById(recordId);
    }

    async getLatestByUserId(userId) {
        const rows = await this.repository.listByUserId(userId);
        return (rows && rows.length) ? rows[0] : null;
    }

    async listRecords(limit = 50) {
        return this.repository.list({ limit });
    }

    getStatus() {
        return { name: 'RecordService', ready: Boolean(this.db), implemented: true };
    }
}

module.exports = { RecordService };
