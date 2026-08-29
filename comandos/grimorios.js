const { COMMAND_PREFIX } = require('../config/bot');
const { renderGrimoiresText, sendSystemText } = require('../helpers/clover/systemMessages');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');

function sanitizeLegacySlotCountsForPreReset(text) {
    return String(text || '')
        .replace(/\[\d+\/\d+(?: · esgotado)?\]/g, '[definido pelo roll futuro]')
        .replace(
            '*ⓘ As vagas abaixo vêm do banco em tempo real e incluem reservas ativas dos rolls.*',
            '*ⓘ No PRE_RESET, seu grimório já vem do roll futuro. Esta consulta não altera nem reserva nada.*'
        );
}

module.exports = {
    nome: `${COMMAND_PREFIX}grimorios`,
    aliases: [`${COMMAND_PREFIX}grimórios`],
    descricao: 'Lista os grimorios disponiveis.',
    executar: async ({ sock, m, idChat, db }) => {
        const rendered = await renderGrimoiresText(db);
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
