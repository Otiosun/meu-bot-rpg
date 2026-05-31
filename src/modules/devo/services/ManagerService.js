const { ManagerRepository } = require('../repositories');

class ManagerService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.manager || new ManagerRepository(this.db);
    }

    async getByUserId(userId) {
        return this.repository.getByUserId(userId);
    }

    getStatus() {
        return { name: 'ManagerService', ready: true, implemented: false, repository: 'ManagerRepository' };
    }
}

module.exports = { ManagerService };
