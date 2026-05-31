const { RecordRepository } = require('../repositories');

class RecordService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.record || new RecordRepository(this.db);
    }

    async listByUserId(userId) {
        return this.repository.listByUserId(userId);
    }

    getStatus() {
        return { name: 'RecordService', ready: true, implemented: false, repository: 'RecordRepository' };
    }
}

module.exports = { RecordService };
