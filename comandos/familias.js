const { COMMAND_PREFIX } = require('../config/bot');
const { renderFamiliesText, sendSystemText } = require('../helpers/clover/systemMessages');
const { getPlayerRollByNumber } = require('../helpers/rollManager');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const { getFutureCharacter } = require('../helpers/clover/preResetCharacterService');
const { getFutureRollByNumber } = require('../helpers/clover/preResetFutureRollService');

function sanitizeLegacySlotCountsForPreReset(text) {
    return String(text || '')
        .replace(/\[\d+\/\d+(?: · esgotado)?\]/g, '[vaga futura verificada na Ficha Nova]')
        .replace(
            'As vagas abaixo vêm do banco em tempo real. Fichas confirmadas e reservas ativas já seguram vaga.',
            'No PRE_RESET, a compatibilidade abaixo usa seu roll futuro. Vagas limitadas são verificadas no universo futuro ao enviar a Ficha Nova.'
        )
        .replace(
            'A contagem inclui fichas confirmadas e qualquer reserva ativa da mesma família.',
            'A vaga futura não é ocupada por esta consulta; ela é validada no envio da Ficha Nova.'
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
            const future = await getFutureCharacter(db, idJogador);
            const rollNumber = Number(future?.draft?.rollNumber || 0) || null;
            selectedRoll = rollNumber
                ? await getFutureRollByNumber(db, idJogador, rollNumber)
                : null;
        } else {
            const player = idJogador
                ? await db.get('SELECT numero_roll_escolhido FROM jogadores WHERE id = ?', [idJogador])
                : null;
            selectedRoll = player?.numero_roll_escolhido
                ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
                : null;
        }

        const rendered = await renderFamiliesText(db, selectedRoll);
        await sendSystemText({
            sock,
            idChat,
            m,
            text: preReset ? sanitizeLegacySlotCountsForPreReset(rendered) : rendered,
        });
    },
};
