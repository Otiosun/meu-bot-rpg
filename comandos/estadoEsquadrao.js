'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    getSquadState,
    renderSquadState,
    resolveSquad,
} = require('../helpers/clover/squadStateService');

module.exports = {
    nome: `${COMMAND_PREFIX}estadoesquadrao`,
    aliases: [
        `${COMMAND_PREFIX}estadoesquadrão`,
        `${COMMAND_PREFIX}qualidadeesquadrao`,
        `${COMMAND_PREFIX}qualidadeesquadrão`,
        `${COMMAND_PREFIX}esquadraoestado`,
        `${COMMAND_PREFIX}esquadrãoestado`,
    ],
    descricao: 'Interpreta mérito, recursos, reputação e organização do esquadrão.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const squad = await resolveSquad(db, {
            squadName: String(body || '').trim() || null,
            groupId: idChat?.endsWith('@g.us') ? idChat : null,
            playerId: idJogador,
        });

        if (!squad) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃𝐄𝐒𝐓𝐀𝐃𝐎 𝐃𝐎 𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                    '',
                    '> Não encontrei um esquadrão neste grupo ou no seu personagem.',
                    `> Consulte pelo nome: ${COMMAND_PREFIX}estadoesquadrao Touros Negros`,
                ].join('\n'),
            });
            return;
        }

        const state = await getSquadState(db, squad);
        await sendReply({
            sock,
            idChat,
            m,
            text: renderSquadState(state, { prefix: COMMAND_PREFIX }),
        });
    },
};
