const { AuditRepository } = require('../repositories');

class AuditService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.audit || new AuditRepository(this.db);
    }

    async record(event) {
        if (!this.repository.hasDatabase() || !await this.repository.tableExists()) {
            return { ok: true, dryRun: true, event };
        }

        try {
            const row = await this.repository.record(event);
            return { ok: true, row };
        } catch (error) {
            return { ok: false, dryRun: true, error: error.message, event };
        }
    }

    getStatus() {
        return { name: 'AuditService', ready: true, implemented: false, repository: 'AuditRepository' };
    }
}

module.exports = { AuditService };
