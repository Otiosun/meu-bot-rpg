const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    clearPendingMagicConfirmation,
    getPendingMagicConfirmation,
    renderMagicCancelledMessage,
    renderMagicLockedByProfileMessage,
    renderMagicNothingToCancelMessage,
    setSelectedRollForMagic,
} = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');

module.exports = {
    nome: `${COMMAND_PREFIX}cancelarmagia`,
    aliases: [`${COMMAND_PREFIX}cancelar magia`],
    descricao: 'Cancela uma escolha ou confirmacao de magia pendente.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const pending = await getPendingMagicConfirmation(db, idJogador);

        if (pending) {
            const previousRollNumber = onboarding.step_payload?.previous_roll_number || null;
            await clearPendingMagicConfirmation(db, idJogador);
            await setSelectedRollForMagic(db, idJogador, previousRollNumber);
            await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                last_message: 'magia_cancelada',
            });

            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicCancelledMessage(),
            });
            return;
        }

        if (player.magia && player.magia !== '-') {
            if (['confirmada', 'aprovada'].includes(player.ficha_status)) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderMagicLockedByProfileMessage(),
                });
                return;
            }

            await db.run(
                `UPDATE jogadores
                 SET magia = '-',
                     numero_roll_escolhido = NULL
                 WHERE id = ?`,
                [idJogador]
            );
            await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                last_message: 'magia_cancelada',
            });

            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicCancelledMessage(),
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicNothingToCancelMessage(),
        });
    },
};
