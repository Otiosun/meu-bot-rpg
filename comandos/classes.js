const { COMMAND_PREFIX } = require('../config/bot');
const { getSystemText, sendSystemText } = require('../helpers/clover/systemMessages');

module.exports = {
    nome: `${COMMAND_PREFIX}classes`,
    aliases: [`${COMMAND_PREFIX}classessociais`, `${COMMAND_PREFIX}classes sociais`],
    descricao: 'Lista as classes sociais disponiveis.',
    executar: async ({ sock, m, idChat }) => {
        await sendSystemText({ sock, idChat, m, text: getSystemText('classes') });
    },
};
