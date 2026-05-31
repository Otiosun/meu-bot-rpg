const { ParticipantRepository } = require('../repositories');

class ParticipantService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.participant || new ParticipantRepository(this.db);
    }

    async listByDeadlyVoteId(deadlyVoteId) {
        return this.repository.listByDeadlyVoteId(deadlyVoteId);
    }

    async getByVoteAndRecord(deadlyVoteId, recordId) {
        return this.repository.getByVoteAndRecord(deadlyVoteId, recordId);
    }

    async createConfirmed({ deadlyVoteId, recordId, invitationId = null } = {}) {
        if (!deadlyVoteId) throw new Error('deadlyVoteId is required');
        if (!recordId) throw new Error('recordId is required');

        return this.repository.createConfirmed({ deadlyVoteId, recordId, invitationId });
    }

    getStatus() {
        return { name: 'ParticipantService', ready: Boolean(this.db), implemented: true, repository: 'ParticipantRepository' };
    }
}

module.exports = { ParticipantService };
