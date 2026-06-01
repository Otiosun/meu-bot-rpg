const { ManagerRepository } = require('../repositories');
const { getWhatsAppIdentityVariants } = require('../rules/whatsappIdentity');

class ManagerService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.manager || new ManagerRepository(this.db);
    }

    async getByUserId(userId) {
        const variants = getWhatsAppIdentityVariants(userId);
        if (typeof this.repository.getByUserIds === 'function') {
            return this.repository.getByUserIds(variants);
        }

        return this.repository.getByUserId(variants[0] || userId);
    }

    getStatus() {
        return { name: 'ManagerService', ready: true, implemented: false, repository: 'ManagerRepository' };
    }
}

module.exports = { ManagerService };
