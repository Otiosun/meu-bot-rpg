'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
} = require('../helpers/clover/accessIntegrationService');
const {
    renderSquadState,
    resolveSquad,
} = require('../helpers/clover/squadStateService');
const { getIntegratedSquadState } = require('../helpers/clover/squadStateIntegrationService');

module.exports = {
    nome: `${COMMAND_PREFIX}estadoesquadrao`,
    aliases: [
        `${COMMAND_PREFIX}estadoesquadrão`,
        `${COMMAND_PREFIX}qualidadeesquadrao`,
        `${COMMAND_PREFIX}qualidadeesquadrão`,
        `${COMMAND_PREFIX}esquadraoestado`,
        `${COMMAND_PREFIX}esquadrãoestado`,
    ],
    descricao: 'Interpreta mérito, recursos, reputação, organização e estrutura do esquadrão.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const explicitSquadName = String(body || '').trim();
        const squad = await resolveSquad(db, {
            squadName: explicitSquadName || null,
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

        const sameRegisteredGroup = !explicitSquadName
            && idChat?.endsWith('@g.us')
            && squad.group_id === idChat;
        if (!sameRegisteredGroup) {
            const access = await authorizeSquadAccess(db, {
                actorId: idJogador,
                squad,
                permission: ACCESS_PERMISSIONS.SQUAD_STATE_READ,
                allowMemberRead: true,
            });
            if (!access.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: 'Você não possui acesso ao estado desse esquadrão.',
                });
                return;
            }
        }

        const state = await getIntegratedSquadState(db, squad);
        await sendReply({
            sock,
            idChat,
            m,
            text: renderSquadState(state, { prefix: COMMAND_PREFIX }),
        });
    },
};
