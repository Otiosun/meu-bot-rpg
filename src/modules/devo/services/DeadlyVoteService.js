const { DeadlyVoteRepository } = require('../repositories');

class DeadlyVoteService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.deadlyVote || new DeadlyVoteRepository(this.db);
    }

    async getByCode(code) {
        return this.repository.getByCode(code);
    }

    getStatus() {
        return { name: 'DeadlyVoteService', ready: true, implemented: false, repository: 'DeadlyVoteRepository' };
    }
}

module.exports = { DeadlyVoteService };
