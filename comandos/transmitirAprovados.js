const { COMMAND_PREFIX } = require('../config/bot');
const { sendPrivateMessage, sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const { formatPlayerTag } = require('../helpers/clover/archiveManager');

const TARGET_QUERY = `
    SELECT id, display_name, nome, personagem_nome
    FROM jogadores
    WHERE ficha_status = 'aprovada'
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

function getDisplayName(target) {
    return String(target.personagem_nome || target.display_name || target.nome || target.id || '-').trim() || '-';
}

function renderTargetPreview(targets) {
    const preview = targets.slice(0, 12).map((target) => (
        `${formatPlayerTag(target.id)} ${getDisplayName(target)}`
    ));

    if (targets.length > preview.length) {
        preview.push(`...e mais ${targets.length - preview.length}.`);
    }

    return preview;
}

function renderHelp(targets) {
    return [
        '*Transmissao para fichas aprovadas*',
        '',
        `Alvo atual: *${targets.length}* player(s) com ficha aprovada.`,
        '',
        ...renderTargetPreview(targets),
        '',
        `Use *${COMMAND_PREFIX}transmitiraprovados <mensagem>*`,
        `Ou responda uma mensagem/imagem com *${COMMAND_PREFIX}transmitiraprovados*.`,
        `Ou mande uma imagem com legenda *${COMMAND_PREFIX}transmitiraprovados <mensagem>*.`,
        '',
        'Quebras de linha sao mantidas.',
        'Players sem ficha aprovada nao recebem.',
    ].join('\n');
}

function renderDone({ targetCount, successCount, failureCount }) {
    return [
        '*Transmissao concluida.*',
        '',
        `Alvos com ficha aprovada: *${targetCount}*.`,
        `Enviados: *${successCount}*.`,
        `Falhas: *${failureCount}*.`,
    ].join('\n');
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getApprovedTargets(db) {
    return db.all(TARGET_QUERY);
}

module.exports = {
    nome: `${COMMAND_PREFIX}transmitiraprovados`,
    aliases: [
        `${COMMAND_PREFIX}transmitiraprovados`,
        `${COMMAND_PREFIX}avisaraprovados`,
        `${COMMAND_PREFIX}broadcastaprovados`,
        `${COMMAND_PREFIX}transmitirfichaaprovada`,
        `${COMMAND_PREFIX}transmitirfichasaprovadas`,
    ],
    descricao: 'Transmite mensagem para players com ficha aprovada.',
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

        const targets = await getApprovedTargets(db);
        const quotedMessage = getQuotedMessage(m.message);
        const imageWrapper = getImageWrapper(m);
        const quotedText = extractMessageText(quotedMessage);
        const text = normalizeBroadcastText(body || quotedText);
        const action = normalizeText(body);

        if ((!text && !imageWrapper) || ['contar', 'status', 'alvos', 'lista', 'ajuda'].includes(action)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderHelp(targets),
            });
            return;
        }

        if (!targets.length) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Nenhum player com ficha aprovada foi encontrado.*',
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
                console.log(`Falha ao transmitir aprovados para ${target.id}:`, error?.message || error);
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
