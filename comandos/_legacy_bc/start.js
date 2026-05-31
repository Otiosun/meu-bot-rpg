const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { findImagePath, renderStartMessage } = require('../helpers/onboardingFlow');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollCount } = require('../helpers/rollManager');

module.exports = {
    nome: `${COMMAND_PREFIX}start`,
    aliases: [`${COMMAND_PREFIX}iniciar`, `${COMMAND_PREFIX}comecar`, `${COMMAND_PREFIX}começar`, `${COMMAND_PREFIX}comeco`, `${COMMAND_PREFIX}começo`],
    descricao: 'Mostra o fluxo principal para comecar no bot.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const rollCount = await getPlayerRollCount(db, idJogador);

        await updateOnboardingStep(
            db,
            idJogador,
            rollCount > 0 ? onboarding.current_step || 'roll_gerado' : onboarding.current_step || 'recepcao',
            { last_message: 'start', roll_count: rollCount }
        );

        await sendReply({
            sock,
            idChat,
            mentions: [idJogador],
            imagePath: findImagePath('start'),
            text: renderStartMessage(idJogador, rollCount),
        });
    },
};
