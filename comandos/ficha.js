const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX } = require('../config/bot');
const {
    PROFILE_TEMPLATE_COMMAND,
    getPendingConfirmation,
    renderConfirmedFicha,
    renderConfirmationSummary,
    renderProfileTemplate,
} = require('../helpers/profileForms');
const { ensurePlayerRecord, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollByNumber } = require('../helpers/rollManager');

module.exports = {
    nome: PROFILE_TEMPLATE_COMMAND,
    descricao: 'Envia o modelo da ficha e orienta o proximo passo do cadastro.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const pending = await getPendingConfirmation(db, idJogador);

        if (pending) {
            await updateOnboardingStep(db, idJogador, 'ficha_pendente_confirmacao', {
                last_message: 'ficha_pendente_confirmacao',
                roll_number: pending.numeroRoll,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderConfirmationSummary(pending),
            });
            return;
        }

        if (player.ficha_status === 'confirmada' || player.ficha_status === 'aprovada') {
            const roll = player.numero_roll_escolhido
                ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
                : null;
            await sendReply({
                sock,
                idChat,
                m,
                text: renderConfirmedFicha(player, roll),
            });
            return;
        }

        await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', {
            last_message: 'ficha_modelo',
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                renderProfileTemplate(),
                '',
                `Quando terminar, envie a ficha preenchida respondendo este modelo.`,
            ].join('\n'),
        });
    },
};
