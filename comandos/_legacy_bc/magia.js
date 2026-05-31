const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    clearPendingMagicConfirmation,
    confirmPendingMagicChoice,
    findMagicOption,
    getAvailableMagicsForRoll,
    getBestRollForMagicPrompt,
    getMagicAvailability,
    getPendingMagicConfirmation,
    getRollsMatchingMagic,
    renderMagicCancelledMessage,
    renderMagicChoicePrompt,
    renderMagicChosenMessage,
    renderMagicConfirmationMessage,
    renderMagicNeedsRollMessage,
    renderMagicRollChoiceMessage,
    renderMagicUnavailableMessage,
    savePendingMagicConfirmation,
    setSelectedRollForMagic,
} = require('../helpers/magicManager');
const { normalizeText } = require('../helpers/textUtils');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollByNumber, listPlayerRolls } = require('../helpers/rollManager');

function parseRollNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function isCancelText(value) {
    return ['cancelar', 'cancela', 'nao', 'não'].includes(normalizeText(value));
}

async function restorePreviousRollSelection(db, playerId, onboarding) {
    const previousRollNumber = onboarding.step_payload?.previous_roll_number || null;
    await setSelectedRollForMagic(db, playerId, previousRollNumber);
}

async function startMagicConfirmation({ sock, m, idChat, idJogador, db, player, roll, choice }) {
    const availability = await getMagicAvailability(db, choice.label, idJogador);
    if (!availability) {
        return false;
    }

    if (!availability.available) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicUnavailableMessage(),
        });
        return true;
    }

    await setSelectedRollForMagic(db, idJogador, roll.roll_number);
    await savePendingMagicConfirmation(db, idJogador, choice.label, roll.roll_number);
    await updateOnboardingStep(db, idJogador, 'confirmar_magia', {
        last_message: 'magia_pendente_confirmacao',
        magia: choice.label,
        roll_number: roll.roll_number,
        previous_roll_number: player.numero_roll_escolhido || null,
    });

    await sendReply({
        sock,
        idChat,
        m,
        text: renderMagicConfirmationMessage(availability, roll),
    });
    return true;
}

async function handlePendingRollChoice({ sock, m, idChat, idJogador, db, player, onboarding, rolls, body }) {
    const payload = onboarding.step_payload || {};
    const candidateRolls = rolls.filter((roll) => (payload.candidate_roll_numbers || [])
        .map(Number)
        .includes(Number(roll.roll_number)));
    const matchingRolls = getRollsMatchingMagic(candidateRolls.length ? candidateRolls : rolls, payload.magia);
    const choice = matchingRolls.length
        ? findMagicOption(getAvailableMagicsForRoll(matchingRolls[0]), payload.magia)
        : null;

    if (!choice || !matchingRolls.length) {
        await updateOnboardingStep(db, idJogador, 'escolha_magia', {
            last_message: 'magia_roll_pendente_perdido',
        });
        await sendReply({
            sock,
            idChat,
            m,
            text: await renderMagicChoicePrompt(db, getBestRollForMagicPrompt(rolls, player.numero_roll_escolhido)),
        });
        return true;
    }

    if (!body) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicRollChoiceMessage(choice, matchingRolls),
        });
        return true;
    }

    if (isCancelText(body)) {
        await clearPendingMagicConfirmation(db, idJogador);
        await updateOnboardingStep(db, idJogador, 'escolha_magia', {
            last_message: 'magia_cancelada',
        });
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicCancelledMessage(),
        });
        return true;
    }

    const rollNumber = parseRollNumber(body);
    const roll = matchingRolls.find((item) => Number(item.roll_number) === Number(rollNumber));
    if (!roll) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicRollChoiceMessage(choice, matchingRolls),
        });
        return true;
    }

    return startMagicConfirmation({ sock, m, idChat, idJogador, db, player, roll, choice });
}

module.exports = {
    nome: `${COMMAND_PREFIX}magia`,
    aliases: [`${COMMAND_PREFIX}magias`, `${COMMAND_PREFIX}escolher magia`, `${COMMAND_PREFIX}escolhermagia`],
    descricao: 'Mostra as magias disponiveis e fecha a escolha quando liberado.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const rolls = await listPlayerRolls(db, idJogador);

        if (!rolls.length) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicNeedsRollMessage(),
            });
            return;
        }

        const selectedRoll = player.numero_roll_escolhido
            ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
            : null;
        const lockedSelectedRoll = selectedRoll && ['confirmada', 'aprovada'].includes(player.ficha_status)
            ? selectedRoll
            : null;
        const promptRoll = getBestRollForMagicPrompt(rolls, lockedSelectedRoll?.roll_number);
        const normalizedBody = normalizeText(body);

        if (onboarding.current_step === 'confirmar_magia') {
            if (!normalizedBody) {
                const pending = await getPendingMagicConfirmation(db, idJogador);
                if (pending) {
                    const availability = await getMagicAvailability(db, pending.magic_label, idJogador);
                    const pendingRoll = pending.roll_number
                        ? await getPlayerRollByNumber(db, idJogador, pending.roll_number)
                        : selectedRoll;
                    if (availability) {
                        await sendReply({
                            sock,
                            idChat,
                            m,
                            text: renderMagicConfirmationMessage(availability, pendingRoll),
                        });
                        return;
                    }
                }
            }

            if (['confirmar', 'confirmo', 'sim'].includes(normalizedBody)) {
                const confirmed = await confirmPendingMagicChoice(db, idJogador);
                if (!confirmed.ok) {
                    await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                        last_message: 'magia_confirmacao_expirada',
                    });
                    await sendReply({
                        sock,
                        idChat,
                        m,
                        text: [
                            '*⚠️ Essa reserva nao esta mais disponivel.*',
                            '',
                            await renderMagicChoicePrompt(db, promptRoll),
                        ].join('\n'),
                    });
                    return;
                }

                const confirmedRoll = confirmed.selectedRollNumber
                    ? await getPlayerRollByNumber(db, idJogador, confirmed.selectedRollNumber)
                    : selectedRoll;
                await updateOnboardingStep(db, idJogador, confirmed.profileComplete ? 'cadastro_aprovado' : 'aguardando_ficha_envio', {
                    last_message: 'magia_escolhida',
                    magia: confirmed.availability.option.label,
                    roll_number: confirmed.selectedRollNumber,
                });

                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderMagicChosenMessage(confirmed.availability, {
                        roll: confirmedRoll,
                        profileComplete: confirmed.profileComplete,
                    }),
                });
                return;
            }

            if (isCancelText(body)) {
                await clearPendingMagicConfirmation(db, idJogador);
                await restorePreviousRollSelection(db, idJogador, onboarding);
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

            const pending = await getPendingMagicConfirmation(db, idJogador);
            if (pending) {
                const availability = await getMagicAvailability(db, pending.magic_label, idJogador);
                const pendingRoll = pending.roll_number
                    ? await getPlayerRollByNumber(db, idJogador, pending.roll_number)
                    : selectedRoll;
                if (availability) {
                    await sendReply({
                        sock,
                        idChat,
                        m,
                        text: renderMagicConfirmationMessage(availability, pendingRoll),
                    });
                    return;
                }
            }
        }

        if (onboarding.current_step === 'escolha_roll_magia') {
            const handled = await handlePendingRollChoice({
                sock,
                m,
                idChat,
                idJogador,
                db,
                player,
                onboarding,
                rolls,
                body,
            });
            if (handled) return;
        }

        const options = getAvailableMagicsForRoll(promptRoll);
        const choice = body ? findMagicOption(options, body.trim()) : null;

        if (!choice) {
            await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                last_message: 'lista_magias',
                roll_number: promptRoll.roll_number,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: await renderMagicChoicePrompt(db, promptRoll, options),
            });
            return;
        }

        const matchingRolls = lockedSelectedRoll
            ? getRollsMatchingMagic([lockedSelectedRoll], choice.label)
            : getRollsMatchingMagic(rolls, choice.label);

        if (!matchingRolls.length) {
            await sendReply({
                sock,
                idChat,
                m,
                text: await renderMagicChoicePrompt(db, promptRoll, options),
            });
            return;
        }

        if (!lockedSelectedRoll && matchingRolls.length > 1) {
            await updateOnboardingStep(db, idJogador, 'escolha_roll_magia', {
                last_message: 'escolher_roll_para_magia',
                magia: choice.label,
                candidate_roll_numbers: matchingRolls.map((roll) => roll.roll_number),
                previous_roll_number: player.numero_roll_escolhido || null,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicRollChoiceMessage(choice, matchingRolls),
            });
            return;
        }

        await startMagicConfirmation({
            sock,
            m,
            idChat,
            idJogador,
            db,
            player,
            roll: matchingRolls[0],
            choice,
        });
    },
};
