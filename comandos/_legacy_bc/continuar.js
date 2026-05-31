const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPendingConfirmation, renderConfirmationSummary, renderProfileTemplate, renderValidationErrors } = require('../helpers/profileForms');
const {
    findMagicOption,
    getAvailableMagicsForRoll,
    getBestRollForMagicPrompt,
    getMagicAvailability,
    getPendingMagicConfirmation,
    getRollsMatchingMagic,
    renderMagicChoicePrompt,
    renderMagicConfirmationMessage,
    renderMagicRollChoiceMessage,
} = require('../helpers/magicManager');
const {
    renderContinueAfterReviewMessage,
    renderContinueAfterRollMessage,
    renderContinueNoRollsMessage,
} = require('../helpers/onboardingFlow');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollCount, getPlayerRollByNumber, listPlayerRolls } = require('../helpers/rollManager');

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
                text: renderContinueNoRollsMessage(),
            });
            return;
        }

        if (onboarding.current_step === 'roll_gerado' || onboarding.current_step === 'limite_rolls') {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderContinueAfterRollMessage(rollCount),
            });
            return;
        }

        if (onboarding.current_step === 'rolls_revisados') {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderContinueAfterReviewMessage(rollCount),
            });
            return;
        }

        if (pending) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderConfirmationSummary(pending, player),
            });
            return;
        }

        if (onboarding.current_step === 'ficha_pendente_confirmacao') {
            await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', {
                last_message: 'ficha_confirmacao_expirada',
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '.',
                    '     ──  𝐅𝐈𝐂𝐇𝐀 𝐄𝐗𝐏𝐈𝐑𝐀𝐃𝐀  ──',
                    '',
                    '*♡  Sua confirmacao de ficha expirou.*',
                    '',
                    '↳ Envie a ficha novamente para eu conferir com calma.',
                    '',
                    renderProfileTemplate(),
                ].join('\n'),
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
                    '*Vamos retomar pela ficha.*',
                    '',
                    renderProfileTemplate(),
                ].join('\n'),
            });
            return;
        }

        if (onboarding.current_step === 'escolha_magia') {
            const rolls = await listPlayerRolls(db, idJogador);
            const lockedSelectedRoll = player.numero_roll_escolhido && ['confirmada', 'aprovada'].includes(player.ficha_status)
                ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
                : null;
            const roll = lockedSelectedRoll || getBestRollForMagicPrompt(rolls, null);
            if (roll) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: await renderMagicChoicePrompt(db, roll),
                });
                return;
            }
        }

        if (onboarding.current_step === 'escolha_roll_magia') {
            const rolls = await listPlayerRolls(db, idJogador);
            const payload = onboarding.step_payload || {};
            const candidateRolls = rolls.filter((roll) => (payload.candidate_roll_numbers || [])
                .map(Number)
                .includes(Number(roll.roll_number)));
            const matchingRolls = getRollsMatchingMagic(candidateRolls.length ? candidateRolls : rolls, payload.magia);
            const choice = matchingRolls.length
                ? findMagicOption(getAvailableMagicsForRoll(matchingRolls[0]), payload.magia)
                : null;

            if (choice && matchingRolls.length) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderMagicRollChoiceMessage(choice, matchingRolls),
                });
                return;
            }
        }

        if (onboarding.current_step === 'confirmar_magia') {
            const pendingMagic = await getPendingMagicConfirmation(db, idJogador);
            if (pendingMagic) {
                const availability = await getMagicAvailability(db, pendingMagic.magic_label, idJogador);
                if (availability) {
                    const roll = pendingMagic.roll_number
                        ? await getPlayerRollByNumber(db, idJogador, pendingMagic.roll_number)
                        : player.numero_roll_escolhido
                        ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
                        : null;
                    await sendReply({
                        sock,
                        idChat,
                        m,
                        text: renderMagicConfirmationMessage(availability, roll),
                    });
                    return;
                }
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
                    text: await renderMagicChoicePrompt(db, roll),
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
                    '*Seu cadastro ja foi concluido.*',
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
                '*Seu proximo passo agora e enviar a ficha.*',
                '',
                `Voce ja tem *${rollCount}/${MAX_PLAYER_ROLLS}* roll(s) salvos.`,
                `Use *${COMMAND_PREFIX}ficha* para receber novamente o modelo.`,
            ].join('\n'),
        });
    },
};
