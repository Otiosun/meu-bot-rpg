const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { isMagicFlowCriticalStep, renderMagicFlowLockedMessage } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const {
    createAndStoreRoll,
    getRareRollImagePath,
    renderRollLimitMessage,
    renderSavedRollMessage,
    rollbackStoredRoll,
} = require('../helpers/rollManager');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const { getAssignedPreResetState, isPreResetBuildState } = require('../helpers/clover/preResetRosterStateService');
const { createAndStoreFutureRoll, rollbackFutureRoll } = require('../helpers/clover/preResetFutureRollService');

async function executePreResetRoll({ sock, m, idChat, idJogador, db }) {
    const state = await getAssignedPreResetState(db, idJogador);
    if (!isPreResetBuildState(state)) {
        await sendReply({
            sock, idChat, m,
            text: state.kind === 'keep'
                ? 'Seu personagem está em MANTER. Você não participa dos novos sorteios do RESET.'
                : 'Seu PRE_RESET de criação ainda não está disponível.',
        });
        return;
    }

    const result = await createAndStoreFutureRoll(db, idJogador);
    if (!result.ok) {
        if (result.reason === 'sacrifice_used') {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃ROLL FINAL ATIVO*',
                    '',
                    '> Você já sacrificou os rolls desta criação.',
                    '> O roll #6 é definitivo; novos sorteios ficam bloqueados.',
                    '',
                    `Use *${COMMAND_PREFIX}rolls* para rever e *${COMMAND_PREFIX}ficha 6* para continuar.`,
                ].join('\n'),
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                renderRollLimitMessage(result.count),
                '',
                `> Seus sorteios da nova fase já estão salvos. Use *${COMMAND_PREFIX}rolls* e depois *${COMMAND_PREFIX}ficha <número>*.`,
            ].join('\n'),
        });
        return;
    }

    try {
        await sendReply({
            sock,
            idChat,
            m,
            imagePath: getRareRollImagePath(result.roll),
            text: [
                renderSavedRollMessage(result),
                '',
                '*PRE_RESET:* este roll pertence à nova fase e não altera seu personagem antigo.',
                result.count >= MAX_PLAYER_ROLLS
                    ? `> Você fechou *${MAX_PLAYER_ROLLS}/${MAX_PLAYER_ROLLS}* rolls. Use *${COMMAND_PREFIX}rolls* e depois *${COMMAND_PREFIX}ficha <número>*.`
                    : `> Você pode usar *${COMMAND_PREFIX}sortear* novamente ou *${COMMAND_PREFIX}rolls* para revisar.`,
            ].join('\n'),
        });
    } catch (error) {
        await rollbackFutureRoll(db, idJogador, result.roll.roll_number).catch(() => {});
        throw error;
    }
}

module.exports = {
    nome: `${COMMAND_PREFIX}sortear`,
    descricao: 'Gera um roll completo, salva com número e respeita seu limite.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        if (isPreResetTransitionEnabled(process.env)) {
            await executePreResetRoll({ sock, m, idChat, idJogador, db });
            return;
        }

        await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);

        if (isMagicFlowCriticalStep(onboarding.current_step)) {
            await sendReply({ sock, idChat, m, text: renderMagicFlowLockedMessage() });
            return;
        }

        const result = await createAndStoreRoll(db, idJogador);
        if (!result.ok) {
            if (result.reason === 'sacrifice_used') {
                await sendReply({
                    sock, idChat, m,
                    text: [
                        '♧┃𝐑𝐎𝐋𝐋 𝐅𝐈𝐍𝐀𝐋 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
                        '     ──  sacrifício já usado  ──', '',
                        '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_', '',
                        '*Você já usou o sacrifício dos 4 rolls.*',
                        '> Esse caminho é definitivo: não dá para sortear de novo.', '',
                        '_`─( ■ )───── 𝗔𝗴𝗼𝗿𝗮`_', '',
                        `*̣${COMMAND_PREFIX}rolls*`, '> Rever seu roll final.',
                        `*̣${COMMAND_PREFIX}ficha 5*`, '> Pegar o modelo.',
                    ].join('\n'),
                });
                return;
            }
            await sendReply({
                sock, idChat, m,
                text: [renderRollLimitMessage(result.count), '', `> Próximo passo: use *${COMMAND_PREFIX}continuar* ou *${COMMAND_PREFIX}ficha <número do roll>*.`].join('\n'),
            });
            await updateOnboardingStep(db, idJogador, 'limite_rolls', { last_message:'roll_limit', count:result.count });
            return;
        }

        try {
            await sendReply({
                sock, idChat, m,
                imagePath: getRareRollImagePath(result.roll),
                text: [
                    renderSavedRollMessage(result), '',
                    result.count >= MAX_PLAYER_ROLLS
                        ? `> Você fechou *${MAX_PLAYER_ROLLS}/${MAX_PLAYER_ROLLS}* rolls. Próximo passo: use *${COMMAND_PREFIX}rolls* para revisar e depois *${COMMAND_PREFIX}ficha <número>* para escolher.`
                        : `> Próximo passo: você pode usar *${COMMAND_PREFIX}sortear* de novo ou *${COMMAND_PREFIX}rolls* para revisar.`,
                ].join('\n'),
            });
        } catch (error) {
            await rollbackStoredRoll(db, idJogador, result.roll.rollNumber).catch(() => {});
            throw error;
        }

        await updateOnboardingStep(db, idJogador, 'roll_gerado', { last_message:'roll_saved', roll_number:result.roll.rollNumber, count:result.count });
    },
};
