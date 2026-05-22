const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { confirmPendingProfile } = require('../helpers/profileForms');
const { getAvailableMagicsForRoll, renderMagicChoicePrompt } = require('../helpers/magicManager');
const { updateOnboardingStep } = require('../helpers/playerRegistry');

module.exports = {
    nome: `${COMMAND_PREFIX}confirmar`,
    aliases: [
        `${COMMAND_PREFIX}confirmar ficha`,
        `${COMMAND_PREFIX}confirmarficha`,
    ],
    descricao: 'Confirma a ficha validada e avanca para a escolha de magia.',
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const result = await confirmPendingProfile(db, idJogador);
        if (!result.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `⚠️ Você não tem nenhuma ficha pendente para confirmar. Use *${COMMAND_PREFIX}Ficha* primeiro.`,
            });
            return;
        }

        const magicOptions = getAvailableMagicsForRoll(result.payload.roll);
        await updateOnboardingStep(db, idJogador, 'escolha_magia', {
            last_message: 'pedir_magia',
            roll_number: result.payload.numeroRoll,
            magic_options: magicOptions.map((option) => option.label),
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '✅ *Ficha aprovada!*',
                '',
                `Agora vamos para a sua escolha de magia.`,
                '',
                renderMagicChoicePrompt(result.payload.roll, magicOptions),
            ].join('\n'),
        });
    },
};
