const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    renderTraitsText,
    sendSystemText,
} = require('../helpers/clover/systemMessages');
const {
    ATTEMPT_LABELS,
    renderAttemptResult,
    renderAttemptStatus,
} = require('../helpers/clover/traitAttemptMessages');
const { rollbackUndeliveredAttempt } = require('../helpers/clover/traitAttemptDelivery');
const { getAttemptsForPlayer, rollbackSpecialAttempt, runSpecialAttempt } = require('../helpers/clover/traitManager');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const { getFutureTraitIdentity } = require('../helpers/clover/preResetTraitIdentity');
const {
    renderPreResetAnomaliesAvailability,
    stripLegacySlotCounters,
} = require('../helpers/clover/preResetCatalogMessages');
const { normalizeText } = require('../helpers/textUtils');

const DIRECT_ATTEMPT_CATEGORIES = new Set([
    'aptidao',
    'aptidao rara',
    'apt rara',
    'marca',
    'marca rara',
    'anomalia',
    'anom',
]);

const STATUS_BODIES = new Set(['resultado', 'resultados', 'status', 'tentativas', 'historico']);

function isAttemptStatusBody(body) {
    const normalized = normalizeText(body).replace(/\s+/g, ' ').trim();
    return STATUS_BODIES.has(normalized);
}

function parseTraitAttemptBody(body) {
    const raw = String(body || '').trim();
    if (!raw) return null;

    const prefixed = raw.match(/^(?:tentar|sortear|rolar|roll|tirar|raridade)(?:\s+(?:de\s+)?(?:traco|tracos|traço|traços))?\s+(.+)$/i);
    if (prefixed?.[1]) return prefixed[1].trim();

    const normalized = normalizeText(raw).replace(/\s+/g, ' ').trim();
    return DIRECT_ATTEMPT_CATEGORIES.has(normalized) ? raw : null;
}

module.exports = {
    nome: `${COMMAND_PREFIX}tracos`,
    aliases: [
        `${COMMAND_PREFIX}traços`,
        `${COMMAND_PREFIX}traco`,
        `${COMMAND_PREFIX}traço`,
        `${COMMAND_PREFIX}sorteartraco`,
        `${COMMAND_PREFIX}sorteartraço`,
        `${COMMAND_PREFIX}sorteartracos`,
        `${COMMAND_PREFIX}sorteartraços`,
        `${COMMAND_PREFIX}rolltraco`,
        `${COMMAND_PREFIX}rolltraço`,
        `${COMMAND_PREFIX}rolltracos`,
        `${COMMAND_PREFIX}rolltraços`,
        `${COMMAND_PREFIX}rolartraco`,
        `${COMMAND_PREFIX}rolartraço`,
        `${COMMAND_PREFIX}rolartracos`,
        `${COMMAND_PREFIX}rolartraços`,
        `${COMMAND_PREFIX}tentartraco`,
        `${COMMAND_PREFIX}tentartraço`,
        `${COMMAND_PREFIX}tentartracos`,
        `${COMMAND_PREFIX}tentartraços`,
        `${COMMAND_PREFIX}raridadetraco`,
        `${COMMAND_PREFIX}raridadetraço`,
        `${COMMAND_PREFIX}raridadetracos`,
        `${COMMAND_PREFIX}raridadetraços`,
    ],
    descricao: 'Lista aptidoes, marcas e anomalias ou realiza uma tentativa especial.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (isPreResetTransitionEnabled(process.env)) {
            const attemptPlayerId = getFutureTraitIdentity(idJogador);

            if (isAttemptStatusBody(body)) {
                const attempts = await getAttemptsForPlayer(db, attemptPlayerId);
                await sendReply({ sock, idChat, m, text:renderAttemptStatus(attempts) });
                return;
            }

            const attemptCategory = parseTraitAttemptBody(body);
            if (attemptCategory) {
                const result = await runSpecialAttempt(db, attemptPlayerId, attemptCategory);
                const attempts = await getAttemptsForPlayer(db, attemptPlayerId);

                if (!result.ok) {
                    const category = result.attempt?.category || attempts[attempts.length - 1]?.category || null;
                    const categoryLabel = category
                        ? ATTEMPT_LABELS[category] || category
                        : attemptCategory;
                    const error = result.reason === 'limit_reached'
                        ? 'Você já utilizou as 𝟤 tentativas especiais desta criação.'
                        : result.error || 'Use aptidão, marca ou anomalia.';

                    await sendReply({
                        sock, idChat, m,
                        text:renderAttemptResult({
                            category,
                            categoryLabel,
                            success:false,
                            attempts,
                            error,
                        }),
                    });
                    return;
                }

                try {
                    const sendResult = await sendReply({
                        sock, idChat, m,
                        text:renderAttemptResult({
                            category:result.category,
                            categoryLabel:ATTEMPT_LABELS[result.category] || result.category,
                            success:result.success,
                            attempts,
                        }),
                    });
                    await rollbackUndeliveredAttempt({
                        db,
                        playerId:attemptPlayerId,
                        attemptNumber:result.attempt?.attempt_number,
                        rollbackSpecialAttempt,
                        sendResult,
                        source:'tracos-prereset',
                    });
                } catch (error) {
                    await rollbackSpecialAttempt(db, attemptPlayerId, result.attempt?.attempt_number).catch((rollbackError) => {
                        console.warn('[tracos-prereset] Falha ao desfazer tentativa sem entrega:', rollbackError?.message || rollbackError);
                    });
                    throw error;
                }
                return;
            }

            if (String(body || '').trim()) {
                await sendReply({
                    sock, idChat, m,
                    text:[
                        '*♧┃PRE_RESET · TRAÇOS*',
                        '',
                        `Use *${COMMAND_PREFIX}tentativa aptidao*, *${COMMAND_PREFIX}tentativa marca* ou *${COMMAND_PREFIX}tentativa anomalia*.`,
                        `Os formatos *${COMMAND_PREFIX}tracos tentar ...* também funcionam.`,
                        'São 2 tentativas especiais nesta nova criação; o histórico antigo fica separado.',
                    ].join('\n'),
                });
                return;
            }

            const [availability, details, attempts] = await Promise.all([
                renderPreResetAnomaliesAvailability(db),
                renderTraitsText(db),
                getAttemptsForPlayer(db, attemptPlayerId),
            ]);
            await sendSystemText({
                sock,
                idChat,
                m,
                text:[
                    availability,
                    '',
                    `*Tentativas especiais usadas:* ${attempts.length}/2.`,
                    `↳ Veja o resultado com *${COMMAND_PREFIX}tentativa status*.`,
                    '',
                    '────────  DETALHES DOS TRAÇOS  ────────',
                    '',
                    stripLegacySlotCounters(details),
                ].join('\n'),
            });
            return;
        }

        if (isAttemptStatusBody(body)) {
            const attempts = await getAttemptsForPlayer(db, idJogador);
            await sendReply({
                sock,
                idChat,
                m,
                text: renderAttemptStatus(attempts),
            });
            return;
        }

        const attemptCategory = parseTraitAttemptBody(body);
        if (attemptCategory) {
            const result = await runSpecialAttempt(db, idJogador, attemptCategory);
            const attempts = await getAttemptsForPlayer(db, idJogador);

            if (!result.ok) {
                const category = result.attempt?.category || attempts[attempts.length - 1]?.category || null;
                const categoryLabel = category
                    ? ATTEMPT_LABELS[category] || category
                    : attemptCategory;
                const error = result.reason === 'limit_reached'
                    ? 'Você já utilizou as 𝟤 tentativas especiais desta criação.'
                    : result.error || 'Use aptidão, marca ou anomalia.';

                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderAttemptResult({
                        category,
                        categoryLabel,
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
                        categoryLabel: ATTEMPT_LABELS[result.category] || result.category,
                        success: result.success,
                        attempts,
                    }),
                });
                await rollbackUndeliveredAttempt({
                    db,
                    playerId: idJogador,
                    attemptNumber: result.attempt?.attempt_number,
                    rollbackSpecialAttempt,
                    sendResult,
                    source: 'tracos',
                });
            } catch (error) {
                await rollbackSpecialAttempt(db, idJogador, result.attempt?.attempt_number).catch((rollbackError) => {
                    console.warn('[tracos] Nao consegui desfazer tentativa apos falha de envio:', rollbackError?.message || rollbackError);
                });
                throw error;
            }
            return;
        }

        if (String(body || '').trim()) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    'Use uma destas formas:',
                    `*${COMMAND_PREFIX}tentativa aptidao*`,
                    `*${COMMAND_PREFIX}tentativa marca*`,
                    `*${COMMAND_PREFIX}tentativa anomalia*`,
                    '',
                    `Os formatos antigos com *${COMMAND_PREFIX}tracos tentar ...* continuam funcionando.`,
                ].join('\n'),
            });
            return;
        }

        await sendSystemText({ sock, idChat, m, text: await renderTraitsText(db) });
    },
    parseTraitAttemptBody,
};
