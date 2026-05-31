const {
    AuditRepository,
    DeadlyVoteRepository,
    ParticipantRepository,
    RecordRepository,
} = require('../repositories');
const { DeadlyVoteService } = require('./DeadlyVoteService');
const { RecordService } = require('./RecordService');

const REMOVABLE_VOTE_STATUSES = new Set(['rascunho', 'preparado', 'convocando', 'lotado']);
const RESOLUTION_STATUSES = new Set(['sobrevivente', 'morto', 'desistente']);

class ParticipantService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.participant || new ParticipantRepository(this.db);
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

    async listParticipants({ voteIdOrCode } = {}) {
        const safeVoteTarget = String(voteIdOrCode || '').trim();
        if (!safeVoteTarget) throw new Error('voteIdOrCode is required');

        const vote = await this.deadlyVoteService.getByIdOrCode(safeVoteTarget);
        if (!vote) throw new Error('Deadly Vote nao encontrado.');

        const participants = await this.repository.listByDeadlyVoteIdWithRecords(vote.id);
        return { vote, participants };
    }

    async getByVoteAndRecord(deadlyVoteId, recordId) {
        return this.repository.getByVoteAndRecord(deadlyVoteId, recordId);
    }

    async createConfirmed({ deadlyVoteId, recordId, invitationId = null } = {}) {
        if (!deadlyVoteId) throw new Error('deadlyVoteId is required');
        if (!recordId) throw new Error('recordId is required');

        return this.repository.createConfirmed({ deadlyVoteId, recordId, invitationId });
    }

    async removeParticipant({ voteIdOrCode, target, actorUserId = null, actorManagerId = null } = {}) {
        const safeVoteTarget = String(voteIdOrCode || '').trim();
        const safeTarget = String(target || '').trim();
        if (!safeVoteTarget) throw new Error('voteIdOrCode is required');
        if (!safeTarget) throw new Error('target is required');

        return this._withTransaction(async () => {
            const vote = await this.deadlyVoteService.getByIdOrCode(safeVoteTarget);
            if (!vote) throw new Error('Deadly Vote nao encontrado.');

            const record = await this.recordService.resolveRecordTarget(safeTarget);
            if (!record) throw new Error('Record nao encontrado.');

            const participant = await this.repository.getByVoteAndRecord(vote.id, record.id);
            if (!participant) throw new Error('Participante nao encontrado para este Record neste Deadly Vote.');

            if (!REMOVABLE_VOTE_STATUSES.has(vote.status)) {
                throw new Error('Remocao negada para Deadly Vote iniciado ou encerrado.');
            }

            if (participant.status !== 'confirmado') {
                throw new Error('Apenas participantes confirmados podem ser removidos nesta etapa.');
            }

            const removed = await this.repository.markRemoved(participant.id);
            if (removed.changes !== 1 || !removed.participant || removed.participant.status !== 'removido') {
                throw new Error('Nao foi possivel remover participante.');
            }

            const release = await this.deadlyVoteService.releaseReservedSlot(vote.id);
            if (!release.ok) {
                throw new Error('Nao foi possivel liberar vaga do Deadly Vote.');
            }

            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                actorManagerId: actorManagerId || null,
                type: 'devo.dv.participant.remove',
                entityType: 'deadly_vote_participant',
                entityId: removed.participant.id,
                payload: {
                    deadlyVoteId: vote.id,
                    recordId: record.id,
                    previousParticipantStatus: participant.status,
                    participantStatus: removed.participant.status,
                    previousVoteStatus: vote.status,
                    voteStatus: release.vote?.status || vote.status,
                    previousReservedSlots: Number(vote.reserved_slots || 0),
                    reservedSlots: Number(release.vote?.reserved_slots || 0),
                },
            });

            return {
                vote: release.vote,
                previousVote: vote,
                record,
                participant: removed.participant,
                previousParticipant: participant,
            };
        }, { immediate: true });
    }

    async resolveParticipant({ voteIdOrCode, resolution, target, actorUserId = null, actorManagerId = null } = {}) {
        const safeVoteTarget = String(voteIdOrCode || '').trim();
        const safeResolution = String(resolution || '').trim().toLowerCase();
        const safeTarget = String(target || '').trim();
        if (!safeVoteTarget) throw new Error('voteIdOrCode is required');
        if (!safeResolution) throw new Error('resolution is required');
        if (!safeTarget) throw new Error('target is required');
        if (!RESOLUTION_STATUSES.has(safeResolution)) {
            throw new Error('Resolucao invalida. Use sobrevivente, morto ou desistente.');
        }

        return this._withTransaction(async () => {
            const vote = await this.deadlyVoteService.getByIdOrCode(safeVoteTarget);
            if (!vote) throw new Error('Deadly Vote nao encontrado.');

            const record = await this.recordService.resolveRecordTarget(safeTarget);
            if (!record) throw new Error('Record nao encontrado.');

            const participant = await this.repository.getByVoteAndRecord(vote.id, record.id);
            if (!participant) throw new Error('Participante nao encontrado para este Record neste Deadly Vote.');

            if (vote.status !== 'resolucao_pendente') {
                throw new Error('Deadly Vote precisa estar em resolucao_pendente para resolver participantes.');
            }

            if (participant.status !== 'pendente_resolucao') {
                throw new Error('Apenas participantes pendente_resolucao podem ser resolvidos nesta etapa.');
            }

            const resolved = await this.repository.markResolved(participant.id, safeResolution);
            if (resolved.changes !== 1 || !resolved.participant || resolved.participant.status !== safeResolution) {
                throw new Error('Nao foi possivel resolver participante.');
            }

            let recordAfter = record;
            if (safeResolution === 'morto') {
                if (record.status === 'morto') {
                    throw new Error('Record ja esta morto.');
                }

                const markedDead = await this.recordRepository.markDead(record.id);
                if (markedDead.changes !== 1 || !markedDead.record || markedDead.record.status !== 'morto') {
                    throw new Error('Record precisa estar ativo para ser marcado como morto.');
                }
                recordAfter = markedDead.record;
            }

            const pendingResolutionCount = await this.repository.countPendingResolution(vote.id);
            let finalVote = await this.deadlyVoteRepository.getById(vote.id);
            let autoClosed = false;
            if (pendingResolutionCount === 0) {
                const closed = await this.deadlyVoteRepository.markClosedIfPendingResolution(vote.id);
                if (closed.changes !== 1 || !closed.vote || closed.vote.status !== 'encerrado') {
                    throw new Error('Nao foi possivel encerrar Deadly Vote apos resolver participantes.');
                }
                finalVote = closed.vote;
                autoClosed = true;
            }

            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                actorManagerId: actorManagerId || null,
                type: 'devo.dv.participant.resolve',
                entityType: 'deadly_vote_participant',
                entityId: resolved.participant.id,
                payload: {
                    deadlyVoteId: vote.id,
                    recordId: record.id,
                    resolution: safeResolution,
                    previousParticipantStatus: participant.status,
                    participantStatus: resolved.participant.status,
                    previousRecordStatus: record.status,
                    recordStatus: recordAfter.status,
                    previousVoteStatus: vote.status,
                    voteStatus: finalVote?.status || vote.status,
                    pendingResolutionCount,
                    autoClosed,
                },
            });

            return {
                vote: finalVote,
                previousVote: vote,
                record: recordAfter,
                previousRecord: record,
                participant: resolved.participant,
                previousParticipant: participant,
                resolution: safeResolution,
                pendingResolutionCount,
                autoClosed,
            };
        }, { immediate: true });
    }

    getStatus() {
        return { name: 'ParticipantService', ready: Boolean(this.db), implemented: true, repository: 'ParticipantRepository' };
    }
}

module.exports = { ParticipantService };
