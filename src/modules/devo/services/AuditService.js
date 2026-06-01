const {
    AuditRepository,
    DeadlyVoteRepository,
    InvitationRepository,
    LifeLedgerRepository,
    ParticipantRepository,
    RecordRepository,
} = require('../repositories');

const NEGATIVE_LEDGER_TYPES = new Set(['perda', 'penalidade', 'divida', 'aposta']);

function normalizeLimit(limit, fallback = 20, max = 50) {
    const parsed = parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function parsePayload(row) {
    if (!row?.payload_json) return {};
    try {
        const parsed = JSON.parse(row.payload_json);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function compactText(value, fallback = '-') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 160) : fallback;
}

function countItems(value) {
    return Array.isArray(value) ? value.length : 0;
}

function statusLabel(status) {
    const labels = {
        aceito: 'aceito',
        ativo: 'ativo',
        cancelado: 'cancelado',
        confirmado: 'confirmado',
        desistente: 'desistente',
        encerrado: 'encerrado',
        em_andamento: 'em andamento',
        expirado: 'expirado',
        lotado: 'lotado',
        morto: 'morto',
        pendente: 'pendente',
        pendente_resolucao: 'pendente de resolucao',
        preparado: 'preparado',
        recusado: 'recusado',
        removido: 'removido',
        resolucao_pendente: 'resolucao pendente',
        rascunho: 'rascunho',
        revogado: 'revogado',
        sem_vaga: 'sem vaga',
        sobrevivente: 'sobrevivente',
    };
    return labels[status] || status || '-';
}

function ledgerLabel(type) {
    const labels = {
        ganho: 'ganho',
        perda: 'perda',
        compra: 'compra',
        aposta: 'aposta',
        divida: 'divida',
        penalidade: 'penalidade',
        recompensa: 'recompensa',
        ajuste_admin: 'ajuste admin',
    };
    return labels[type] || type || '-';
}

function signedLedgerAmount(row) {
    const amount = Math.abs(Number(row?.amount_seconds || 0));
    return NEGATIVE_LEDGER_TYPES.has(row?.type) ? -amount : amount;
}

function addItem(items, item) {
    if (!item?.date) return;
    items.push({
        date: item.date,
        type: item.type || 'event',
        title: compactText(item.title, 'Evento'),
        summary: compactText(item.summary, ''),
        amountSeconds: Number.isInteger(item.amountSeconds) ? item.amountSeconds : null,
        recordName: compactText(item.recordName, ''),
        voteTitle: compactText(item.voteTitle, ''),
        voteCode: compactText(item.voteCode, ''),
    });
}

function sortAndLimit(items, limit) {
    const safeLimit = normalizeLimit(limit);
    return items
        .sort((a, b) => {
            const bTime = Date.parse(b.date || '') || 0;
            const aTime = Date.parse(a.date || '') || 0;
            return bTime - aTime;
        })
        .slice(0, safeLimit);
}

function normalizeRecordAudit(row, record) {
    const payload = parsePayload(row);

    if (row.action === 'devo.record.create') {
        return {
            date: row.created_at,
            type: 'record',
            title: 'Record criado',
            summary: `Nome: ${payload.name || record?.name || '-'}`,
        };
    }

    return null;
}

function normalizeDeadlyVoteAudit(row, vote) {
    const payload = parsePayload(row);

    if (row.action === 'devo.dv.create') {
        return {
            date: row.created_at,
            type: 'deadly_vote',
            title: 'Deadly Vote criado',
            summary: `Codigo ${payload.code || vote?.code || '-'}; vagas ${payload.maxSlots || vote?.max_slots || '-'}`,
        };
    }

    if (row.action === 'devo.dv.invite') {
        return {
            date: row.created_at,
            type: 'deadly_vote',
            title: 'Convocacoes registradas',
            summary: [
                `criados ${countItems(payload.created)}`,
                `ignorados ${countItems(payload.skipped)}`,
                `duplicados ${countItems(payload.duplicates)}`,
                `nao encontrados ${countItems(payload.notFound)}`,
            ].join('; '),
        };
    }

    if (row.action === 'devo.dv.start') {
        return {
            date: row.created_at,
            type: 'deadly_vote',
            title: 'Deadly Vote iniciado',
            summary: `participantes ativados ${Number(payload.activatedParticipants || 0)}`,
        };
    }

    if (row.action === 'devo.dv.end') {
        return {
            date: row.created_at,
            type: 'deadly_vote',
            title: 'Deadly Vote encerrado para resolucao',
            summary: `pendentes de resolucao ${Number(payload.pendingResolutionParticipants || 0)}`,
        };
    }

    if (row.action === 'devo.dv.cancel') {
        return {
            date: row.created_at,
            type: 'deadly_vote',
            title: 'Deadly Vote cancelado',
            summary: `convites revogados ${Number(payload.revokedPendingInvitations || 0)}`,
        };
    }

    return null;
}

function addLedgerItem(items, row, { includeRecord = false } = {}) {
    addItem(items, {
        date: row.created_at,
        type: 'life',
        title: `Tempo: ${ledgerLabel(row.type)}`,
        summary: row.reason || '-',
        amountSeconds: signedLedgerAmount(row),
        recordName: includeRecord ? row.record_name : '',
        voteTitle: row.deadly_vote_title,
        voteCode: row.deadly_vote_code,
    });
}

function addRecordInvitationItems(items, invitation) {
    addItem(items, {
        date: invitation.created_at,
        type: 'invitation',
        title: 'Convite recebido',
        summary: `status ${statusLabel(invitation.status)}`,
        voteTitle: invitation.deadly_vote_title,
        voteCode: invitation.deadly_vote_code,
    });

    if (invitation.accepted_at) {
        addItem(items, {
            date: invitation.accepted_at,
            type: 'invitation',
            title: 'Entrada confirmada',
            summary: 'Convite aceito',
            voteTitle: invitation.deadly_vote_title,
            voteCode: invitation.deadly_vote_code,
        });
    }

    if (invitation.refused_at) {
        addItem(items, {
            date: invitation.refused_at,
            type: 'invitation',
            title: 'Convite recusado',
            summary: 'Entrada recusada',
            voteTitle: invitation.deadly_vote_title,
            voteCode: invitation.deadly_vote_code,
        });
    }

    if (['sem_vaga', 'revogado', 'expirado'].includes(invitation.status)) {
        addItem(items, {
            date: invitation.updated_at || invitation.created_at,
            type: 'invitation',
            title: `Convite ${statusLabel(invitation.status)}`,
            summary: `status ${statusLabel(invitation.status)}`,
            voteTitle: invitation.deadly_vote_title,
            voteCode: invitation.deadly_vote_code,
        });
    }
}

function addDeadlyVoteInvitationItems(items, invitation) {
    addItem(items, {
        date: invitation.created_at,
        type: 'invitation',
        title: 'Convite criado',
        summary: `status ${statusLabel(invitation.status)}`,
        recordName: invitation.record_name,
        voteTitle: invitation.deadly_vote_title,
        voteCode: invitation.deadly_vote_code,
    });

    if (invitation.accepted_at) {
        addItem(items, {
            date: invitation.accepted_at,
            type: 'invitation',
            title: 'Entrada confirmada',
            summary: 'Convite aceito',
            recordName: invitation.record_name,
            voteTitle: invitation.deadly_vote_title,
            voteCode: invitation.deadly_vote_code,
        });
    }

    if (invitation.refused_at) {
        addItem(items, {
            date: invitation.refused_at,
            type: 'invitation',
            title: 'Convite recusado',
            summary: 'Entrada recusada',
            recordName: invitation.record_name,
            voteTitle: invitation.deadly_vote_title,
            voteCode: invitation.deadly_vote_code,
        });
    }

    if (['sem_vaga', 'revogado', 'expirado'].includes(invitation.status)) {
        addItem(items, {
            date: invitation.updated_at || invitation.created_at,
            type: 'invitation',
            title: `Convite ${statusLabel(invitation.status)}`,
            summary: `status ${statusLabel(invitation.status)}`,
            recordName: invitation.record_name,
            voteTitle: invitation.deadly_vote_title,
            voteCode: invitation.deadly_vote_code,
        });
    }
}

function addRecordParticipantItems(items, participant) {
    addItem(items, {
        date: participant.joined_at || participant.created_at,
        type: 'participant',
        title: 'Participacao em Deadly Vote',
        summary: `status atual ${statusLabel(participant.status)}`,
        voteTitle: participant.deadly_vote_title,
        voteCode: participant.deadly_vote_code,
    });

    if (participant.resolved_at) {
        const removed = participant.status === 'removido';
        addItem(items, {
            date: participant.resolved_at,
            type: 'result',
            title: removed ? 'Participacao removida' : 'Resultado do Deadly Vote',
            summary: statusLabel(participant.status),
            voteTitle: participant.deadly_vote_title,
            voteCode: participant.deadly_vote_code,
        });
    }
}

function addDeadlyVoteParticipantItems(items, participant) {
    addItem(items, {
        date: participant.joined_at || participant.created_at,
        type: 'participant',
        title: 'Participante registrado',
        summary: `status atual ${statusLabel(participant.status)}`,
        recordName: participant.record_name,
    });

    if (participant.resolved_at) {
        const removed = participant.status === 'removido';
        addItem(items, {
            date: participant.resolved_at,
            type: 'result',
            title: removed ? 'Participante removido' : 'Participante resolvido',
            summary: statusLabel(participant.status),
            recordName: participant.record_name,
        });
    }
}

class AuditService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.audit || new AuditRepository(this.db);
        this.deadlyVoteRepository = context.repositories?.deadlyVote || new DeadlyVoteRepository(this.db);
        this.invitationRepository = context.repositories?.invitation || new InvitationRepository(this.db);
        this.ledgerRepository = context.repositories?.lifeLedger || new LifeLedgerRepository(this.db);
        this.participantRepository = context.repositories?.participant || new ParticipantRepository(this.db);
        this.recordRepository = context.repositories?.record || new RecordRepository(this.db);
    }

    async record(event) {
        if (!this.repository.hasDatabase() || !await this.repository.tableExists()) {
            return { ok: true, dryRun: true, event };
        }

        try {
            const row = await this.repository.record(event);
            return { ok: true, row };
        } catch (error) {
            return { ok: false, dryRun: true, error: error.message, event };
        }
    }

    async getRecordHistory({ recordId, limit = 20 } = {}) {
        const safeLimit = normalizeLimit(limit);
        const record = await this.recordRepository.getById(recordId);
        if (!record) return { record: null, items: [], limit: safeLimit };

        const items = [];
        const auditRows = await this.repository.listByEntity('record', record.id, { limit: safeLimit });
        const ledgerRows = await this.ledgerRepository.listByRecordId(record.id, safeLimit);
        const invitationRows = await this.invitationRepository.listByRecordIdWithVotes(record.id, safeLimit);
        const participantRows = await this.participantRepository.listByRecordIdWithVotes(record.id, safeLimit);

        for (const row of auditRows || []) {
            const item = normalizeRecordAudit(row, record);
            if (item) addItem(items, item);
        }

        for (const row of ledgerRows || []) {
            addLedgerItem(items, row);
        }

        for (const invitation of invitationRows || []) {
            addRecordInvitationItems(items, invitation);
        }

        for (const participant of participantRows || []) {
            addRecordParticipantItems(items, participant);
        }

        return {
            record,
            items: sortAndLimit(items, safeLimit),
            limit: safeLimit,
        };
    }

    async getDeadlyVoteHistory({ deadlyVoteId, limit = 20 } = {}) {
        const safeLimit = normalizeLimit(limit);
        const vote = await this.deadlyVoteRepository.getById(deadlyVoteId);
        if (!vote) return { vote: null, items: [], limit: safeLimit };

        const items = [];
        const auditRows = await this.repository.listByEntity('deadly_vote', vote.id, { limit: safeLimit });
        const invitationRows = await this.invitationRepository.listByDeadlyVoteIdWithRecords(vote.id, safeLimit);
        const participantRows = await this.participantRepository.listByDeadlyVoteIdWithRecords(vote.id, safeLimit);
        const ledgerRows = await this.ledgerRepository.listByDeadlyVoteId(vote.id, safeLimit);

        for (const row of auditRows || []) {
            const item = normalizeDeadlyVoteAudit(row, vote);
            if (item) addItem(items, item);
        }

        for (const invitation of invitationRows || []) {
            addDeadlyVoteInvitationItems(items, invitation);
        }

        for (const participant of participantRows || []) {
            addDeadlyVoteParticipantItems(items, participant);
        }

        for (const row of ledgerRows || []) {
            addLedgerItem(items, row, { includeRecord: true });
        }

        return {
            vote,
            items: sortAndLimit(items, safeLimit),
            limit: safeLimit,
        };
    }

    getStatus() {
        return { name: 'AuditService', ready: true, implemented: false, repository: 'AuditRepository' };
    }
}

module.exports = { AuditService };
