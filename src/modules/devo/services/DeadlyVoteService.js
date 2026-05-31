const {
    AuditRepository,
    DeadlyVoteRepository,
    InvitationRepository,
    ParticipantRepository,
} = require('../repositories');
const crypto = require('crypto');

const VALID_DEADLY_VOTE_STATUSES = new Set([
    'rascunho',
    'preparado',
    'convocando',
    'lotado',
    'iniciado',
    'em_andamento',
    'resolucao_pendente',
    'encerrado',
    'cancelado',
    'arquivado',
]);

function normalizeCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '-')
        .replace(/[^A-Z0-9_-]/g, '');
}

function normalizeLimit(limit) {
    const parsed = parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return 20;
    return Math.min(parsed, 50);
}

class DeadlyVoteService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.deadlyVote || new DeadlyVoteRepository(this.db);
        this.auditRepository = context.repositories?.audit || new AuditRepository(this.db);
        this.invitationRepository = context.repositories?.invitation || new InvitationRepository(this.db);
        this.participantRepository = context.repositories?.participant || new ParticipantRepository(this.db);
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

    async createVote({ title, maxSlots, code = null, createdByManagerId = null } = {}) {
        const safeTitle = String(title || '').trim();
        if (!safeTitle) throw new Error('title is required');

        const safeMaxSlots = Number(maxSlots);
        if (!Number.isInteger(safeMaxSlots) || safeMaxSlots < 1) {
            throw new Error('maxSlots must be an integer >= 1');
        }

        if (!this.db) throw new Error('Database connection missing');
        if (typeof this.repository.tableExists === 'function' && !await this.repository.tableExists()) {
            throw new Error('Deadly Vote table unavailable');
        }

        const safeCode = code ? normalizeCode(code) : await this.generateUniqueCode();
        if (!safeCode) throw new Error('code is invalid');

        const existing = await this.repository.getByCode(safeCode);
        if (existing) throw new Error('deadly vote code already exists');

        return this.repository.create({
            title: safeTitle,
            code: safeCode,
            status: 'rascunho',
            max_slots: safeMaxSlots,
            reserved_slots: 0,
            created_by_manager_id: createdByManagerId || null,
        });
    }

    async generateUniqueCode() {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const code = `DV${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const existing = await this.repository.getByCode(code);
            if (!existing) return code;
        }

        throw new Error('could not generate unique deadly vote code');
    }

    async getByIdOrCode(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;

        const byId = await this.repository.getById(raw);
        if (byId) return byId;

        const safeCode = normalizeCode(raw);
        if (!safeCode) return null;

        return this.repository.getByCode(safeCode);
    }

    async getByCode(code) {
        return this.repository.getByCode(normalizeCode(code));
    }

    async listVotes({ status = null, limit = 20 } = {}) {
        const safeLimit = normalizeLimit(limit);
        const safeStatus = status ? String(status).trim().toLowerCase() : null;

        if (safeStatus && !VALID_DEADLY_VOTE_STATUSES.has(safeStatus)) {
            throw new Error('invalid deadly vote status');
        }

        return this.repository.listVotes({ status: safeStatus, limit: safeLimit });
    }

    async updateStatus(id, status) {
        const safeStatus = String(status || '').trim().toLowerCase();
        if (!VALID_DEADLY_VOTE_STATUSES.has(safeStatus)) {
            throw new Error('invalid deadly vote status');
        }

        return this.repository.update(id, { status: safeStatus });
    }

    async markConvocandoIfNeeded(vote) {
        if (!vote) throw new Error('deadly vote not found');
        if (vote.status === 'rascunho' || vote.status === 'preparado') {
            return this.updateStatus(vote.id, 'convocando');
        }

        return vote;
    }

    async tryReserveSlot(deadlyVoteId) {
        if (!this.db) throw new Error('Database connection missing');

        const result = await this.db.run(
            `UPDATE deadly_votes
             SET reserved_slots = reserved_slots + 1,
                 status = CASE
                     WHEN reserved_slots + 1 >= max_slots THEN 'lotado'
                     ELSE status
                 END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND status = 'convocando'
               AND reserved_slots < max_slots`,
            [deadlyVoteId]
        );

        if (Number(result?.changes || 0) !== 1) {
            return { ok: false, vote: await this.repository.getById(deadlyVoteId) };
        }

        return { ok: true, vote: await this.repository.getById(deadlyVoteId) };
    }

    async releaseReservedSlot(deadlyVoteId) {
        if (!this.db) throw new Error('Database connection missing');

        const result = await this.db.run(
            `UPDATE deadly_votes
             SET reserved_slots = CASE
                     WHEN reserved_slots > 0 THEN reserved_slots - 1
                     ELSE 0
                 END,
                 status = CASE
                     WHEN status = 'lotado' THEN 'convocando'
                     ELSE status
                 END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND status IN ('rascunho', 'preparado', 'convocando', 'lotado')`,
            [deadlyVoteId]
        );

        if (Number(result?.changes || 0) !== 1) {
            return { ok: false, vote: await this.repository.getById(deadlyVoteId) };
        }

        return { ok: true, vote: await this.repository.getById(deadlyVoteId) };
    }

    async startVote({ voteIdOrCode, actorUserId = null, actorManagerId = null } = {}) {
        const safeVoteTarget = String(voteIdOrCode || '').trim();
        if (!safeVoteTarget) throw new Error('voteIdOrCode is required');

        return this._withTransaction(async () => {
            const vote = await this.getByIdOrCode(safeVoteTarget);
            if (!vote) throw new Error('Deadly Vote nao encontrado.');
            if (vote.status !== 'convocando' && vote.status !== 'lotado') {
                throw new Error('Deadly Vote precisa estar convocando ou lotado para iniciar.');
            }

            const confirmedCount = await this.participantRepository.countByVoteAndStatus(vote.id, 'confirmado');
            if (confirmedCount < 1) {
                throw new Error('Deadly Vote precisa ter pelo menos 1 participante confirmado.');
            }

            const started = await this.repository.markStarted(vote.id);
            if (started.changes !== 1 || !started.vote || started.vote.status !== 'em_andamento') {
                throw new Error('Nao foi possivel iniciar Deadly Vote.');
            }

            const participants = await this.participantRepository.markConfirmedAsActive(vote.id);

            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                actorManagerId: actorManagerId || null,
                type: 'devo.dv.start',
                entityType: 'deadly_vote',
                entityId: vote.id,
                payload: {
                    previousStatus: vote.status,
                    status: started.vote.status,
                    confirmedParticipants: confirmedCount,
                    activatedParticipants: participants.changes,
                    startedAt: started.vote.started_at,
                },
            });

            return {
                vote: started.vote,
                previousVote: vote,
                confirmedParticipants: confirmedCount,
                activatedParticipants: participants.changes,
            };
        }, { immediate: true });
    }

    async endVote({ voteIdOrCode, actorUserId = null, actorManagerId = null } = {}) {
        const safeVoteTarget = String(voteIdOrCode || '').trim();
        if (!safeVoteTarget) throw new Error('voteIdOrCode is required');

        return this._withTransaction(async () => {
            const vote = await this.getByIdOrCode(safeVoteTarget);
            if (!vote) throw new Error('Deadly Vote nao encontrado.');
            if (vote.status !== 'em_andamento' && vote.status !== 'iniciado') {
                throw new Error('Deadly Vote precisa estar em andamento para encerrar.');
            }

            const ended = await this.repository.markEnded(vote.id);
            if (ended.changes !== 1 || !ended.vote || ended.vote.status !== 'resolucao_pendente') {
                throw new Error('Nao foi possivel encerrar Deadly Vote.');
            }

            const participants = await this.participantRepository.markActiveAsPendingResolution(vote.id);

            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                actorManagerId: actorManagerId || null,
                type: 'devo.dv.end',
                entityType: 'deadly_vote',
                entityId: vote.id,
                payload: {
                    previousStatus: vote.status,
                    status: ended.vote.status,
                    pendingResolutionParticipants: participants.changes,
                    endedAt: ended.vote.ended_at,
                },
            });

            return {
                vote: ended.vote,
                previousVote: vote,
                pendingResolutionParticipants: participants.changes,
            };
        }, { immediate: true });
    }

    async cancelVote({ voteIdOrCode, actorUserId = null, actorManagerId = null } = {}) {
        const safeVoteTarget = String(voteIdOrCode || '').trim();
        if (!safeVoteTarget) throw new Error('voteIdOrCode is required');

        return this._withTransaction(async () => {
            const vote = await this.getByIdOrCode(safeVoteTarget);
            if (!vote) throw new Error('Deadly Vote nao encontrado.');
            if (!['rascunho', 'preparado', 'convocando', 'lotado'].includes(vote.status)) {
                throw new Error('Deadly Vote nao pode ser cancelado depois de iniciado.');
            }

            const canceled = await this.repository.markCanceled(vote.id);
            if (canceled.changes !== 1 || !canceled.vote || canceled.vote.status !== 'cancelado') {
                throw new Error('Nao foi possivel cancelar Deadly Vote.');
            }

            const revoked = await this.invitationRepository.revokePendingByDeadlyVoteId(vote.id);

            await this.auditRepository.record({
                actorUserId: actorUserId || 'system',
                actorManagerId: actorManagerId || null,
                type: 'devo.dv.cancel',
                entityType: 'deadly_vote',
                entityId: vote.id,
                payload: {
                    previousStatus: vote.status,
                    status: canceled.vote.status,
                    revokedPendingInvitations: revoked.changes,
                    endedAt: canceled.vote.ended_at,
                },
            });

            return {
                vote: canceled.vote,
                previousVote: vote,
                revokedPendingInvitations: revoked.changes,
            };
        }, { immediate: true });
    }

    getStatus() {
        return { name: 'DeadlyVoteService', ready: Boolean(this.db), implemented: true, repository: 'DeadlyVoteRepository' };
    }
}

module.exports = { DeadlyVoteService, VALID_DEADLY_VOTE_STATUSES };
