const { COMMAND_PREFIX } = require('../config/bot');
const { renderGrimoiresText, sendSystemText } = require('../helpers/clover/systemMessages');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const {
    renderPreResetGrimoiresAvailability,
    stripLegacySlotCounters,
} = require('../helpers/clover/preResetCatalogMessages');

function cleanLegacyGrimoireDetailsForPreReset(text) {
    return stripLegacySlotCounters(String(text || ''))
        .replace(
            '*ⓘ As vagas abaixo vêm do banco em tempo real e incluem reservas ativas dos rolls.*',
            '*ⓘ As vagas reais do PRE_RESET estão no quadro acima. Os detalhes abaixo explicam os grimórios.*'
        );
}

module.exports = {
    nome: `${COMMAND_PREFIX}grimorios`,
    aliases: [`${COMMAND_PREFIX}grimórios`],
    descricao: 'Lista os grimorios disponiveis.',
    executar: async ({ sock, m, idChat, db }) => {
        if (isPreResetTransitionEnabled(process.env)) {
            const [availability, rendered] = await Promise.all([
                renderPreResetGrimoiresAvailability(db),
                renderGrimoiresText(db),
            ]);
            await sendSystemText({
                sock,
                idChat,
                m,
                text:[
                    availability,
                    '',
                    '────────  DETALHES DOS GRIMÓRIOS  ────────',
                    '',
                    cleanLegacyGrimoireDetailsForPreReset(rendered),
                ].join('\n'),
            });
            return;
        }

        await sendSystemText({ sock, idChat, m, text:await renderGrimoiresText(db) });
    },
};
