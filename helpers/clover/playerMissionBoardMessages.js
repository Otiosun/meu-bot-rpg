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

const STATUS_LABELS = Object.freeze({
    registered: 'Inscrito', in_progress: 'Em andamento', submitted: 'Aguardando avaliação',
    changes_requested: 'Ajustes solicitados', approved: 'Aprovada', rejected: 'Reprovada',
});
const STATUS_HEADER = Object.freeze({
    registered: '𝐌𝐈𝐒𝐒𝐀̃𝐎 𝐀𝐂𝐄𝐈𝐓𝐀', in_progress: '𝐌𝐈𝐒𝐒𝐀̃𝐎 𝐄𝐌 𝐀𝐍𝐃𝐀𝐌𝐄𝐍𝐓𝐎',
    submitted: '𝐀𝐓𝐔𝐀𝐂̧𝐀̃𝐎 𝐑𝐄𝐆𝐈𝐒𝐓𝐑𝐀𝐃𝐀', changes_requested: '𝐀𝐉𝐔𝐒𝐓𝐄𝐒 𝐒𝐎𝐋𝐈𝐂𝐈𝐓𝐀𝐃𝐎𝐒',
    approved: '𝐌𝐈𝐒𝐒𝐀̃𝐎 𝐀𝐏𝐑𝐎𝐕𝐀𝐃𝐀', rejected: '𝐌𝐈𝐒𝐒𝐀̃𝐎 𝐑𝐄𝐏𝐑𝐎𝐕𝐀𝐃𝐀',
});
function heading(title, subtitle) {
    return ['♧┃' + title + ' 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫', ...(subtitle ? ['     ──  ' + subtitle + '  ──'] : []), ''];
}
function section(symbol, title) {
    return ['','_' + String.fromCharCode(96) + '─( ' + symbol + ' )───── ' + title + String.fromCharCode(96) + '_',''];
}
function shortcut(command, description) {
    return ['*̣' + COMMAND_PREFIX + command + '*', ...(description ? ['> ' + description] : [])];
}
function money(value) {
    return Number(value).toLocaleString('pt-BR');
}
function rewardLines(reward, fixed = false) {
    const fmt = fixed ? money : formatRange;
    return [
        '*𝐏𝐇:* ' + fmt(reward.ph),
        '*𝐘𝐮𝐥𝐥𝐬:* ' + fmt(reward.yulls),
        '*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* ' + fmt(reward.stars),
    ];
}
function paragraph(value, max) {
    return String(value || '').slice(0, max).split(/\r?\n/).map(line =>
        line.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u031d]/g, '').replace(/[*_~<>]/g, '').replace(/\x60/g, '').trim()
    ).join('\n').trim();
}
function renderMissionBoard(result) {
    const lines = heading('𝐌𝐔𝐑𝐀𝐋 𝐃𝐄 𝐌𝐈𝐒𝐒𝐎̃𝐄𝐒', 'ordens ᥱ serviços do reino');
    if (!result.total) {
        lines.push('> Nenhuma missão disponível' + (result.rank ? ' de rank ' + result.rank : '') + ' no momento.');
    } else if (!result.missions.length) {
        lines.push('> Esta página não existe. Última página: ' + result.pages + '.');
        lines.push(...shortcut('missoes' + (result.rank ? ' ' + result.rank : '') + ' ' + result.pages));
    } else {
        for (const rank of ['E','D','C','B','A','S']) {
            const missions = result.missions.filter(m => m.rank === rank);
            if (!missions.length) continue;
            lines.push(...section('◆', '𝗥𝗮𝗻𝗸 ' + rank));
            for (const mission of missions) {
                lines.push('*' + oneLine(mission.title) + '*',
                    '> ' + (TYPE_LABELS[mission.missionType] || 'Missão') + ' • ' + (MODE_LABELS[mission.mode] || 'Missão'),
                    ...shortcut('missao ' + mission.missionKey), '');
            }
        }
        if (result.pages > 1) {
            lines.push('> Página ' + result.page + '/' + result.pages);
            if (result.page > 1) lines.push(...shortcut('missoes' + (result.rank ? ' ' + result.rank : '') + ' ' + (result.page - 1), 'Página anterior.'));
            if (result.page < result.pages) lines.push(...shortcut('missoes' + (result.rank ? ' ' + result.rank : '') + ' ' + (result.page + 1), 'Próxima página.'));
        }
    }
    lines.push(...section('■','𝗔𝘁𝗮𝗹𝗵𝗼𝘀'), ...shortcut('missao <código>', 'Consultar uma missão.'), '', ...shortcut('missoes D', 'Filtrar por rank.'), '', ...shortcut('minhasmissoes', 'Suas participações.'));
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function renderMissionDetail(mission) {
    if (!mission) return [...heading('𝐌𝐈𝐒𝐒𝐀̃𝐎'), '> Missão indisponível.', '', ...shortcut('missoes', 'Consultar o mural.')].join('\n');
    const reward = mission.reward || {};
    const exact = ['ph','stars','yulls'].every(k => Array.isArray(reward[k]) && reward[k].length === 2 && Number.isSafeInteger(reward[k][0]) && reward[k][0] >= 0 && reward[k][0] === reward[k][1]) && !reward.extra;
    const lines = [
        ...heading('𝐌𝐈𝐒𝐒𝐀̃𝐎', 'Rank ' + oneLine(mission.rank)),
        '*' + oneLine(mission.title) + '*',
        '',
        '*𝐓𝐢𝐩𝐨:* ' + (TYPE_LABELS[mission.missionType] || oneLine(mission.missionType)),
        '*𝐌𝐨𝐝𝐨:* ' + (MODE_LABELS[mission.mode] || oneLine(mission.mode)),
        '*𝐋𝐨𝐜𝐚𝐥:* ' + oneLine(mission.location,240),
        '*𝐕𝐚𝐠𝐚𝐬:* ' + (mission.slots == null ? 'Sem limite anunciado' : mission.slots),
        '*𝐏𝐫𝐚𝐳𝐨:* ' + formatDeadline(mission.deadlineAt),
        '*𝐑𝐢𝐬𝐜𝐨:* ' + oneLine(mission.risk,400),
        ...section('◆','𝗣𝗿𝗼𝗽𝗼𝘀𝘁𝗮'),
        paragraph(mission.description,1500),
    ];
    if (mission.specialConditions) lines.push('', '*𝐂𝐨𝐧𝐝𝐢𝐜̧𝐨̃𝐞𝐬:*', paragraph(mission.specialConditions,450));
    if (mission.failureConsequence) lines.push('', '*𝐅𝐚𝐥𝐡𝐚:*', paragraph(mission.failureConsequence,450));
    lines.push(...section('✦','𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀'), ...rewardLines(reward));
    if (reward.extra) lines.push('*𝐄𝐱𝐭𝐫𝐚𝐬:* ' + oneLine(reward.extra,300));
    lines.push('', exact ? '> Recompensa-base concedida após aprovação.' : '> Inscrições aguardando liberação da equipe.');
    if (exact) lines.push(...section('■','𝗣𝗮𝗿𝘁𝗶𝗰𝗶𝗽𝗮𝗿'), ...shortcut('missao ' + mission.missionKey + ' aceitar'));
    return lines.join('\n');
}
function renderParticipation(record, duplicate = false) {
    const lines = [...heading(STATUS_HEADER[record.status] || '𝐌𝐈𝐒𝐒𝐀̃𝐎'), '*' + oneLine(record.title) + '*', '', '*𝐄𝐬𝐭𝐚𝐝𝐨:* ' + (STATUS_LABELS[record.status] || 'Indisponível')];
    if (duplicate) lines.push('> Este registro já existia.');
    if (record.status === 'registered') lines.push('', ...shortcut('missao ' + record.missionKey + ' iniciar', 'Iniciar a missão.'));
    if (record.status === 'in_progress' || record.status === 'changes_requested') {
        if (record.reviewReason) lines.push('', '> ' + oneLine(record.reviewReason,400));
        lines.push('', ...shortcut('missao ' + record.missionKey + ' entregar', 'Responda à mensagem da sua atuação.'));
    }
    if (record.status === 'submitted') lines.push('> Aguarde a avaliação da equipe.');
    if (record.status === 'rejected' && record.reviewReason) lines.push('', '> ' + oneLine(record.reviewReason,400));
    if (record.status === 'approved') lines.push(...section('✦','𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀'), ...rewardLines(record.reward,true));
    if (record.deadlineAt && ['registered','in_progress'].includes(record.status)) lines.push('', '*𝐏𝐫𝐚𝐳𝐨:* ' + formatDeadline(record.deadlineAt));
    return lines.join('\n');
}
function renderMyMissions(result) {
    const lines = heading('𝐌𝐈𝐍𝐇𝐀𝐒 𝐌𝐈𝐒𝐒𝐎̃𝐄𝐒','participações ᥱ registros');
    if (!result.total) lines.push('> Nenhuma participação registrada.');
    else if (!result.missions.length) lines.push('> Esta página não existe.');
    for (const state of ['changes_requested','in_progress','registered','submitted','approved','rejected']) {
        const records = result.missions.filter(m => m.status === state);
        if (!records.length) continue;
        lines.push(...section('◆',STATUS_LABELS[state]));
        for (const record of records) lines.push('*' + oneLine(record.title) + '*', ...shortcut('missao ' + record.missionKey + ' status'), '');
    }
    if (result.pages > 1) {
        lines.push('> Página ' + result.page + '/' + result.pages);
        if (result.page > 1) lines.push(...shortcut('minhasmissoes ' + (result.page - 1)));
        if (result.page < result.pages) lines.push(...shortcut('minhasmissoes ' + (result.page + 1)));
    }
    lines.push('', ...shortcut('missoes','Consultar o mural.'));
    return lines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
module.exports = { renderMissionBoard, renderMissionDetail, renderParticipation, renderMyMissions };
