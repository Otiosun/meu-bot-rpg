const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { getPhHistory, getPhSummary } = require('../helpers/clover/phService');
const { normalizeText } = require('../helpers/textUtils');

function formatShortDate(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) return text || '-';
    return `${match[3]}/${match[2]} ${match[4]}:${match[5]}`;
}

function formatAmount(amount) {
    const value = Number(amount || 0);
    return value > 0 ? `+${value}` : String(value);
}

function formatKind(kind) {
    const labels = {
        ganho: 'ganho',
        gasto: 'gasto',
        perda: 'perda',
        ajuste_admin: 'ajuste ADM',
        estorno: 'estorno',
    };
    return labels[kind] || kind || '-';
}

function formatCreator(jid) {
    if (!jid) return '-';
    return `@${String(jid).split('@')[0]}`;
}

function renderPhSummary(summary) {
    const nextStage = summary.nextStageName || 'restrito/lore';
    const missing = summary.missingForNext === null
        ? 'restrito/lore'
        : `${summary.missingForNext} PH`;

    return [
        '♧┃𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐇𝐀𝐁𝐈𝐋𝐈𝐃𝐀𝐃𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  progresso, saldo ᥱ histórico de evolução  ──',
        '',
        '_`─( ✦ )───── 𝗦𝗮𝗹𝗱𝗼`_',
        '',
        `*𝐏𝐇 𝐚𝐜𝐮𝐦𝐮𝐥𝐚𝐝𝐨:* ${summary.phAccumulated}`,
        `*𝐏𝐇 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${summary.phAvailable}`,
        '',
        '_`─( ◆ )───── 𝗣𝗿𝗼𝗴𝗿𝗲𝘀𝘀𝗼`_',
        '',
        `*𝐄𝐬𝐜𝐚𝐥𝐚 𝐚𝐭𝐮𝐚𝐥:* ${summary.stageName}`,
        `*𝐏𝐫𝐨́𝐱𝐢𝐦𝐚 𝐞𝐬𝐜𝐚𝐥𝐚:* ${nextStage}`,
        `*𝐅𝐚𝐥𝐭𝐚:* ${missing}`,
        '',
        '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
        '',
        'ⓘ PH acumulado define estágio. PH disponível compra habilidades nas árvores.',
        '',
        '*̣.#ph histórico*',
        '> Ver ganhos e gastos de PH.',
    ].join('\n');
}

function renderPhHistory(rows) {
    if (!rows.length) {
        return [
            '♧┃𝐇𝐈𝐒𝐓𝐎́𝐑𝐈𝐂𝐎 𝐃𝐄 𝐏𝐇 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
            '     ──  ganhos, gastos ᥱ ajustes  ──',
            '',
            'Nenhum lançamento de PH registrado ainda.',
        ].join('\n');
    }

    return [
        '♧┃𝐇𝐈𝐒𝐓𝐎́𝐑𝐈𝐂𝐎 𝐃𝐄 𝐏𝐇 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  ganhos, gastos ᥱ ajustes  ──',
        '',
        ...rows.map((row) => [
            `*${formatShortDate(row.created_at)}* · ${formatKind(row.kind)} · ${formatAmount(row.amount)} PH`,
            `> Motivo: ${row.reason || '-'}`,
            `> Criado por: ${formatCreator(row.created_by)}`,
        ].join('\n')),
    ].join('\n\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}ph`,
    descricao: 'Mostra PH acumulado, PH disponível e histórico curto.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
            return;
        }

        if (normalizeText(body).startsWith('historico')) {
            const history = await getPhHistory(db, idJogador, 10);
            await sendReply({ sock, idChat, m, text: renderPhHistory(history) });
            return;
        }

        const summary = await getPhSummary(db, idJogador);
        await sendReply({ sock, idChat, m, text: renderPhSummary(summary) });
    },
};
