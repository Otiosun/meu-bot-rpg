const { COMMAND_PREFIX } = require('../config/bot');
const { getCloverRegistrationGroup } = require('../helpers/clover/registrationManager');
const { sendReply } = require('../helpers/chatReply');

module.exports = {
    nome: `${COMMAND_PREFIX}registroclover`,
    descricao: 'Mostra o grupo configurado para registro Clover.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, db }) => {
        const groupId = await getCloverRegistrationGroup(db);
        await sendReply({
            sock,
            idChat,
            m,
            text: groupId
                ? `Grupo de registro Clover configurado: ${groupId}`
                : `Nenhum grupo de registro Clover configurado. Use *${COMMAND_PREFIX}setregistroclover* no grupo correto.`,
        });
    },
};
