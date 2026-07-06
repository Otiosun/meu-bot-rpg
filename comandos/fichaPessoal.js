const { sendReply } = require('../helpers/chatReply');
const {
    markProfileAppearancePending,
    saveAppearanceImageFromMessage,
} = require('../helpers/clover/appearanceManager');
const {
    PROFILE_SUBMISSION_ALIASES,
    PROFILE_SUBMISSION_COMMAND,
    PROFILE_TEMPLATE_COMMAND,
    analyzeProfileSubmission,
    renderConfirmationSummary,
    renderHeartElementalWarning,
    renderValidationErrors,
    savePendingConfirmation,
} = require('../helpers/profileForms');
const { ensurePlayerRecord, updateOnboardingStep } = require('../helpers/playerRegistry');

module.exports = {
    nome: PROFILE_SUBMISSION_COMMAND,
    aliases: PROFILE_SUBMISSION_ALIASES,
    descricao: 'Recebe a ficha preenchida e valida antes da confirmacao.',
    oculto: true,
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body, downloadMediaMessage, P }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);

        if (!body || !body.trim()) {
            await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', {
                last_message: 'ficha_modelo_reenviado',
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: `Use *${PROFILE_TEMPLATE_COMMAND}* para receber o modelo da ficha.`,
            });
            return;
        }

        const analysis = await analyzeProfileSubmission(db, idJogador, body);
        if (!analysis.ok) {
            await updateOnboardingStep(db, idJogador, 'corrigir_ficha', {
                last_message: 'ficha_com_erro',
                errors: analysis.errors,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    renderValidationErrors(analysis.errors),
                    '',
                    'Depois de corrigir, envie de novo ou use *.#continuar*.',
                ].join('\n'),
            });
            return;
        }

        const imageInfo = await saveAppearanceImageFromMessage({
            sock,
            message: m,
            playerId: idJogador,
            downloadMediaMessage,
            loggerFactory: P,
        });

        await savePendingConfirmation(db, idJogador, analysis.payload);
        await markProfileAppearancePending(db, idJogador, analysis.payload, imageInfo);
        await updateOnboardingStep(db, idJogador, 'ficha_pendente_confirmacao', {
            last_message: 'ficha_validada',
            roll_number: analysis.payload.numeroRoll,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                renderConfirmationSummary(analysis.payload, player),
                '',
                'Proximo passo curto: *.#continuar*.',
            ].join('\n'),
        });

        const heartWarning = renderHeartElementalWarning(analysis.payload, player);
        if (heartWarning) {
            await sendReply({
                sock,
                idChat,
                m,
                text: heartWarning,
            });
        }
    },
};
