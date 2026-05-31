const { ParticipantRepository } = require('../repositories');

class ParticipantService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.participant || new ParticipantRepository(this.db);
    }

    async listByDeadlyVoteId(deadlyVoteId) {
        return this.repository.listByDeadlyVoteId(deadlyVoteId);
    }

    getStatus() {
        return { name: 'ParticipantService', ready: true, implemented: false, repository: 'ParticipantRepository' };
    }
}

module.exports = { ParticipantService };
