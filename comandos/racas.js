const { COMMAND_PREFIX } = require('../config/bot');
const { renderRacesText, sendSystemText } = require('../helpers/clover/systemMessages');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const {
    renderPreResetRacesAvailability,
    stripLegacySlotCounters,
} = require('../helpers/clover/preResetCatalogMessages');

function cleanLegacyRaceDetailsForPreReset(text) {
    return stripLegacySlotCounters(String(text || ''))
        .replace(/\b\d+\/\d+\./g, 'Consulte o quadro PRE_RESET acima.');
}

module.exports = {
    nome: `${COMMAND_PREFIX}racas`,
    aliases: [`${COMMAND_PREFIX}raças`],
    descricao: 'Lista as racas disponiveis.',
    executar: async ({ sock, m, idChat, db }) => {
        if (isPreResetTransitionEnabled(process.env)) {
            const [availability, rendered] = await Promise.all([
                renderPreResetRacesAvailability(db),
                renderRacesText(db),
            ]);
            await sendSystemText({
                sock,
                idChat,
                m,
                text:[
                    availability,
                    '',
                    '────────  DETALHES DAS RAÇAS  ────────',
                    '',
                    cleanLegacyRaceDetailsForPreReset(rendered),
                ].join('\n'),
            });
            return;
        }

        await sendSystemText({ sock, idChat, m, text:await renderRacesText(db) });
    },
};
