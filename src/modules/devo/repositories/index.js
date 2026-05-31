const { AuditRepository } = require('./AuditRepository');
const { DeadlyVoteRepository } = require('./DeadlyVoteRepository');
const { InvitationRepository } = require('./InvitationRepository');
const { LifeLedgerRepository } = require('./LifeLedgerRepository');
const { ManagerRepository } = require('./ManagerRepository');
const { ParticipantRepository } = require('./ParticipantRepository');
const { RecordRepository } = require('./RecordRepository');

function createDevoRepositories(db) {
    return {
        audit: new AuditRepository(db),
        deadlyVote: new DeadlyVoteRepository(db),
        invitation: new InvitationRepository(db),
        lifeLedger: new LifeLedgerRepository(db),
        manager: new ManagerRepository(db),
        participant: new ParticipantRepository(db),
        record: new RecordRepository(db),
    };
}

module.exports = {
    AuditRepository,
    DeadlyVoteRepository,
    InvitationRepository,
    LifeLedgerRepository,
    ManagerRepository,
    ParticipantRepository,
    RecordRepository,
    createDevoRepositories,
};
