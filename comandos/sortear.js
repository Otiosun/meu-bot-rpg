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

module.exports = {
    nome: `${COMMAND_PREFIX}sortear`,
    descricao: 'Gera um roll completo, salva com número e respeita seu limite.',
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
            if (result.reason === 'sacrifice_used') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '♧┃𝐑𝐎𝐋𝐋 𝐅𝐈𝐍𝐀𝐋 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
                        '     ──  sacrifício já usado  ──',
                        '',
                        '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
                        '',
                        '*Você já usou o sacrifício dos 4 rolls.*',
                        '> Esse caminho é definitivo: não dá para sortear de novo.',
                        '',
                        '_`─( ■ )───── 𝗔𝗴𝗼𝗿𝗮`_',
                        '',
                        `*̣${COMMAND_PREFIX}rolls*`,
                        '> Rever seu roll final.',
                        `*̣${COMMAND_PREFIX}ficha 5*`,
                        '> Pegar o modelo.',
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
                    `> Próximo passo: use *${COMMAND_PREFIX}continuar* ou *${COMMAND_PREFIX}ficha <número do roll>*.`,
                ].join('\n'),
            });
            await updateOnboardingStep(db, idJogador, 'limite_rolls', {
                last_message: 'roll_limit',
                count: result.count,
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
                result.count >= MAX_PLAYER_ROLLS
                    ? `> Você fechou *${MAX_PLAYER_ROLLS}/${MAX_PLAYER_ROLLS}* rolls. Próximo passo: use *${COMMAND_PREFIX}rolls* para revisar e depois *${COMMAND_PREFIX}ficha <número>* para escolher.`
                    : `> Próximo passo: você pode usar *${COMMAND_PREFIX}sortear* de novo ou *${COMMAND_PREFIX}rolls* para revisar.`,
            ].join('\n'),
            });
        } catch (error) {
            await rollbackStoredRoll(db, idJogador, result.roll.rollNumber).catch((rollbackError) => {
                console.warn('[sortear] Não consegui desfazer roll após falha de envio:', rollbackError?.message || rollbackError);
            });
            throw error;
        }

        await updateOnboardingStep(db, idJogador, 'roll_gerado', {
            last_message: 'roll_saved',
            roll_number: result.roll.rollNumber,
            count: result.count,
        });
    },
};
