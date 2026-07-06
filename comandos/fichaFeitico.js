const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { renderSpellSheetTemplate } = require('../helpers/clover/spellbookService');

module.exports = {
    nome: `${COMMAND_PREFIX}fichafeitico`,
    aliases: [
        `${COMMAND_PREFIX}ficha feitico`,
        `${COMMAND_PREFIX}ficha feitiço`,
        `${COMMAND_PREFIX}fichafeitiço`,
        `${COMMAND_PREFIX}modelofeitico`,
        `${COMMAND_PREFIX}modelo feitico`,
        `${COMMAND_PREFIX}modelo feitiço`,
    ],
    descricao: 'Mostra o modelo de ficha de feitiço para avaliação.',
    groupBypass: true,
    executar: async ({ sock, m, idChat }) => {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderSpellSheetTemplate(),
        });
    },
};
