const { COMMAND_PREFIX } = require('../config/bot');
const { renderRacesText, sendSystemText } = require('../helpers/clover/systemMessages');

module.exports = {
    nome: `${COMMAND_PREFIX}racas`,
    aliases: [`${COMMAND_PREFIX}raças`],
    descricao: 'Lista as racas disponiveis.',
    executar: async ({ sock, m, idChat, db }) => {
        await sendSystemText({ sock, idChat, m, text: await renderRacesText(db) });
    },
};
