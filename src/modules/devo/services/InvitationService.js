const { InvitationRepository } = require('../repositories');

class InvitationService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.invitation || new InvitationRepository(this.db);
    }

    async listByDeadlyVoteId(deadlyVoteId) {
        return this.repository.listByDeadlyVoteId(deadlyVoteId);
    }

    getStatus() {
        return { name: 'InvitationService', ready: true, implemented: false, repository: 'InvitationRepository' };
    }
}

module.exports = { InvitationService };
