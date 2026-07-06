const { COMMAND_PREFIX } = require('../config/bot');
const { getSystemText, sendSystemText } = require('../helpers/clover/systemMessages');

module.exports = {
    nome: `${COMMAND_PREFIX}reinos`,
    descricao: 'Lista os reinos disponiveis.',
    executar: async ({ sock, m, idChat }) => {
        await sendSystemText({ sock, idChat, m, text: getSystemText('reinos') });
    },
};
