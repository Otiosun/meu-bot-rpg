const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    ATTEMPT_LABELS,
    renderAttemptHelp,
    renderAttemptResult,
    renderAttemptStatus,
} = require('../helpers/clover/traitAttemptMessages');
const { rollbackUndeliveredAttempt } = require('../helpers/clover/traitAttemptDelivery');
const { getAttemptsForPlayer, rollbackSpecialAttempt, runSpecialAttempt } = require('../helpers/clover/traitManager');
const { normalizeText } = require('../helpers/textUtils');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const { getFutureTraitIdentity } = require('../helpers/clover/preResetTraitIdentity');

const STATUS_BODIES = new Set(['resultado', 'resultados', 'status', 'tentativas', 'historico', 'histórico']);

function isAttemptStatusBody(body) {
    const normalized = normalizeText(body).replace(/\s+/g, ' ').trim();
    return STATUS_BODIES.has(normalized);
}

module.exports = {
    nome: `${COMMAND_PREFIX}tentativa`,
    aliases: [
        `${COMMAND_PREFIX}tentativas`,
        `${COMMAND_PREFIX}tentar`,
    ],
    descricao: 'Explica ou realiza uma tentativa especial de traco.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const categoryInput = String(body || '').trim();
        const attemptPlayerId = isPreResetTransitionEnabled(process.env)
            ? getFutureTraitIdentity(idJogador)
            : idJogador;
        const attemptsBefore = await getAttemptsForPlayer(db, attemptPlayerId);

        if (!categoryInput) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderAttemptHelp(attemptsBefore),
            });
            return;
        }

        if (isAttemptStatusBody(categoryInput)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderAttemptStatus(attemptsBefore),
            });
            return;
        }

        const result = await runSpecialAttempt(db, attemptPlayerId, categoryInput);
        const attempts = await getAttemptsForPlayer(db, attemptPlayerId);

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
            const sendResult = await sendReply({
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
            await rollbackUndeliveredAttempt({
                db,
                playerId: attemptPlayerId,
                attemptNumber: result.attempt?.attempt_number,
                rollbackSpecialAttempt,
                sendResult,
                source: 'tentativa',
            });
        } catch (error) {
            await rollbackSpecialAttempt(db, attemptPlayerId, result.attempt?.attempt_number).catch((rollbackError) => {
                console.warn('[tentativa] Nao consegui desfazer tentativa apos falha de envio:', rollbackError?.message || rollbackError);
            });
            throw error;
        }
    },
};
