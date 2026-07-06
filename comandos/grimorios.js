const { COMMAND_PREFIX } = require('../config/bot');
const { renderGrimoiresText, sendSystemText } = require('../helpers/clover/systemMessages');

module.exports = {
    nome: `${COMMAND_PREFIX}grimorios`,
    aliases: [`${COMMAND_PREFIX}grimórios`],
    descricao: 'Lista os grimorios disponiveis.',
    executar: async ({ sock, m, idChat, db }) => {
        await sendSystemText({ sock, idChat, m, text: await renderGrimoiresText(db) });
    },
};
