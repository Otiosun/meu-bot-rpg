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
    nome: `${COMMAND_PREFIX}divulgacao`,
    aliases: [
        `${COMMAND_PREFIX}divulgação`,
        `${COMMAND_PREFIX}divulgar`,
        `${COMMAND_PREFIX}spam`,
    ],
    descricao: 'Mostra o texto configurável de divulgação do RPG.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador }) => {
        const text = renderEditableMessage(
            'divulgacao',
            buildTemplateContext({ playerId: idJogador })
        );
        const mention = mentionFor(idJogador);

        await sendReply({
            sock,
            idChat,
            m,
            imagePath: findImagePath('divulgacao'),
            text,
            mentions: text.includes(mention) ? [idJogador] : [],
        });
    },
};
