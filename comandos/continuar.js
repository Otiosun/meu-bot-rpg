const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPendingConfirmation, renderConfirmationSummary, renderProfileTemplate, renderValidationErrors } = require('../helpers/profileForms');
const { getAvailableMagicsForRoll, renderMagicChoicePrompt } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState } = require('../helpers/playerRegistry');
const { getPlayerRollCount, getPlayerRollByNumber } = require('../helpers/rollManager');

function renderWelcomeResume(rollCount) {
    return [
        '👣 *Vamos retomar seu cadastro.*',
        '',
        `No momento você tem *${rollCount}/${MAX_PLAYER_ROLLS}* roll(s) salvo(s).`,
        '',
        `Use *${COMMAND_PREFIX}sortear* para gerar um roll.`,
        `Use *${COMMAND_PREFIX}rolls* para revisar todos.`,
        `Use *${COMMAND_PREFIX}Ficha* para receber o modelo da ficha.`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}continuar`,
    descricao: 'Retoma exatamente da etapa onde o seu cadastro parou.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const rollCount = await getPlayerRollCount(db, idJogador);
        const pending = await getPendingConfirmation(db, idJogador);

        if (!rollCount) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderWelcomeResume(rollCount),
            });
            return;
        }

        if (pending || onboarding.current_step === 'ficha_pendente_confirmacao') {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderConfirmationSummary(pending),
            });
            return;
        }

        if (onboarding.current_step === 'corrigir_ficha') {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    renderValidationErrors(onboarding.step_payload.errors || ['Sua ficha ainda precisa de ajustes.']),
                    '',
                    renderProfileTemplate(),
                ].join('\n'),
            });
            return;
        }

        if (onboarding.current_step === 'aguardando_ficha_envio') {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '🧾 *Vamos retomar pela ficha.*',
                    '',
                    renderProfileTemplate(),
                ].join('\n'),
            });
            return;
        }

        if (onboarding.current_step === 'escolha_magia') {
            const roll = player.numero_roll_escolhido
                ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
                : null;
            if (roll) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderMagicChoicePrompt(roll, getAvailableMagicsForRoll(roll)),
                });
                return;
            }
        }

        if (player.ficha_status === 'confirmada' && (!player.magia || player.magia === '-')) {
            const roll = player.numero_roll_escolhido
                ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
                : null;
            if (roll) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderMagicChoicePrompt(roll, getAvailableMagicsForRoll(roll)),
                });
                return;
            }
        }

        if (onboarding.current_step === 'cadastro_aprovado' || player.ficha_status === 'aprovada') {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '✅ *Seu cadastro já foi concluído.*',
                    '',
                    `Use *${COMMAND_PREFIX}ficha* para rever os dados.`,
                    `Use *${COMMAND_PREFIX}perfil* para ver o resumo visual.`,
                ].join('\n'),
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '📌 *Seu próximo passo agora é enviar a ficha.*',
                '',
                `Você já tem *${rollCount}/${MAX_PLAYER_ROLLS}* roll(s) salvo(s).`,
                `Use *${COMMAND_PREFIX}Ficha* para receber novamente o modelo.`,
            ].join('\n'),
        });
    },
};
