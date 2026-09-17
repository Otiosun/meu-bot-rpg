const { COMMAND_PREFIX } = require('../config/bot');
const { setCloverRegistrationGroup } = require('../helpers/clover/registrationManager');
const { sendReply } = require('../helpers/chatReply');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');

module.exports = {
    nome: `${COMMAND_PREFIX}setregistroclover`,
    aliases: [`${COMMAND_PREFIX}registroclover set`],
    descricao: 'Define este grupo como registro oficial de personagens Clover.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (!idChat?.endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Use este comando dentro do grupo que sera o registro Clover.',
            });
            return;
        }

        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode definir o registro Clover.',
            });
            return;
        }

        await setCloverRegistrationGroup(db, idChat);
        await sendReply({
            sock,
            idChat,
            m,
            text: 'Este grupo foi definido como registro oficial de personagens Clover.',
        });
    },
};
