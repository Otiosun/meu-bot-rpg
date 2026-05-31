const { sendReply } = require('../helpers/chatReply');
const {
    PROFILE_SUBMISSION_ALIASES,
    PROFILE_SUBMISSION_COMMAND,
    PROFILE_TEMPLATE_COMMAND,
    analyzeProfileSubmission,
    renderConfirmationSummary,
    renderValidationErrors,
    savePendingConfirmation,
} = require('../helpers/profileForms');
const { ensurePlayerRecord, updateOnboardingStep } = require('../helpers/playerRegistry');

module.exports = {
    nome: PROFILE_SUBMISSION_COMMAND,
    aliases: PROFILE_SUBMISSION_ALIASES,
    descricao: 'Recebe a ficha preenchida e valida antes da confirmacao.',
    oculto: true,
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body }) => {
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
                text: renderValidationErrors(analysis.errors),
            });
            return;
        }

        await savePendingConfirmation(db, idJogador, analysis.payload);
        await updateOnboardingStep(db, idJogador, 'ficha_pendente_confirmacao', {
            last_message: 'ficha_validada',
            roll_number: analysis.payload.numeroRoll,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: renderConfirmationSummary(analysis.payload, player),
        });
    },
};
