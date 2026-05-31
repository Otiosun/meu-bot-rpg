const { AuditRepository, DeadlyVoteRepository, InvitationRepository, ParticipantRepository, RecordRepository } = require('../repositories');
const { DeadlyVoteService } = require('./DeadlyVoteService');
const { RecordService } = require('./RecordService');

const INVITABLE_VOTE_STATUSES = new Set(['rascunho', 'preparado', 'convocando']);

function hasNoSlots(vote) {
    if (!vote) return true;
    return Number(vote.reserved_slots || 0) >= Number(vote.max_slots || 0);
}

class InvitationService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.invitation || new InvitationRepository(this.db);
        this.auditRepository = context.repositories?.audit || new AuditRepository(this.db);
        this.deadlyVoteRepository = context.repositories?.deadlyVote || new DeadlyVoteRepository(this.db);
        this.participantRepository = context.repositories?.participant || new ParticipantRepository(this.db);
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

    async _resolvePendingInvitationForActor({ actorUserId, input } = {}) {
        const safeInput = String(input || '').trim();
        if (!actorUserId) throw new Error('actorUserId is required');
        if (!safeInput) throw new Error('input is required');

        const record = await this.recordService.resolveRecordTarget(actorUserId);
        if (!record) throw new Error('Nenhum Record encontrado para voce.');
        if (record.status !== 'ativo') throw new Error('Record nao esta ativo.');

        let invitation = null;
        let vote = null;

        if (safeInput.startsWith('inv_')) {
            invitation = await this.repository.getByIdWithVote(safeInput);
            if (!invitation) throw new Error('Convite nao encontrado.');
            if (invitation.record_id !== record.id) {
                throw new Error('Convite nao pertence ao seu Record.');
            }
            if (invitation.status !== 'pendente') {
                throw new Error('Convite pendente nao encontrado.');
            }

            vote = await this.deadlyVoteRepository.getById(invitation.deadly_vote_id);
        } else {
            vote = await this.deadlyVoteService.getByIdOrCode(safeInput);
            if (!vote) throw new Error('Deadly Vote nao encontrado.');

            invitation = await this.repository.getPendingByVoteAndRecord(vote.id, record.id);
            if (!invitation) throw new Error('Convite pendente nao encontrado para este Record.');
        }

        if (!vote) throw new Error('Deadly Vote nao encontrado.');

        return { record, invitation, vote, input: safeInput };
    }

    async _markNoSlots({ actorUserId, record, invitation, vote, reason = 'no_slots' } = {}) {
        const updatedInvitation = await this.repository.markSemVaga(invitation.id);
        if (!updatedInvitation || updatedInvitation.status !== 'sem_vaga') {
            throw new Error('Nao foi possivel marcar convite sem vaga.');
        }

        const currentVote = await this.deadlyVoteRepository.getById(vote.id);
        await this.auditRepository.record({
            actorUserId: actorUserId || 'system',
            type: 'devo.invitation.no_slots',
            entityType: 'deadly_vote_invitation',
            entityId: updatedInvitation.id,
            payload: {
                reason,
                recordId: record.id,
                deadlyVoteId: vote.id,
                voteStatus: currentVote?.status || vote.status,
                reservedSlots: Number(currentVote?.reserved_slots ?? vote.reserved_slots ?? 0),
                maxSlots: Number(currentVote?.max_slots ?? vote.max_slots ?? 0),
            },
        });

        return {
            outcome: 'sem_vaga',
            record,
            invitation: updatedInvitation,
            vote: currentVote || vote,
            participant: null,
        };
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

    async acceptInvitation({ actorUserId, input } = {}) {
        return this._withTransaction(async () => {
            const resolved = await this._resolvePendingInvitationForActor({ actorUserId, input });
            const vote = await this.deadlyVoteRepository.getById(resolved.vote.id);
            if (!vote) throw new Error('Deadly Vote nao encontrado.');

            if (hasNoSlots(vote)) {
                return this._markNoSlots({
                    actorUserId,
                    record: resolved.record,
                    invitation: resolved.invitation,
                    vote,
                });
            }

            if (vote.status !== 'convocando') {
                throw new Error('Deadly Vote nao esta convocando.');
            }

            const reservation = await this.deadlyVoteService.tryReserveSlot(vote.id);
            if (!reservation.ok) {
                const currentVote = reservation.vote || await this.deadlyVoteRepository.getById(vote.id);
                if (hasNoSlots(currentVote)) {
                    return this._markNoSlots({
                        actorUserId,
                        record: resolved.record,
                        invitation: resolved.invitation,
                        vote: currentVote,
                        reason: 'reserve_guard_no_slots',
                    });
                }

                throw new Error('Nao foi possivel reservar vaga para este Deadly Vote.');
            }

            const updatedInvitation = await this.repository.markAccepted(resolved.invitation.id);
            if (!updatedInvitation || updatedInvitation.status !== 'aceito') {
                throw new Error('Nao foi possivel aceitar convite.');
            }

            const participant = await this.participantRepository.createConfirmed({
                deadlyVoteId: vote.id,
                recordId: resolved.record.id,
                invitationId: updatedInvitation.id,
            });

            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                type: 'devo.invitation.accept',
                entityType: 'deadly_vote_invitation',
                entityId: updatedInvitation.id,
                payload: {
                    recordId: resolved.record.id,
                    deadlyVoteId: vote.id,
                    participantId: participant?.id || null,
                    previousReservedSlots: Number(vote.reserved_slots || 0),
                    reservedSlots: Number(reservation.vote?.reserved_slots || 0),
                    maxSlots: Number(reservation.vote?.max_slots || vote.max_slots || 0),
                    previousVoteStatus: vote.status,
                    voteStatus: reservation.vote?.status || vote.status,
                },
            });

            return {
                outcome: 'aceito',
                record: resolved.record,
                invitation: updatedInvitation,
                vote: reservation.vote,
                participant,
            };
        }, { immediate: true });
    }

    async refuseInvitation({ actorUserId, input } = {}) {
        return this._withTransaction(async () => {
            const resolved = await this._resolvePendingInvitationForActor({ actorUserId, input });
            const updatedInvitation = await this.repository.markRefused(resolved.invitation.id);
            if (!updatedInvitation || updatedInvitation.status !== 'recusado') {
                throw new Error('Nao foi possivel recusar convite.');
            }

            const vote = await this.deadlyVoteRepository.getById(resolved.vote.id);
            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                type: 'devo.invitation.refuse',
                entityType: 'deadly_vote_invitation',
                entityId: updatedInvitation.id,
                payload: {
                    recordId: resolved.record.id,
                    deadlyVoteId: resolved.vote.id,
                    voteStatus: vote?.status || resolved.vote.status,
                    reservedSlots: Number(vote?.reserved_slots ?? resolved.vote.reserved_slots ?? 0),
                    maxSlots: Number(vote?.max_slots ?? resolved.vote.max_slots ?? 0),
                },
            });

            return {
                outcome: 'recusado',
                record: resolved.record,
                invitation: updatedInvitation,
                vote: vote || resolved.vote,
                participant: null,
            };
        }, { immediate: true });
    }

    getStatus() {
        return { name: 'InvitationService', ready: Boolean(this.db), implemented: true, repository: 'InvitationRepository' };
    }
}

module.exports = { InvitationService };
