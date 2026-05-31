const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX } = require('../config/bot');
const { isMagicFlowCriticalStep, renderMagicFlowLockedMessage } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const {
    createAndStoreRoll,
    renderRollLimitMessage,
    renderSavedRollMessage,
} = require('../helpers/rollManager');

module.exports = {
    nome: `${COMMAND_PREFIX}sortear`,
    descricao: 'Gera um roll completo, salva com numero e respeita seu limite.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        await ensurePlayerRecord(db, idJogador, nomeUsuario);
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

        const result = await createAndStoreRoll(db, idJogador);
        if (!result.ok) {
            await updateOnboardingStep(db, idJogador, 'limite_rolls', {
                last_message: 'roll_limit',
                count: result.count,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderRollLimitMessage(result.count),
            });
            return;
        }

        await updateOnboardingStep(db, idJogador, 'roll_gerado', {
            last_message: 'roll_saved',
            roll_number: result.roll.rollNumber,
            count: result.count,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: renderSavedRollMessage(result),
        });
    },
};
