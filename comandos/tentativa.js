const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    ATTEMPT_LABELS,
    renderAttemptHelp,
    renderAttemptResult,
} = require('../helpers/clover/traitAttemptMessages');
const { getAttemptsForPlayer, rollbackSpecialAttempt, runSpecialAttempt } = require('../helpers/clover/traitManager');

module.exports = {
    nome: `${COMMAND_PREFIX}tentativa`,
    aliases: [
        `${COMMAND_PREFIX}tentativas`,
        `${COMMAND_PREFIX}tentar`,
    ],
    descricao: 'Explica ou realiza uma tentativa especial de traco.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const categoryInput = String(body || '').trim();
        const attemptsBefore = await getAttemptsForPlayer(db, idJogador);

        if (!categoryInput) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderAttemptHelp(attemptsBefore),
            });
            return;
        }

        const result = await runSpecialAttempt(db, idJogador, categoryInput);
        const attempts = await getAttemptsForPlayer(db, idJogador);

        if (!result.ok) {
            const category = result.attempt?.category || attempts[attempts.length - 1]?.category || null;
            const error = result.reason === 'limit_reached'
                ? 'Você já utilizou as 𝟤 tentativas especiais desta criação.'
                : result.error || 'Use aptidão, marca ou anomalia.';

            await sendReply({
                sock,
                idChat,
                m,
                text: renderAttemptResult({
                    category,
                    categoryLabel: category ? ATTEMPT_LABELS[category] : categoryInput,
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
                text: renderAttemptResult({
                    category: result.category,
                    categoryLabel: ATTEMPT_LABELS[result.category],
                    success: result.success,
                    attempts,
                }),
            });
        } catch (error) {
            await rollbackSpecialAttempt(db, idJogador, result.attempt?.attempt_number).catch((rollbackError) => {
                console.warn('[tentativa] Nao consegui desfazer tentativa apos falha de envio:', rollbackError?.message || rollbackError);
            });
            throw error;
        }
    },
};