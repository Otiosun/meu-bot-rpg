class TransmissionService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repositories = context.repositories || {};
    }

    getStatus() {
        return { name: 'TransmissionService', ready: true, implemented: false, repository: null };
    }
}

module.exports = { TransmissionService };
