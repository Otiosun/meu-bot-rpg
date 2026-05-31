const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { confirmPendingProfile } = require('../helpers/profileForms');
const { renderMagicChoicePrompt } = require('../helpers/magicManager');
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

        const magicAlreadyChosen = result.player?.magia && result.player.magia !== '-';
        if (magicAlreadyChosen) {
            await updateOnboardingStep(db, idJogador, 'cadastro_aprovado', {
                last_message: 'ficha_confirmada_magia_ja_escolhida',
                roll_number: result.payload.numeroRoll,
                magia: result.player.magia,
            });

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Ficha confirmada com sucesso.*',
                    '',
                    `Sua magia ja estava escolhida: *${result.player.magia}*.`,
                    `Roll vinculado: *#${String(result.payload.numeroRoll).padStart(2, '0')}*.`,
                    '',
                    'Seu cadastro esta concluido.',
                ].join('\n'),
            });
            return;
        }

        await updateOnboardingStep(db, idJogador, 'escolha_magia', {
            last_message: 'pedir_magia',
            roll_number: result.payload.numeroRoll,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: await renderMagicChoicePrompt(db, result.payload.roll),
        });
    },
};
