'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { listPublicMissions, PUBLIC_RANKS } = require('../helpers/clover/playerMissionBoardService');
const { renderMissionBoard } = require('../helpers/clover/playerMissionBoardMessages');

function parseBoardArguments(body) {
    const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 2) return null;
    let rank = null;
    let page = 1;
    if (tokens.length && PUBLIC_RANKS.includes(tokens[0].toUpperCase())) {
        rank = tokens.shift().toUpperCase();
    }
    if (tokens.length) {
        if (!/^\d{1,4}$/.test(tokens[0])) return null;
        page = Number(tokens[0]);
        if (!Number.isSafeInteger(page) || page < 1) return null;
        tokens.shift();
    }
    return tokens.length ? null : { rank, page };
}

module.exports = {
    nome: `${COMMAND_PREFIX}missoes`,
    aliases: [`${COMMAND_PREFIX}missões`],
    descricao: 'Consulta o mural de missões públicas em andamento de publicação.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const phase = await getPlayerPhase(db, idJogador);
        if (!phase.canPlay) {
            await sendReply({ sock, m, idChat, text: renderGameBlockedMessage() });
            return;
        }
        const args = parseBoardArguments(body);
        if (!args) {
            await sendReply({
                sock, m, idChat,
                text: `Uso: ${COMMAND_PREFIX}missoes [rank E/D/C/B/A/S] [página]`,
            });
            return;
        }
        const result = await listPublicMissions(db, { ...args, limit: 6 });
        await sendReply({ sock, m, idChat, text: renderMissionBoard(result) });
    },
    parseBoardArguments,
};
