const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    buildTemplateContext,
    clearEditableImage,
    findImagePath,
    listEditableMessages,
    renderEditableMessage,
    resetEditableMessage,
    resolveContentKey,
    saveEditableImage,
    saveEditableText,
} = require('../helpers/onboardingFlow');

function splitFirstToken(value) {
    const text = String(value || '').trim();
    if (!text) return { first: '', rest: '' };

    const firstWhitespace = text.search(/\s/);
    if (firstWhitespace === -1) return { first: text, rest: '' };

    return {
        first: text.slice(0, firstWhitespace),
        rest: text.slice(firstWhitespace + 1).trim(),
    };
}

function getContextInfo(messageNode) {
    return messageNode?.extendedTextMessage?.contextInfo
        || messageNode?.imageMessage?.contextInfo
        || messageNode?.videoMessage?.contextInfo
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
        || messageNode.videoMessage?.caption
        || ''
    ).trim();
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

function normalizeEditableTextInput(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\\n/g, '\n')
        .trim();
}

function stripEditorPreviewPrefix(value) {
    const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
    if (!lines.length) return '';

    if (/^\*Mensagem `[^`]+` atualizada\.\*$/.test(lines[0])) {
        let startIndex = 1;
        while (lines[startIndex] === '') startIndex += 1;
        if (/^Salvo: \*.+\*\.$/.test(lines[startIndex] || '')) startIndex += 1;
        while (lines[startIndex] === '') startIndex += 1;
        return lines.slice(startIndex).join('\n').trim();
    }

    if (/^\*[^*]+\* - .+$/.test(lines[0])) {
        let startIndex = 1;
        while (lines[startIndex] === '') startIndex += 1;
        return lines.slice(startIndex).join('\n').trim();
    }

    return String(value || '').trim();
}

function renderHelp() {
    return [
        '*Uso do comando de mensagem*',
        '',
        `- *${COMMAND_PREFIX}mensagem listar*`,
        `- *${COMMAND_PREFIX}mensagem fluxo*`,
        `- *${COMMAND_PREFIX}mensagem ver recepcao*`,
        `- *${COMMAND_PREFIX}mensagem recepcao <texto>*`,
        `- *${COMMAND_PREFIX}mensagem historia <texto>*`,
        `- *${COMMAND_PREFIX}mensagem divulgacao <texto>*`,
        `- Responda um texto ou uma imagem com *${COMMAND_PREFIX}mensagem start*`,
        `- Envie uma imagem com a legenda *${COMMAND_PREFIX}mensagem recepcao*`,
        `- *${COMMAND_PREFIX}mensagem reset start*`,
        `- *${COMMAND_PREFIX}mensagem apagarimagem recepcao*`,
        '',
        '*Chaves disponiveis:*',
        ...listEditableMessages().map((item) => `- *${item.key}* - ${item.label}`),
        '',
        '*Placeholders uteis:*',
        '- `@!!` ou `{{mention}}`',
        '- `{{roll_count}}`',
        '- `{{max_rolls}}`',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}mensagem`,
    aliases: [`${COMMAND_PREFIX}mensagens`, `${COMMAND_PREFIX}texto`, `${COMMAND_PREFIX}textos`],
    descricao: 'Edita textos e imagens configuraveis do bot.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, body, downloadMediaMessage, P }) => {
        if (!isOwner(idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Esse comando e reservado para a dona do bot.*',
                    '',
                    `Se o bot nao estiver te reconhecendo, abra o PV dele e use *${COMMAND_PREFIX}registrardona 123456* com o codigo atual de 6 digitos que esta no terminal.`,
                ].join('\n'),
            });
            return;
        }

        const { first, rest } = splitFirstToken(body);
        const action = String(first || '').trim().toLowerCase();

        if (!action || action === 'listar' || action === 'lista') {
            await sendReply({ sock, idChat, m, text: renderHelp() });
            return;
        }

        if (action === 'fluxo' || action === 'todas' || action === 'todos') {
            const items = listEditableMessages();

            for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                await sendReply({
                    sock,
                    idChat,
                    m: index === 0 ? m : undefined,
                    mentions: item.key === 'recepcao' ? [idJogador] : [],
                    imagePath: findImagePath(item.key),
                    text: [
                        `*${item.key}* - ${item.label}`,
                        '',
                        renderEditableMessage(item.key, buildTemplateContext({
                            playerId: idJogador,
                            rollCount: item.key === 'sortear_limite' ? MAX_PLAYER_ROLLS : 1,
                            maxRolls: MAX_PLAYER_ROLLS,
                        })),
                    ].join('\n'),
                });
            }

            return;
        }

        if (action === 'ver') {
            const key = resolveContentKey(rest);
            if (!key) {
                await sendReply({ sock, idChat, m, text: renderHelp() });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: key === 'recepcao' ? [idJogador] : [],
                imagePath: findImagePath(key),
                text: renderEditableMessage(key, buildTemplateContext({
                    playerId: idJogador,
                    rollCount: key === 'sortear_limite' ? MAX_PLAYER_ROLLS : 1,
                    maxRolls: MAX_PLAYER_ROLLS,
                })),
            });
            return;
        }

        if (action === 'reset') {
            const key = resolveContentKey(rest);
            if (!key) {
                await sendReply({ sock, idChat, m, text: renderHelp() });
                return;
            }

            resetEditableMessage(key);
            await sendReply({
                sock,
                idChat,
                m,
                text: `*Mensagem \`${key}\` restaurada para o padrao.*`,
            });
            return;
        }

        if (action === 'apagarimagem' || action === 'removerimagem') {
            const key = resolveContentKey(rest);
            if (!key) {
                await sendReply({ sock, idChat, m, text: renderHelp() });
                return;
            }

            clearEditableImage(key);
            await sendReply({
                sock,
                idChat,
                m,
                text: `*Imagem de \`${key}\` removida.*`,
            });
            return;
        }

        const key = resolveContentKey(action);
        if (!key) {
            await sendReply({ sock, idChat, m, text: renderHelp() });
            return;
        }

        const quotedMessage = getQuotedMessage(m.message);
        const imageWrapper = getImageWrapper(m);
        const textFromQuoted = stripEditorPreviewPrefix(extractMessageText(quotedMessage));
        const rawTextToSave = rest || (!imageWrapper ? textFromQuoted : '') || '';
        const textToSave = normalizeEditableTextInput(rawTextToSave);

        if (!textToSave && !imageWrapper) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    `*Nao encontrei conteudo para \`${key}\`.*`,
                    '',
                    `Envie o texto junto com o comando, responda um texto, ou mande uma imagem com a legenda *${COMMAND_PREFIX}mensagem ${key}*.`,
                    'Quebras de linha normais sao mantidas, e `\\n` tambem vira quebra de linha.',
                ].join('\n'),
            });
            return;
        }

        let savedText = false;
        let savedImage = false;

        if (textToSave) {
            savedText = saveEditableText(key, textToSave);
        }

        if (imageWrapper) {
            const buffer = await downloadMediaMessage(
                imageWrapper.wrapper,
                'buffer',
                {},
                {
                    logger: P({ level: 'silent' }),
                    reuploadRequest: sock.updateMediaMessage,
                }
            );
            savedImage = saveEditableImage(key, buffer, imageWrapper.mimeType);
        }

        const changes = [];
        if (savedText) changes.push('texto');
        if (savedImage) changes.push('imagem');

        await sendReply({
            sock,
            idChat,
            m,
            mentions: key === 'recepcao' ? [idJogador] : [],
            imagePath: findImagePath(key),
            text: [
                `*Mensagem \`${key}\` atualizada.*`,
                '',
                changes.length ? `Salvo: *${changes.join(' + ')}*.` : 'Nenhuma alteracao foi aplicada.',
                '',
                renderEditableMessage(key, buildTemplateContext({
                    playerId: idJogador,
                    rollCount: key === 'sortear_limite' ? MAX_PLAYER_ROLLS : 1,
                    maxRolls: MAX_PLAYER_ROLLS,
                })),
            ].join('\n'),
        });
    },
};
