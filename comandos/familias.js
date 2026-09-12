const { COMMAND_PREFIX } = require('../config/bot');
const { renderFamiliesText, sendSystemText } = require('../helpers/clover/systemMessages');
const { getPlayerRollByNumber } = require('../helpers/rollManager');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const { getFutureCharacter } = require('../helpers/clover/preResetCharacterService');
const { getFutureRollByNumber, listFutureRolls } = require('../helpers/clover/preResetFutureRollService');
const {
    renderPreResetFamiliesAvailability,
    stripLegacySlotCounters,
} = require('../helpers/clover/preResetCatalogMessages');

function cleanLegacyFamilyDetailsForPreReset(text) {
    return stripLegacySlotCounters(String(text || ''))
        .replace(
            'As vagas abaixo vêm do banco em tempo real. Fichas confirmadas e reservas ativas já seguram vaga.',
            'As vagas do PRE_RESET estão no quadro acima. Os detalhes abaixo explicam famílias, requisitos e benefícios.'
        )
        .replace(
            'A contagem inclui fichas confirmadas e qualquer reserva ativa da mesma família.',
            'Para disponibilidade, use sempre o quadro PRE_RESET acima; ele usa o universo futuro.'
        );
}

module.exports = {
    nome: `${COMMAND_PREFIX}familias`,
    aliases: [`${COMMAND_PREFIX}famílias`],
    descricao: 'Lista familias e vagas.',
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        let selectedRoll = null;
        const preReset = isPreResetTransitionEnabled(process.env);

        if (preReset && idJogador) {
            const [future, rolls] = await Promise.all([
                getFutureCharacter(db, idJogador),
                listFutureRolls(db, idJogador),
            ]);
            const rollNumber = Number(future?.draft?.rollNumber || 0) || null;
            selectedRoll = rollNumber
                ? await getFutureRollByNumber(db, idJogador, rollNumber)
                : null;

            const [availability, rendered] = await Promise.all([
                renderPreResetFamiliesAvailability(db, rolls),
                renderFamiliesText(db, selectedRoll),
            ]);

            await sendSystemText({
                sock,
                idChat,
                m,
                text:[
                    availability,
                    '',
                    '────────  DETALHES DAS FAMÍLIAS  ────────',
                    '',
                    cleanLegacyFamilyDetailsForPreReset(rendered),
                ].join('\n'),
            });
            return;
        }

        const player = idJogador
            ? await db.get('SELECT numero_roll_escolhido FROM jogadores WHERE id = ?', [idJogador])
            : null;
        selectedRoll = player?.numero_roll_escolhido
            ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
            : null;

        await sendSystemText({
            sock,
            idChat,
            m,
            text:await renderFamiliesText(db, selectedRoll),
        });
    },
};
