const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    buildTemplateContext,
    findImagePath,
    renderEditableMessage,
} = require('../helpers/onboardingFlow');

function mentionFor(playerId) {
    return `@${String(playerId || '').split('@')[0]}`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}historia`,
    aliases: [
        `${COMMAND_PREFIX}história`,
        `${COMMAND_PREFIX}historiarpg`,
        `${COMMAND_PREFIX}historia rpg`,
        `${COMMAND_PREFIX}lore`,
    ],
    descricao: 'Mostra a história oficial configurável do RPG.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador }) => {
        const text = renderEditableMessage(
            'historia',
            buildTemplateContext({ playerId: idJogador })
        );
        const mention = mentionFor(idJogador);

        await sendReply({
            sock,
            idChat,
            m,
            imagePath: findImagePath('historia'),
            text,
            mentions: text.includes(mention) ? [idJogador] : [],
        });
    },
};
