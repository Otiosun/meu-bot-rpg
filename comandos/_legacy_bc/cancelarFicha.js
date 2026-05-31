const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { clearPendingConfirmation, getPendingConfirmation } = require('../helpers/profileForms');
const { updateOnboardingStep } = require('../helpers/playerRegistry');

module.exports = {
    nome: `${COMMAND_PREFIX}cancelar`,
    aliases: [`${COMMAND_PREFIX}cancelar ficha`, `${COMMAND_PREFIX}cancelarficha`],
    descricao: 'Cancela a ficha pendente para você reenviar do zero.',
    oculto: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const pending = await getPendingConfirmation(db, idJogador);
        if (!pending) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `⚠️ Não existe ficha pendente para cancelar. Se quiser, use *${COMMAND_PREFIX}Ficha* para receber o modelo novamente.`,
            });
            return;
        }

        await clearPendingConfirmation(db, idJogador);
        await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', {
            last_message: 'ficha_cancelada',
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '🧹 A ficha pendente foi cancelada.',
                '',
                `Agora use *${COMMAND_PREFIX}Ficha* para receber o modelo e reenviar sua ficha.`,
            ].join('\n'),
        });
    },
};
