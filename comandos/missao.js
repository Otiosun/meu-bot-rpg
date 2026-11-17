'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { getPublicMission } = require('../helpers/clover/playerMissionBoardService');
const { renderMissionDetail } = require('../helpers/clover/playerMissionBoardMessages');

module.exports = {
    nome: `${COMMAND_PREFIX}missao`,
    aliases: [`${COMMAND_PREFIX}missão`],
    descricao: 'Mostra a descrição, o prazo, os riscos e as possíveis recompensas de uma missão pública.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const phase = await getPlayerPhase(db, idJogador);
        if (!phase.canPlay) {
            await sendReply({ sock, m, idChat, text: renderGameBlockedMessage() });
            return;
        }
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        if (tokens.length !== 1) {
            await sendReply({
                sock, m, idChat,
                text: `Uso: ${COMMAND_PREFIX}missao <código>\n> Liste com ${COMMAND_PREFIX}missoes.`,
            });
            return;
        }
        const mission = await getPublicMission(db, tokens[0]);
        await sendReply({ sock, m, idChat, text: renderMissionDetail(mission) });
    },
};
