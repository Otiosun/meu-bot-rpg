'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    getCavalierSummary,
    getInventoryItemByPosition,
    getInventoryItems,
    getInventoryPage,
} = require('../helpers/clover/cavalierService');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const {
    formatItemLine,
    getItemUseHint,
    renderInventoryDetail,
    renderInventoryFull,
    renderInventoryPage,
} = require('../helpers/clover/playerOverviewPresentation');
const { normalizeText } = require('../helpers/textUtils');

function normalizeAction(value) {
    return normalizeText(value || '').replace(/[^a-z0-9]+/g, '');
}

function parseInventoryRequest(body) {
    const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { mode: 'page', page: 1 };

    const action = normalizeAction(tokens[0]);
    if (['completo', 'full', 'tudo', 'detalhado'].includes(action)) return { mode: 'full' };
    if (['detalhe', 'item', 'ver', 'abrir'].includes(action)) {
        const position = Number(tokens[1]);
        return Number.isInteger(position) && position > 0
            ? { mode: 'detail', position }
            : { mode: 'invalid' };
    }
    if (['pagina', 'pag', 'p'].includes(action)) {
        const page = Number(tokens[1]);
        return Number.isInteger(page) && page > 0
            ? { mode: 'page', page }
            : { mode: 'invalid' };
    }
    if (/^\d{1,3}$/.test(tokens[0])) return { mode: 'page', page: Number(tokens[0]) };
    return { mode: 'invalid' };
}

function renderUsage() {
    return [
        '*♧┃𝐈𝐍𝐕𝐄𝐍𝐓𝐀́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `> ${COMMAND_PREFIX}inventario`,
        `> ${COMMAND_PREFIX}inventario pagina 2`,
        `> ${COMMAND_PREFIX}inventario detalhe 3`,
        `> ${COMMAND_PREFIX}inventario completo`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}inventario`,
    aliases: [
        `${COMMAND_PREFIX}inventário`,
        `${COMMAND_PREFIX}inv`,
        `${COMMAND_PREFIX}cavaleiro`,
    ],
    descricao: 'Mostra carteira e inventário paginado.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
            return;
        }

        const request = parseInventoryRequest(body);
        if (request.mode === 'invalid') {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        const summary = await getCavalierSummary(db, idJogador);
        if (!summary.ok) {
            await sendReply({ sock, idChat, m, text: 'Não encontrei seu personagem no banco.' });
            return;
        }

        let text = '';
        if (request.mode === 'full') {
            const items = await getInventoryItems(db, idJogador, 50);
            text = renderInventoryFull(summary, items, { prefix: COMMAND_PREFIX });
        } else if (request.mode === 'detail') {
            const result = await getInventoryItemByPosition(db, idJogador, request.position);
            text = renderInventoryDetail(summary, result, { prefix: COMMAND_PREFIX });
        } else {
            const pageData = await getInventoryPage(db, idJogador, { page: request.page, pageSize: 8 });
            text = renderInventoryPage(summary, pageData, { prefix: COMMAND_PREFIX });
        }

        await sendReply({ sock, idChat, m, text });
    },
    formatItemLine,
    getItemUseHint,
    parseInventoryRequest,
    renderInventoryDetail,
    renderInventoryMessage: renderInventoryFull,
    renderInventoryPage,
    renderUsage,
};
