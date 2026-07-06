const { COMMAND_PREFIX } = require('../config/bot');
const { sendPrivateMessage, sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');

const TARGET_QUERY = `
    SELECT id, display_name, nome, personagem_nome
    FROM jogadores
    WHERE ficha_status = 'aprovada'
      AND COALESCE(historia_status, 'pendente') = 'pendente'
      AND id IS NOT NULL
      AND id <> ''
    ORDER BY personagem_nome COLLATE NOCASE, display_name COLLATE NOCASE, nome COLLATE NOCASE, id
`;

function getContextInfo(messageNode) {
    return messageNode?.extendedTextMessage?.contextInfo
        || messageNode?.imageMessage?.contextInfo
        || null;
}

function getQuotedMessage(messageNode) {
    return getContextInfo(messageNode)?.quotedMessage || null;
}

function extractMessageText(messageNode) {
    if (!messageNode) return '';

    return String(
        messageNode.conversation
        || messageNode.extendedTextMessage?.text
        || messageNode.imageMessage?.caption
        || ''
    );
}

function getImageWrapper(m) {
    if (m.message?.imageMessage) {
        return {
            wrapper: m,
            mimeType: m.message.imageMessage.mimetype,
        };
    }

    const quotedMessage = getQuotedMessage(m.message);
    if (quotedMessage?.imageMessage) {
        return {
            wrapper: { key: m.key, message: quotedMessage },
            mimeType: quotedMessage.imageMessage.mimetype,
        };
    }

    return null;
}

function normalizeBroadcastText(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\\n/g, '\n')
        .trim();
}

function renderHelp(targetCount) {
    return [
        '*Transmissao de historia pendente*',
        '',
        `Alvo atual: *${targetCount}* player(s) com ficha aprovada e historia pendente.`,
        '',
        `Use *${COMMAND_PREFIX}transmitirhistoria <mensagem>*`,
        `Ou responda uma mensagem/imagem com *${COMMAND_PREFIX}transmitirhistoria*.`,
        `Ou mande uma imagem com legenda *${COMMAND_PREFIX}transmitirhistoria <mensagem>*.`,
        '',
        'Quebras de linha sao mantidas.',
    ].join('\n');
}

function renderDone({ targetCount, successCount, failureCount }) {
    return [
        '*Transmissao concluida.*',
        '',
        `Alvos: *${targetCount}*.`,
        `Enviados: *${successCount}*.`,
        `Falhas: *${failureCount}*.`,
    ].join('\n');
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPendingHistoryTargets(db) {
    return db.all(TARGET_QUERY);
}

module.exports = {
    nome: `${COMMAND_PREFIX}transmitirhistoria`,
    aliases: [
        `${COMMAND_PREFIX}transmitirhistoria`,
        `${COMMAND_PREFIX}transmitirhistorias`,
        `${COMMAND_PREFIX}transmitirlore`,
        `${COMMAND_PREFIX}broadcastlore`,
    ],
    descricao: 'Transmite mensagem para players com ficha aprovada e historia pendente.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, body, db, downloadMediaMessage, P }) => {
        if (!isOwner(idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Esse comando e reservado para a dona do bot.*',
            });
            return;
        }

        const targets = await getPendingHistoryTargets(db);
        const quotedMessage = getQuotedMessage(m.message);
        const imageWrapper = getImageWrapper(m);
        const quotedText = extractMessageText(quotedMessage);
        const text = normalizeBroadcastText(body || quotedText);
        const action = normalizeText(body);

        if ((!text && !imageWrapper) || ['contar', 'status', 'alvos', 'ajuda'].includes(action)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderHelp(targets.length),
            });
            return;
        }

        if (!targets.length) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Nenhum player com ficha aprovada e historia pendente foi encontrado.*',
            });
            return;
        }

        let imageBuffer = null;
        if (imageWrapper) {
            imageBuffer = await downloadMediaMessage(
                imageWrapper.wrapper,
                'buffer',
                {},
                {
                    logger: P({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage,
                }
            );
        }

        let successCount = 0;
        let failureCount = 0;

        for (const target of targets) {
            try {
                let privateResult;
                if (imageBuffer) {
                    privateResult = await sendPrivateMessage({
                        sock,
                        playerId: target.id,
                        message: {
                        image: imageBuffer,
                        caption: text || undefined,
                        },
                    });
                } else {
                    privateResult = await sendPrivateMessage({
                        sock,
                        playerId: target.id,
                        message: { text },
                    });
                }

                if (privateResult?.skipped) {
                    failureCount += 1;
                    continue;
                }
                successCount += 1;
                await wait(350);
            } catch (error) {
                failureCount += 1;
                console.log(`Falha ao transmitir historia para ${target.id}:`, error?.message || error);
            }
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: renderDone({
                targetCount: targets.length,
                successCount,
                failureCount,
            }),
        });
    },
};
