const { AuditService } = require('./AuditService');
const { DeadlyVoteService } = require('./DeadlyVoteService');
const { InvitationService } = require('./InvitationService');
const { LifeService } = require('./LifeService');
const { ManagerService } = require('./ManagerService');
const { ParticipantService } = require('./ParticipantService');
const { RecordService } = require('./RecordService');
const { TransmissionService } = require('./TransmissionService');
const { createDevoRepositories } = require('../repositories');

function createDevoServices(context = {}) {
    const repositories = context.repositories || createDevoRepositories(context.db);
    const serviceContext = { ...context, repositories };

    return {
        audit: new AuditService(serviceContext),
        deadlyVote: new DeadlyVoteService(serviceContext),
        invitation: new InvitationService(serviceContext),
        life: new LifeService(serviceContext),
        manager: new ManagerService(serviceContext),
        participant: new ParticipantService(serviceContext),
        record: new RecordService(serviceContext),
        transmission: new TransmissionService(serviceContext),
    };
}

module.exports = {
    AuditService,
    DeadlyVoteService,
    InvitationService,
    LifeService,
    ManagerService,
    ParticipantService,
    RecordService,
    TransmissionService,
    createDevoServices,
};
