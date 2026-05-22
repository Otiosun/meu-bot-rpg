const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { findMagicOption, getAvailableMagicsForRoll, isMagicAvailable, renderMagicChoicePrompt } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollByNumber } = require('../helpers/rollManager');

module.exports = {
    nome: `${COMMAND_PREFIX}magia`,
    aliases: [`${COMMAND_PREFIX}escolher magia`, `${COMMAND_PREFIX}escolhermagia`],
    descricao: 'Escolhe a magia final do personagem apos a ficha ser aprovada.',
    oculto: true,
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);

        if (onboarding.current_step !== 'escolha_magia') {
            await sendReply({
                sock,
                idChat,
                m,
                text: `⚠️ Você ainda não está na etapa de escolha de magia. Use *${COMMAND_PREFIX}continuar* para retomar seu cadastro.`,
            });
            return;
        }

        const roll = player.numero_roll_escolhido
            ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
            : null;

        if (!roll) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `⚠️ Não encontrei o roll vinculado à sua ficha. Use *${COMMAND_PREFIX}continuar* para retomar.`,
            });
            return;
        }

        const options = getAvailableMagicsForRoll(roll);
        const choice = body ? findMagicOption(options, body.trim()) : null;

        if (!choice) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicChoicePrompt(roll, options),
            });
            return;
        }

        const available = await isMagicAvailable(db, choice.label);
        if (!available) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '⚠️ Essa magia já está em uso por outro jogador.',
                    '',
                    renderMagicChoicePrompt(roll, options),
                ].join('\n'),
            });
            return;
        }

        await db.run('UPDATE jogadores SET magia = ?, ficha_status = ? WHERE id = ?', [
            choice.label,
            'aprovada',
            idJogador,
        ]);

        await updateOnboardingStep(db, idJogador, 'cadastro_aprovado', {
            last_message: 'magia_escolhida',
            magia: choice.label,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '🪄 *Magia escolhida com sucesso!*',
                '',
                `Sua magia final é *${choice.label}*.`,
                '',
                `Seu cadastro está concluído. Use *${COMMAND_PREFIX}ficha* ou *${COMMAND_PREFIX}perfil* quando quiser rever seus dados.`,
            ].join('\n'),
        });
    },
};
