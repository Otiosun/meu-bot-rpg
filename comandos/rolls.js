const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX } = require('../config/bot');
const { isMagicFlowCriticalStep, renderMagicFlowLockedMessage } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { listPlayerRolls, renderRollList } = require('../helpers/rollManager');

module.exports = {
    nome: `${COMMAND_PREFIX}rolls`,
    aliases: [`${COMMAND_PREFIX}sorteios`],
    descricao: 'Mostra todos os seus rolls salvos em bloco.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const rolls = await listPlayerRolls(db, idJogador);

        if (!isMagicFlowCriticalStep(onboarding.current_step)) {
            await updateOnboardingStep(db, idJogador, rolls.length > 0 ? 'rolls_revisados' : 'inicio', {
                last_message: 'roll_list',
                count: rolls.length,
            });
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                renderRollList(rolls, player.numero_roll_escolhido),
                isMagicFlowCriticalStep(onboarding.current_step) ? renderMagicFlowLockedMessage() : '',
            ].filter(Boolean).join('\n\n'),
        });
    },
};
