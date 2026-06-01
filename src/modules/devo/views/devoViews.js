const {
    ACTIVE_DEVO_COMMANDS,
    DEVO_BASE_VERSION,
    DEVO_MODULE_NAME,
    DEVO_PREFIX,
} = require('../constants/devoConstants');
const { formatLifeDuration } = require('../rules/lifeDuration');

function renderHelp() {
    return [
        `*${DEVO_MODULE_NAME}*`,
        '',
        'Comandos ativos nesta base seca:',
        `- *${DEVO_PREFIX} ping*`,
        `- *${DEVO_PREFIX} status*`,
        `- *${DEVO_PREFIX} help*`,
        `- *${DEVO_PREFIX} record criar/ver/listar*`,
        `- *${DEVO_PREFIX} tempo*`,
        `- *${DEVO_PREFIX} life dar/tirar*`,
        `- *${DEVO_PREFIX} dv criar/ver/listar/participantes/remover/resolver/iniciar/encerrar/cancelar/recompensar/penalizar*`,
        `- *${DEVO_PREFIX} convocacoes*`,
        `- *${DEVO_PREFIX} entrar/recusar*`,
        '',
        'Sistemas de jogo ainda nao foram implementados nesta etapa.',
    ].join('\n');
}

function renderStatus({
    services = {},
    isGroup = false,
    groupEnabled = true,
    legacyBcEnabled = false,
    migrationStatus = null,
} = {}) {
    const serviceNames = Object.keys(services);
    const migrationLine = migrationStatus
        ? `Migrations Devo: ${migrationStatus.applied}/${migrationStatus.total} aplicadas`
        : 'Migrations Devo: indisponivel';
    const pendingLine = migrationStatus?.pending?.length
        ? `Pendentes: ${migrationStatus.pending.map((item) => item.id).join(', ')}`
        : 'Pendentes: nenhuma';

    return [
        `*${DEVO_MODULE_NAME}*`,
        '',
        `Status: online`,
        `Versao: ${DEVO_BASE_VERSION}`,
        `Prefixo: ${DEVO_PREFIX}`,
        `Comandos ativos: ${ACTIVE_DEVO_COMMANDS.join(', ')}`,
        `Contexto: ${isGroup ? 'grupo' : 'privado'}`,
        `Grupo habilitado: ${isGroup ? (groupEnabled ? 'sim' : 'nao') : 'n/a'}`,
        `Legado BC ativo: ${legacyBcEnabled ? 'sim' : 'nao'}`,
        migrationLine,
        pendingLine,
        `Servicos secos carregados: ${serviceNames.length ? serviceNames.join(', ') : 'nenhum'}`,
    ].join('\n');
}

function renderUnknownCommand(commandName) {
    return [
        `Subcomando Devo nao reconhecido: *${commandName || '-'}*`,
        '',
        `Use *${DEVO_PREFIX} help* para ver o que esta ativo agora.`,
    ].join('\n');
}

function renderLifeUsage() {
    return [
        'Uso:',
        `- *${DEVO_PREFIX} tempo*`,
        `- *${DEVO_PREFIX} tempo <recordId|userId|numero>*`,
        `- *${DEVO_PREFIX} life dar <recordId|userId|numero> <tempo> | <motivo>*`,
        `- *${DEVO_PREFIX} life tirar <recordId|userId|numero> <tempo> | <motivo>*`,
        `- *${DEVO_PREFIX} dv recompensar <dvId|codigo> <recordId|userId|numero> <tempo> | <motivo>*`,
        `- *${DEVO_PREFIX} dv penalizar <dvId|codigo> <recordId|userId|numero> <tempo> | <motivo>*`,
        '',
        'Tempo: use formatos simples como 30m, 2h, 1d ou 7d. Motivo e obrigatorio para alteracoes.',
    ].join('\n');
}

function formatLedgerType(type) {
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

function renderLifeSummary({ record = null, summary = null } = {}) {
    if (!record || !summary) return 'Resumo de tempo nao encontrado.';

    const lines = [
        `Tempo de *${record.name || '-'}*`,
        `Status: ${summary.life_status || record.life_status || '-'}`,
        `Restante: ${formatLifeDuration(summary.life_remaining_seconds)}`,
    ];

    const recent = summary.recent || [];
    if (!recent.length) {
        lines.push('', 'Ultimas transacoes: nenhuma.');
        return lines.join('\n');
    }

    lines.push('', 'Ultimas transacoes:');
    for (const item of recent.slice(0, 5)) {
        const amount = formatLifeDuration(item.amount_seconds);
        const type = formatLedgerType(item.type);
        const reason = item.reason || '-';
        const createdAt = item.created_at || '-';
        lines.push(`- ${type}: ${amount} - ${reason} - ${createdAt}`);
    }

    return lines.join('\n');
}

function renderLifeChanged({ action = null, amountSeconds = 0, reason = '', record = null, result = {}, vote = null } = {}) {
    const labels = {
        dar: 'Tempo concedido.',
        tirar: 'Tempo removido.',
        recompensar: 'Recompensa aplicada.',
        penalizar: 'Penalidade aplicada.',
    };

    const lines = [
        labels[action] || 'Tempo alterado.',
        `Record: ${record?.name || '-'} (${record?.id || '-'})`,
        `Alteracao: ${formatLifeDuration(amountSeconds)}`,
        `Restante: ${formatLifeDuration(result.newRemaining)}`,
        `Status: ${result.life_status || '-'}`,
        `Motivo: ${reason || '-'}`,
    ];

    if (vote) {
        lines.splice(2, 0, `Deadly Vote: ${vote.title || vote.id || '-'} (${vote.code || '-'})`);
    }

    return lines.join('\n');
}




function renderRecordUsage() {
    return [
        `Uso:`,
        `- *${DEVO_PREFIX} record criar <userId|jid|numero> | <nome>*`,
        `- *${DEVO_PREFIX} record ver [recordId|userId|numero]*`,
        `- *${DEVO_PREFIX} record listar [limit]*`,
        '',
        'Regras: criação somente Owner/Gerente; players veem apenas o proprio Record; players nao listam records.',
    ].join('\n');
}

function renderRecordCreated(record) {
    if (!record) return 'Record criado.';
    return [
        `Record criado: *${record.name}*`,
        `ID: ${record.id}`,
        `Usuario: ${record.user_id}`,
        `Status: ${record.status}`,
    ].join('\n');
}

function renderRecordView(record) {
    if (!record) return 'Record nao encontrado.';
    return [
        `Record: *${record.name}*`,
        `ID: ${record.id}`,
        `Usuario: ${record.user_id}`,
        `Status: ${record.status}`,
        `Life: ${Number(record.life_remaining_seconds || 0)}s · ${record.life_status || '-'}?`,
        `Criado: ${record.created_at}`,
    ].join('\n');
}

function renderRecordList(records) {
    if (!records || !records.length) return 'Nenhum record encontrado.';
    const lines = records.map((r) => `- ${r.name} · ${r.id} · ${r.user_id}`);
    return ['Records encontrados:', ...lines].join('\n');
}

function renderDeadlyVoteUsage() {
    return [
        'Uso:',
        `- *${DEVO_PREFIX} dv criar <titulo> | vagas=<n> | codigo=<opcional>*`,
        `- *${DEVO_PREFIX} dv ver <id|codigo>*`,
        `- *${DEVO_PREFIX} dv listar [status] [limit]*`,
        `- *${DEVO_PREFIX} dv convocar <dvId|codigo> <recordId|userId|numero...>*`,
        `- *${DEVO_PREFIX} dv participantes <dvId|codigo>*`,
        `- *${DEVO_PREFIX} dv remover <dvId|codigo> <recordId|userId|numero>*`,
        `- *${DEVO_PREFIX} dv resolver <dvId|codigo> <sobrevivente|morto|desistente> <recordId|userId|numero>*`,
        `- *${DEVO_PREFIX} dv recompensar <dvId|codigo> <recordId|userId|numero> <tempo> | <motivo>*`,
        `- *${DEVO_PREFIX} dv penalizar <dvId|codigo> <recordId|userId|numero> <tempo> | <motivo>*`,
        `- *${DEVO_PREFIX} dv iniciar <dvId|codigo>*`,
        `- *${DEVO_PREFIX} dv encerrar <dvId|codigo>*`,
        `- *${DEVO_PREFIX} dv cancelar <dvId|codigo>*`,
        '',
        'Regras: comandos dv desta etapa somente Owner/Gerente; sem morte/sobrevivencia, recompensa ou vida.',
    ].join('\n');
}

function renderDeadlyVoteCreated(vote) {
    if (!vote) return 'Deadly Vote criado.';
    return [
        `Deadly Vote criado: *${vote.title}*`,
        `ID: ${vote.id}`,
        `Codigo: ${vote.code}`,
        `Status: ${vote.status}`,
        `Vagas: ${Number(vote.reserved_slots || 0)}/${Number(vote.max_slots || 0)}`,
    ].join('\n');
}

function renderDeadlyVoteView(vote) {
    if (!vote) return 'Deadly Vote nao encontrado.';
    return [
        `Deadly Vote: *${vote.title}*`,
        `ID: ${vote.id}`,
        `Codigo: ${vote.code}`,
        `Status: ${vote.status}`,
        `Vagas: ${Number(vote.reserved_slots || 0)}/${Number(vote.max_slots || 0)}`,
        `Criado por gerente: ${vote.created_by_manager_id || '-'}`,
        `Criado: ${vote.created_at}`,
        `Atualizado: ${vote.updated_at}`,
    ].join('\n');
}

function renderDeadlyVoteList(votes) {
    if (!votes || !votes.length) return 'Nenhum Deadly Vote encontrado.';
    const lines = votes.map((vote) => {
        const slots = `${Number(vote.reserved_slots || 0)}/${Number(vote.max_slots || 0)}`;
        return `- ${vote.title} - ${vote.code} - ${vote.status} - vagas ${slots}`;
    });
    return ['Deadly Votes encontrados:', ...lines].join('\n');
}

function renderInvitationUsage() {
    return [
        'Uso:',
        `- *${DEVO_PREFIX} dv convocar <dvId|codigo> <recordId|userId|numero...>*`,
        `- *${DEVO_PREFIX} convocacoes*`,
        `- *${DEVO_PREFIX} convocacoes <recordId|userId|numero>*`,
        '',
        'Regras: convocar somente Owner/Gerente; players veem apenas as proprias convocacoes pendentes.',
    ].join('\n');
}

function renderInvitationCreatedSummary(result = {}) {
    if (result.invalidStatus) {
        return `Deadly Vote nao aceita convocacoes no status atual: ${result.invalidStatus}.`;
    }

    const created = result.created || [];
    const skipped = result.skipped || [];
    const duplicates = result.duplicates || [];
    const notFound = result.notFound || [];

    const lines = [
        'Convocacao processada.',
        `Novos convites: ${created.length}`,
        `Duplicados: ${duplicates.length}`,
        `Ignorados: ${skipped.length}`,
        `Nao encontrados: ${notFound.length}`,
        `Status DV: ${result.previousStatus || '-'} -> ${result.nextStatus || result.previousStatus || '-'}`,
    ];

    if (created.length) {
        lines.push('', 'Criados:');
        for (const invitation of created) {
            lines.push(`- ${invitation.record_id} (${invitation.id})`);
        }
    }

    if (duplicates.length) {
        lines.push('', 'Duplicados:');
        for (const item of duplicates) {
            lines.push(`- ${item.target || item.recordId} (${item.reason || 'duplicado'})`);
        }
    }

    if (skipped.length) {
        lines.push('', 'Ignorados:');
        for (const item of skipped) {
            lines.push(`- ${item.target || item.recordId} (${item.reason || item.status || 'ignorado'})`);
        }
    }

    if (notFound.length) {
        lines.push('', 'Nao encontrados:');
        for (const item of notFound) {
            lines.push(`- ${item.target}`);
        }
    }

    return lines.join('\n');
}

function renderConvocationsList(invitations) {
    if (!invitations || !invitations.length) return 'Nenhuma convocacao pendente encontrada.';

    const lines = invitations.map((invitation) => {
        const expires = invitation.expires_at || '-';
        return `- ${invitation.deadly_vote_title || invitation.deadly_vote_id} (${invitation.deadly_vote_code || '-'}) - ${invitation.status} - criada ${invitation.created_at} - expira ${expires}`;
    });

    return ['Convocacoes pendentes:', ...lines].join('\n');
}

function renderInvitationResponseUsage() {
    return [
        'Uso:',
        `- *${DEVO_PREFIX} entrar <dvCodigo|conviteId>*`,
        `- *${DEVO_PREFIX} recusar <dvCodigo|conviteId>*`,
        '',
        'Regras: apenas o Record dono do convite pendente pode responder.',
    ].join('\n');
}

function renderInvitationAccepted(result = {}) {
    const vote = result.vote || {};
    const invitation = result.invitation || {};
    const participant = result.participant || {};

    return [
        'Entrada confirmada.',
        `Deadly Vote: ${vote.title || invitation.deadly_vote_title || vote.id || '-'}`,
        `Codigo: ${vote.code || invitation.deadly_vote_code || '-'}`,
        `Convite: ${invitation.id || '-'}`,
        `Participante: ${participant.id || '-'}`,
        `Vagas: ${Number(vote.reserved_slots || 0)}/${Number(vote.max_slots || 0)}`,
        `Status DV: ${vote.status || invitation.deadly_vote_status || '-'}`,
    ].join('\n');
}

function renderInvitationRefused(result = {}) {
    const vote = result.vote || {};
    const invitation = result.invitation || {};

    return [
        'Convocacao recusada.',
        `Deadly Vote: ${vote.title || invitation.deadly_vote_title || vote.id || '-'}`,
        `Codigo: ${vote.code || invitation.deadly_vote_code || '-'}`,
        `Convite: ${invitation.id || '-'}`,
        `Status convite: ${invitation.status || '-'}`,
    ].join('\n');
}

function renderInvitationNoSlots(result = {}) {
    const vote = result.vote || {};
    const invitation = result.invitation || {};

    return [
        'Sem vaga disponivel.',
        `Deadly Vote: ${vote.title || invitation.deadly_vote_title || vote.id || '-'}`,
        `Codigo: ${vote.code || invitation.deadly_vote_code || '-'}`,
        `Convite: ${invitation.id || '-'}`,
        `Status convite: ${invitation.status || 'sem_vaga'}`,
        `Vagas: ${Number(vote.reserved_slots || 0)}/${Number(vote.max_slots || 0)}`,
    ].join('\n');
}

function renderParticipantUsage() {
    return [
        'Uso:',
        `- *${DEVO_PREFIX} dv participantes <dvId|codigo>*`,
        `- *${DEVO_PREFIX} dv remover <dvId|codigo> <recordId|userId|numero>*`,
        '',
        'Regras: somente Owner/Gerente; remover apenas antes do inicio do Deadly Vote.',
    ].join('\n');
}

function renderParticipantsList({ vote = null, participants = [] } = {}) {
    if (!vote) return 'Deadly Vote nao encontrado.';
    const header = [
        `Participantes de *${vote.title}* (${vote.code || vote.id})`,
        `Status DV: ${vote.status}`,
        `Vagas: ${Number(vote.reserved_slots || 0)}/${Number(vote.max_slots || 0)}`,
    ];

    if (!participants || !participants.length) {
        return [...header, '', 'Nenhum participante encontrado.'].join('\n');
    }

    const lines = participants.map((participant) => {
        const joinedAt = participant.joined_at || '-';
        const resolvedAt = participant.resolved_at || '-';
        return [
            `- ${participant.id}`,
            `record: ${participant.record_id}`,
            `nome: ${participant.record_name || '-'}`,
            `status: ${participant.status}`,
            `joined_at: ${joinedAt}`,
            `resolved_at: ${resolvedAt}`,
        ].join(' | ');
    });

    return [...header, '', ...lines].join('\n');
}

function renderParticipantRemoved(result = {}) {
    const vote = result.vote || {};
    const previousVote = result.previousVote || {};
    const record = result.record || {};
    const participant = result.participant || {};

    return [
        'Participante removido.',
        `Deadly Vote: ${vote.title || previousVote.title || vote.id || '-'}`,
        `Codigo: ${vote.code || previousVote.code || '-'}`,
        `Record: ${record.name || '-'} (${record.id || '-'})`,
        `Participante: ${participant.id || '-'}`,
        `Status: ${participant.status || 'removido'}`,
        `Resolved_at: ${participant.resolved_at || '-'}`,
        `Vagas: ${Number(vote.reserved_slots || 0)}/${Number(vote.max_slots || previousVote.max_slots || 0)}`,
        `Status DV: ${previousVote.status || '-'} -> ${vote.status || '-'}`,
    ].join('\n');
}

function renderResolutionUsage() {
    return [
        'Uso:',
        `- *${DEVO_PREFIX} dv resolver <dvId|codigo> sobrevivente <recordId|userId|numero>*`,
        `- *${DEVO_PREFIX} dv resolver <dvId|codigo> morto <recordId|userId|numero>*`,
        `- *${DEVO_PREFIX} dv resolver <dvId|codigo> desistente <recordId|userId|numero>*`,
        '',
        'Regras: somente Owner/Gerente; DV precisa estar em resolucao_pendente; sem recompensa, penalidade ou vida.',
    ].join('\n');
}

function renderParticipantResolved(result = {}) {
    const vote = result.vote || {};
    const previousVote = result.previousVote || {};
    const record = result.record || {};
    const previousRecord = result.previousRecord || {};
    const participant = result.participant || {};
    const previousParticipant = result.previousParticipant || {};

    const lines = [
        'Participante resolvido.',
        `Deadly Vote: ${vote.title || previousVote.title || vote.id || '-'}`,
        `Codigo: ${vote.code || previousVote.code || '-'}`,
        `Record: ${record.name || previousRecord.name || '-'} (${record.id || previousRecord.id || '-'})`,
        `Record status: ${previousRecord.status || '-'} -> ${record.status || '-'}`,
        `Participante: ${participant.id || '-'}`,
        `Status: ${previousParticipant.status || '-'} -> ${participant.status || result.resolution || '-'}`,
        `Resolved_at: ${participant.resolved_at || '-'}`,
        `Pendentes restantes: ${Number(result.pendingResolutionCount || 0)}`,
        `Status DV: ${previousVote.status || '-'} -> ${vote.status || '-'}`,
    ];

    if (result.autoClosed) {
        lines.push('Deadly Vote encerrado automaticamente.');
    }

    return lines.join('\n');
}

function renderDeadlyVoteCycleUsage() {
    return [
        'Uso:',
        `- *${DEVO_PREFIX} dv iniciar <dvId|codigo>*`,
        `- *${DEVO_PREFIX} dv encerrar <dvId|codigo>*`,
        `- *${DEVO_PREFIX} dv cancelar <dvId|codigo>*`,
        '',
        'Regras: somente Owner/Gerente; sem resolucao de morte/sobrevivencia, recompensa ou vida.',
    ].join('\n');
}

function renderDeadlyVoteStarted(result = {}) {
    const vote = result.vote || {};
    const previousVote = result.previousVote || {};

    return [
        'Deadly Vote iniciado.',
        `Deadly Vote: ${vote.title || previousVote.title || vote.id || '-'}`,
        `Codigo: ${vote.code || previousVote.code || '-'}`,
        `Status: ${previousVote.status || '-'} -> ${vote.status || '-'}`,
        `Started_at: ${vote.started_at || '-'}`,
        `Participantes ativados: ${Number(result.activatedParticipants || 0)}`,
    ].join('\n');
}

function renderDeadlyVoteEnded(result = {}) {
    const vote = result.vote || {};
    const previousVote = result.previousVote || {};

    return [
        'Deadly Vote encerrado.',
        `Deadly Vote: ${vote.title || previousVote.title || vote.id || '-'}`,
        `Codigo: ${vote.code || previousVote.code || '-'}`,
        `Status: ${previousVote.status || '-'} -> ${vote.status || '-'}`,
        `Ended_at: ${vote.ended_at || '-'}`,
        `Participantes pendentes de resolucao: ${Number(result.pendingResolutionParticipants || 0)}`,
    ].join('\n');
}

function renderDeadlyVoteCanceled(result = {}) {
    const vote = result.vote || {};
    const previousVote = result.previousVote || {};

    return [
        'Deadly Vote cancelado.',
        `Deadly Vote: ${vote.title || previousVote.title || vote.id || '-'}`,
        `Codigo: ${vote.code || previousVote.code || '-'}`,
        `Status: ${previousVote.status || '-'} -> ${vote.status || '-'}`,
        `Ended_at: ${vote.ended_at || '-'}`,
        `Convites pendentes revogados: ${Number(result.revokedPendingInvitations || 0)}`,
    ].join('\n');
}

module.exports = {
    renderHelp,
    renderStatus,
    renderUnknownCommand,
    renderLifeUsage,
    renderLifeSummary,
    renderLifeChanged,
    renderRecordUsage,
    renderRecordCreated,
    renderRecordView,
    renderRecordList,
    renderDeadlyVoteUsage,
    renderDeadlyVoteCreated,
    renderDeadlyVoteView,
    renderDeadlyVoteList,
    renderInvitationUsage,
    renderInvitationCreatedSummary,
    renderConvocationsList,
    renderInvitationAccepted,
    renderInvitationRefused,
    renderInvitationNoSlots,
    renderInvitationResponseUsage,
    renderParticipantUsage,
    renderParticipantsList,
    renderParticipantRemoved,
    renderResolutionUsage,
    renderParticipantResolved,
    renderDeadlyVoteCycleUsage,
    renderDeadlyVoteStarted,
    renderDeadlyVoteEnded,
    renderDeadlyVoteCanceled,
};
