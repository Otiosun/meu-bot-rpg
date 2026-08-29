const { COMMAND_PREFIX } = require('../config/bot');
const { renderRacesText, sendSystemText } = require('../helpers/clover/systemMessages');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');

function sanitizeLegacySlotCountsForPreReset(text) {
    return String(text || '')
        .replace(/\[\d+\/\d+(?: · esgotado)?\]/g, '[definida pelo roll futuro]')
        .replace(/\b\d+\/\d+\./g, 'vagas definidas pelo roll futuro.');
}

module.exports = {
    nome: `${COMMAND_PREFIX}racas`,
    aliases: [`${COMMAND_PREFIX}raças`],
    descricao: 'Lista as racas disponiveis.',
    executar: async ({ sock, m, idChat, db }) => {
        const rendered = await renderRacesText(db);
        await sendSystemText({
            sock,
            idChat,
            m,
            text: isPreResetTransitionEnabled(process.env)
                ? sanitizeLegacySlotCountsForPreReset(rendered)
                : rendered,
        });
    },
};
