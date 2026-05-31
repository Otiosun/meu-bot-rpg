const { AuditRepository, DeadlyVoteRepository, InvitationRepository, RecordRepository } = require('../repositories');
const { DeadlyVoteService } = require('./DeadlyVoteService');
const { RecordService } = require('./RecordService');

const INVITABLE_VOTE_STATUSES = new Set(['rascunho', 'preparado', 'convocando']);

class InvitationService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.invitation || new InvitationRepository(this.db);
        this.auditRepository = context.repositories?.audit || new AuditRepository(this.db);
        this.deadlyVoteRepository = context.repositories?.deadlyVote || new DeadlyVoteRepository(this.db);
        this.recordRepository = context.repositories?.record || new RecordRepository(this.db);
        this.deadlyVoteService = new DeadlyVoteService({
            ...context,
            repositories: {
                ...context.repositories,
                deadlyVote: this.deadlyVoteRepository,
            },
        });
        this.recordService = new RecordService({
            ...context,
            repositories: {
                ...context.repositories,
                record: this.recordRepository,
            },
        });
    }

    async _withTransaction(fn, { immediate = false } = {}) {
        if (!this.db) throw new Error('Database connection missing');
        const beginStmt = immediate ? 'BEGIN IMMEDIATE' : 'BEGIN';
        try {
            await this.db.exec(beginStmt);
            const result = await fn();
            await this.db.exec('COMMIT');
            return result;
        } catch (err) {
            try {
                await this.db.exec('ROLLBACK');
            } catch (e) {
                // swallow rollback error
            }
            throw err;
        }
    }

    async listByDeadlyVoteId(deadlyVoteId) {
        return this.repository.listByDeadlyVoteId(deadlyVoteId);
    }

    async createPendingInvitations({ voteIdOrCode, targets = [], invitedByManagerId = null, actorUserId = null } = {}) {
        const safeTargets = Array.isArray(targets)
            ? targets.map((target) => String(target || '').trim()).filter(Boolean)
            : [];

        if (!voteIdOrCode) throw new Error('voteIdOrCode is required');
        if (!safeTargets.length) throw new Error('targets are required');

        return this._withTransaction(async () => {
            const vote = await this.deadlyVoteService.getByIdOrCode(voteIdOrCode);
            if (!vote) throw new Error('Deadly Vote not found');

            const result = {
                vote,
                previousStatus: vote.status,
                nextStatus: vote.status,
                statusChanged: false,
                created: [],
                skipped: [],
                duplicates: [],
                notFound: [],
                invalidStatus: null,
            };

            if (!INVITABLE_VOTE_STATUSES.has(vote.status)) {
                result.invalidStatus = vote.status;
                await this.auditRepository.record({
                    actorUserId: actorUserId || 'system',
                    actorManagerId: invitedByManagerId || null,
                    type: 'devo.dv.invite_failed',
                    entityType: 'deadly_vote',
                    entityId: vote.id,
                    payload: {
                        reason: 'invalid_status',
                        status: vote.status,
                        targets: safeTargets,
                    },
                });
                return result;
            }

            const seenRecordIds = new Set();
            for (const target of safeTargets) {
                const record = await this.recordService.resolveRecordTarget(target);
                if (!record) {
                    result.notFound.push({ target });
                    continue;
                }

                if (seenRecordIds.has(record.id)) {
                    result.duplicates.push({ target, recordId: record.id, reason: 'duplicate_target' });
                    continue;
                }
                seenRecordIds.add(record.id);

                if (record.status !== 'ativo') {
                    result.skipped.push({ target, recordId: record.id, status: record.status, reason: 'record_not_active' });
                    continue;
                }

                const existing = await this.repository.getByVoteAndRecord(vote.id, record.id);
                if (existing) {
                    result.duplicates.push({ target, recordId: record.id, invitationId: existing.id, reason: 'already_invited' });
                    continue;
                }

                const invitation = await this.repository.create({
                    deadly_vote_id: vote.id,
                    record_id: record.id,
                    status: 'pendente',
                    invited_by_manager_id: invitedByManagerId || null,
                    expires_at: null,
                });
                result.created.push(invitation);
            }

            if (result.created.length && (vote.status === 'rascunho' || vote.status === 'preparado')) {
                result.vote = await this.deadlyVoteService.updateStatus(vote.id, 'convocando');
                result.nextStatus = result.vote.status;
                result.statusChanged = true;
            }

            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                actorManagerId: invitedByManagerId || null,
                type: 'devo.dv.invite',
                entityType: 'deadly_vote',
                entityId: vote.id,
                payload: {
                    previousStatus: result.previousStatus,
                    nextStatus: result.nextStatus,
                    statusChanged: result.statusChanged,
                    created: result.created.map((invitation) => invitation.id),
                    skipped: result.skipped,
                    duplicates: result.duplicates,
                    notFound: result.notFound,
                },
            });

            return result;
        }, { immediate: true });
    }

    async listPendingForRecord(recordId) {
        return this.repository.listPendingByRecordId(recordId);
    }

    async listForRecord(recordId, { status = null } = {}) {
        return this.repository.listByRecordId(recordId, { status });
    }

    getStatus() {
        return { name: 'InvitationService', ready: Boolean(this.db), implemented: true, repository: 'InvitationRepository' };
    }
}

module.exports = { InvitationService };
