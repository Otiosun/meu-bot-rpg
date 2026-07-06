const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { clearPendingMagicConfirmation } = require('../helpers/magicManager');
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

        await clearPendingMagicConfirmation(db, idJogador);
        await clearPendingConfirmation(db, idJogador);
        await db.run(
            `UPDATE jogadores
             SET personagem_aparencia = '-',
                 personagem_aparencia_normalizada = NULL,
                 personagem_aparencia_status = 'pending',
                 personagem_aparencia_motivo = NULL,
                 personagem_aparencia_image_path = NULL,
                 personagem_aparencia_image_message_id = NULL,
                 personagem_aparencia_approved_by = NULL,
                 personagem_aparencia_approved_at = NULL,
                 personagem_aparencia_updated_at = NULL
             WHERE id = ?`,
            [idJogador]
        );
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
                `Se quiser orientação curta, use *${COMMAND_PREFIX}continuar*.`,
            ].join('\n'),
        });
    },
};
