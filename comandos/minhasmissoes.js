'use strict';
const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { listMyMissions } = require('../helpers/clover/playerMissionLifecycleService');
const { renderMyMissions } = require('../helpers/clover/playerMissionBoardMessages');

module.exports = {
    nome: COMMAND_PREFIX + 'minhasmissoes',
    aliases: [COMMAND_PREFIX + 'minhasmissões'],
    descricao: 'Consulta suas participações em missões.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const reply = text => sendReply({ sock, m, idChat, text });
        const phase = await getPlayerPhase(db, idJogador);
        if (!phase.canPlay) return reply(renderGameBlockedMessage());
        const input = String(body || '').trim();
        if (input && (!/^\d{1,4}$/.test(input) || Number(input) < 1)) {
            return reply('> Use ' + COMMAND_PREFIX + 'minhasmissoes [página].');
        }
        return reply(renderMyMissions(await listMyMissions(db, phase.player?.id || idJogador, { page: Number(input || 1) })));
    },
};
