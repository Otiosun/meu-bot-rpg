const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX } = require('../config/bot');
const {
    PROFILE_TEMPLATE_COMMAND,
    buildProfileTemplatePrefill,
    getPendingConfirmation,
    renderConfirmedFicha,
    renderConfirmationSummary,
    renderProfileTemplate,
} = require('../helpers/profileForms');
const { getPendingMagicConfirmation, isMagicFlowCriticalStep, renderMagicFlowLockedMessage } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollByNumber, listPlayerRolls } = require('../helpers/rollManager');

function parseRollNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function renderFichaNextHint() {
    return [
        '',
        `↳ Depois, veja *${COMMAND_PREFIX}magias*, *${COMMAND_PREFIX}familias* e *${COMMAND_PREFIX}tracos*.`,
        `↳ Se travar, use *${COMMAND_PREFIX}continuar*.`,
    ].join('\n');
}

module.exports = {
    nome: PROFILE_TEMPLATE_COMMAND,
    descricao: 'Envia o modelo da ficha e orienta o proximo passo do cadastro.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);

        if (isMagicFlowCriticalStep(onboarding.current_step)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicFlowLockedMessage(),
            });
            return;
        }

        const pending = await getPendingConfirmation(db, idJogador);
        const pendingMagic = await getPendingMagicConfirmation(db, idJogador);
        const rolls = await listPlayerRolls(db, idJogador);
        const requestedRollNumber = parseRollNumber(body);

        // Ficha confirmada/aprovada e imutavel pelo fluxo de recepcao. Esse guard
        // precisa vir antes de qualquer #ficha <n>, pois numero_roll_escolhido
        // tambem e evidencia usada para reconstruir o personagem de transicao.
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

        if (requestedRollNumber) {
            const roll = await getPlayerRollByNumber(db, idJogador, requestedRollNumber);
            if (!roll) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        `Nao encontrei o roll *#${requestedRollNumber}* nos seus sorteios salvos.`,
                        `Use *${COMMAND_PREFIX}rolls* para rever e depois *${COMMAND_PREFIX}ficha <numero do roll>*.`,
                    ].join('\n'),
                });
                return;
            }

            await db.run('UPDATE jogadores SET numero_roll_escolhido = ? WHERE id = ?', [requestedRollNumber, idJogador]);
            await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', {
                last_message: 'ficha_modelo',
                roll_number: requestedRollNumber,
            });

            const note = pendingMagic
                ? `\n\n↳ Magia pendente: *${pendingMagic.magic_label}*.`
                : '';

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    renderProfileTemplate(buildProfileTemplatePrefill({
                        player,
                        pending,
                        rollNumber: requestedRollNumber,
                        magicLabel: pendingMagic?.magic_label,
                        roll,
                    })),
                    note,
                    renderFichaNextHint(),
                ].join(''),
            });
            return;
        }

        if (pending) {
            await updateOnboardingStep(db, idJogador, 'ficha_pendente_confirmacao', {
                last_message: 'ficha_pendente_confirmacao',
                roll_number: pending.numeroRoll,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderConfirmationSummary(pending, player),
            });
            return;
        }

        if (!rolls.length) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    `Voce ainda nao tem roll salvo. Use *${COMMAND_PREFIX}sortear* primeiro.`,
                    `Depois volte com *${COMMAND_PREFIX}ficha <numero do roll>*.`,
                ].join('\n'),
            });
            return;
        }

        if (rolls.length > 1) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    `Voce tem mais de um roll salvo. Use *${COMMAND_PREFIX}ficha <numero do roll>*.`,
                    `Exemplo: *${COMMAND_PREFIX}ficha 1*.`,
                    `Para rever, use *${COMMAND_PREFIX}rolls*.`,
                ].join('\n'),
            });
            return;
        }

        const automaticRollNumber = rolls[0].roll_number;
        await db.run('UPDATE jogadores SET numero_roll_escolhido = ? WHERE id = ?', [automaticRollNumber, idJogador]);

        await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', {
            last_message: 'ficha_modelo',
            roll_number: automaticRollNumber,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                renderProfileTemplate(buildProfileTemplatePrefill({
                    player,
                    pending,
                    rollNumber: automaticRollNumber,
                    magicLabel: pendingMagic?.magic_label,
                    roll: rolls[0],
                })),
                renderFichaNextHint(),
            ].join(''),
        });
    },
};
