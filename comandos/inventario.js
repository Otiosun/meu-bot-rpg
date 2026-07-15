const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    formatStars,
    formatYulls,
    getCavalierSummary,
    getInventoryItems,
} = require('../helpers/clover/cavalierService');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');

function display(value, fallback = '-') {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : fallback;
}

function getPlayerName(player = {}) {
    return display(player.personagem_nome || player.nome || player.display_name, 'Personagem');
}

function getItemUseHint(item = {}) {
    if (item.kind === 'caixa_pa') return `${COMMAND_PREFIX}pa abrir`;
    if (item.kind === 'cupom_pa') return `${COMMAND_PREFIX}pa prioridade`;
    return null;
}

function formatItemLine(item) {
    const quantity = Number(item.quantity || 1);
    const prefix = quantity > 1 ? `${quantity}x ` : '';
    const lines = [`*${prefix}${item.item_name}*`];

    if (display(item.description, '') !== '') {
        lines.push(`> ${item.description}`);
    }

    const useHint = getItemUseHint(item);
    if (useHint) lines.push(`> 𝐔𝐬𝐨: ${useHint}`);

    return lines.join('\n');
}

function renderInventoryMessage(summary, items) {
    const squad = summary.squad;
    const lines = [
        '♧┃𝐂𝐀𝐑𝐓𝐄𝐈𝐑𝐀 𝐄 𝐈𝐍𝐕𝐄𝐍𝐓𝐀́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  recursos, estrelas e itens registrados  ──',
        '',
        '_`─( ★ )───── 𝗖𝗮𝘃𝗮𝗹𝗲𝗶𝗿𝗼`_',
        '',
        `*𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐠𝐞𝐦:* ${getPlayerName(summary.player)}`,
        `*𝐘𝐮𝐥𝐥𝐬:* ${formatYulls(summary.yulls)}`,
        `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* ${formatStars(summary.stars)}`,
        `*𝐏𝐚𝐭𝐞𝐧𝐭𝐞:* ${summary.patent}`,
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${squad ? squad.name : display(summary.player.esquadrao)}`,
    ];

    if (squad) {
        lines.push(
            `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬 𝐚𝐭𝐮𝐚𝐢𝐬:* ${formatStars(squad.currentStars)}`,
            `*𝐇𝐢𝐬𝐭𝐨́𝐫𝐢𝐜𝐨:* ${formatStars(squad.historicalStars)}`
        );
    }

    lines.push(
        '',
        '_`─( ■ )───── 𝗜𝗻𝘃𝗲𝗻𝘁𝗮́𝗿𝗶𝗼`_',
        ''
    );

    if (!items.length) {
        lines.push('Você ainda não possui itens registrados.');
    } else {
        lines.push(...items.map(formatItemLine));
    }

    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}inventario`,
    aliases: [
        `${COMMAND_PREFIX}inventário`,
        `${COMMAND_PREFIX}inv`,
        `${COMMAND_PREFIX}carteira`,
        `${COMMAND_PREFIX}cavaleiro`,
    ],
    descricao: 'Mostra carteira, estrelas, patente e inventário.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
            return;
        }

        const summary = await getCavalierSummary(db, idJogador);
        if (!summary.ok) {
            await sendReply({ sock, idChat, m, text: 'Não encontrei seu personagem no banco.' });
            return;
        }

        const items = await getInventoryItems(db, idJogador, 30);
        await sendReply({
            sock,
            idChat,
            m,
            text: renderInventoryMessage(summary, items),
        });
    },
    formatItemLine,
    getItemUseHint,
    renderInventoryMessage,
};
