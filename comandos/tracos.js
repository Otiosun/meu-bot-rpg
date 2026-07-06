const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    renderTraitAttemptMessage,
    renderTraitsText,
    sendSystemText,
} = require('../helpers/clover/systemMessages');
const { getAttemptsForPlayer, rollbackSpecialAttempt, runSpecialAttempt } = require('../helpers/clover/traitManager');

const ATTEMPT_LABELS = {
    rare_aptitude: 'Aptidão Rara',
    rare_mark: 'Marca Rara',
    anomaly: 'Anomalia',
};

module.exports = {
    nome: `${COMMAND_PREFIX}tracos`,
    aliases: [`${COMMAND_PREFIX}traços`],
    descricao: 'Lista aptidoes, marcas e anomalias.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const attemptMatch = String(body || '').trim().match(/^tentar\s+(.+)$/i);
        if (attemptMatch) {
            const result = await runSpecialAttempt(db, idJogador, attemptMatch[1]);
            const attempts = await getAttemptsForPlayer(db, idJogador);

            if (!result.ok) {
                const categoryLabel = result.attempt?.category
                    ? ATTEMPT_LABELS[result.attempt.category] || result.attempt.category
                    : ATTEMPT_LABELS[attempts[attempts.length - 1]?.category] || attemptMatch[1];
                const error = result.reason === 'limit_reached'
                    ? 'Você já usou as 2 tentativas especiais.'
                    : result.error || 'Use aptidão, marca ou anomalia.';

                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderTraitAttemptMessage({
                        categoryLabel,
                        success: false,
                        attempts,
                        error,
                    }),
                });
                return;
            }

            try {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderTraitAttemptMessage({
                        categoryLabel: ATTEMPT_LABELS[result.category] || result.category,
                        success: result.success,
                        attempts,
                    }),
                });
            } catch (error) {
                await rollbackSpecialAttempt(db, idJogador, result.attempt?.attempt_number).catch((rollbackError) => {
                    console.warn('[tracos] Nao consegui desfazer tentativa apos falha de envio:', rollbackError?.message || rollbackError);
                });
                throw error;
            }
            return;
        }

        await sendSystemText({ sock, idChat, m, text: await renderTraitsText(db) });
    },
};
