'use strict';

const { COMMAND_PREFIX } = require('../../config/bot');

const MODE_LABELS = Object.freeze({
    official: 'Oficial',
    auto_narrated: 'Autonarrada',
});
const TYPE_LABELS = Object.freeze({
    combat: 'Combate',
    escort: 'Escolta',
    investigation: 'Investigação',
    defense: 'Defesa',
    diplomacy: 'Diplomacia',
    support: 'Suporte',
});

function oneLine(value, max = 180) {
    return String(value ?? '-')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[*>_~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim().slice(0, max) || '-';
}

function formatDeadline(iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '-';
    return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date) + ' (Brasília)';
}

function formatRange(range) {
    if (!Array.isArray(range) || range.length !== 2) return 'a definir';
    return range[0] === range[1]
        ? String(range[0])
        : `${range[0]}–${range[1]}`;
}

function renderMissionBoard(result) {
    const header = '*♧┃𝐌𝐔𝐑𝐀𝐋 𝐃𝐄 𝐌𝐈𝐒𝐒𝐎̃𝐄𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*';
    if (result.total === 0) {
        return [
            header, '',
            result.rank
                ? `> Nenhuma missão pública de rank ${result.rank} está disponível no momento.`
                : '> Nenhuma missão pública está disponível no momento.',
            '',
            '> Novas missões aparecerão aqui quando forem publicadas.',
        ].join('\n');
    }
    if (!result.missions.length) {
        return [
            header, '',
            `> Página ${result.page} não existe. Última página: ${result.pages}.`,
            `> Use ${COMMAND_PREFIX}missoes${result.rank ? ' ' + result.rank : ''} ${result.pages}.`,
        ].join('\n');
    }
    return [
        header,
        '',
        `*Disponíveis:* ${result.total} ${result.rank ? '· Rank ' + result.rank : '· Todos os ranks'}`,
        `*Página:* ${result.page}/${result.pages}`,
        '',
        ...result.missions.flatMap((mission, index) => [
            `*${(result.page - 1) * 6 + index + 1}. ${oneLine(mission.title)}* · Rank ${oneLine(mission.rank)}`,
            `> ${oneLine(mission.location)} · ${MODE_LABELS[mission.mode] || 'Missão'}`,
            `> Código: ${mission.missionKey}`,
            '',
        ]),
        `> Detalhes: ${COMMAND_PREFIX}missao <código>`,
        `> Filtrar: ${COMMAND_PREFIX}missoes <rank> [página]`,
        result.page < result.pages
            ? `> Próxima página: ${COMMAND_PREFIX}missoes${result.rank ? ' ' + result.rank : ''} ${result.page + 1}`
            : '',
    ].filter((value, index, list) => value || index < list.length - 1).join('\n');
}

function renderMissionDetail(mission) {
    if (!mission) return [
        '*♧┃𝐌𝐈𝐒𝐒𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        '> Missão indisponível, encerrada ou não encontrada.',
        `> Consulte ${COMMAND_PREFIX}missoes para ver as missões públicas.`,
    ].join('\n');

    return [
        '*♧┃𝐌𝐈𝐒𝐒𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*${oneLine(mission.title)}*`,
        `*Código:* ${mission.missionKey}`,
        `*Rank:* ${oneLine(mission.rank)}`,
        `*Tipo:* ${TYPE_LABELS[mission.missionType] || oneLine(mission.missionType)}`,
        `*Modo:* ${MODE_LABELS[mission.mode] || oneLine(mission.mode)}`,
        `*Local:* ${oneLine(mission.location, 240)}`,
        `*Prazo:* ${formatDeadline(mission.deadlineAt)}`,
        `*Risco:* ${oneLine(mission.risk, 400)}`,
        '',
        '_`─( 📜 )───── Proposta`_',
        '',
        oneLine(mission.description, 1500),
        mission.specialConditions ? `\n*Condições:* ${oneLine(mission.specialConditions, 450)}` : '',
        mission.failureConsequence ? `*Consequência de falha:* ${oneLine(mission.failureConsequence, 450)}` : '',
        '',
        '_`─( ✦ )───── Recompensas possíveis`_',
        '',
        `*PH:* ${formatRange(mission.reward.ph)}`,
        `*Estrelas:* ${formatRange(mission.reward.stars)}`,
        `*Yulls:* ${formatRange(mission.reward.yulls)}`,
        mission.reward.extra ? `*Extras:* ${oneLine(mission.reward.extra, 300)}` : '',
        '',
        mission.reward.ph?.[0] === mission.reward.ph?.[1]
            && mission.reward.yulls?.[0] === mission.reward.yulls?.[1]
            && mission.reward.stars?.[0] === mission.reward.stars?.[1]
            && !mission.reward.extra
            ? '> Inscrever-se: ' + COMMAND_PREFIX + 'missao ' + mission.missionKey + ' aceitar'
            : '> Inscrição indisponível: a equipe precisa fixar o pacote-base e remover extras sem pagamento automático.',
        '> Depois de aceitar: ' + COMMAND_PREFIX + 'missao ' + mission.missionKey + ' iniciar',
        '> Entregar: ' + COMMAND_PREFIX + 'missao ' + mission.missionKey + ' entregar | <relato>',
        '> Acompanhar: ' + COMMAND_PREFIX + 'missao ' + mission.missionKey + ' status',
        `> Voltar: ${COMMAND_PREFIX}missoes`,
    ].filter(Boolean).join('\n');
}

module.exports = {
    renderMissionBoard,
    renderMissionDetail,
};
