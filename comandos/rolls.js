const { getResetDeferredState } = require('../helpers/clover/resetDeferredStateService');
const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX } = require('../config/bot');
const { isMagicFlowCriticalStep, renderMagicFlowLockedMessage } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { listPlayerRolls, renderRollList } = require('../helpers/rollManager');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const { getAssignedPreResetState, isPreResetBuildState } = require('../helpers/clover/preResetRosterStateService');
const { listFutureRolls } = require('../helpers/clover/preResetFutureRollService');
const { getFutureCharacter } = require('../helpers/clover/preResetCharacterService');

module.exports = {
    nome: `${COMMAND_PREFIX}rolls`,
    aliases: [`${COMMAND_PREFIX}sorteios`],
    descricao: 'Mostra todos os seus rolls salvos em bloco.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        if ((isPreResetTransitionEnabled(process.env) || await getResetDeferredState(db,idJogador))) {
            const state = await getAssignedPreResetState(db, idJogador);
            if (!isPreResetBuildState(state)) {
                await sendReply({
                    sock, idChat, m,
                    text: state.kind === 'keep'
                        ? 'Seu personagem está em MANTER. Não há novos rolls de RESET para revisar.'
                        : 'Seu PRE_RESET de criação ainda não está disponível.',
                });
                return;
            }
            const [rolls, future] = await Promise.all([
                listFutureRolls(db, idJogador),
                getFutureCharacter(db, idJogador),
            ]);
            await sendReply({
                sock, idChat, m,
                text: [
                    renderRollList(rolls, future?.draft?.rollNumber || null),
                    '',
                    '*PRE_RESET:* estes são os sorteios da nova fase. O personagem antigo não foi alterado.',
                ].join('\n'),
            });
            return;
        }

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
