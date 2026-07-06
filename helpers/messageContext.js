const { normalizeText } = require('./textUtils');

function getContentNode(message) {
    let content = message?.message || message || {};

    for (let i = 0; i < 8; i += 1) {
        const next = content.ephemeralMessage?.message
            || content.viewOnceMessage?.message
            || content.viewOnceMessageV2?.message
            || content.viewOnceMessageV2Extension?.message
            || content.documentWithCaptionMessage?.message
            || content.protocolMessage?.editedMessage
            || null;

        if (!next || next === content) break;
        content = next;
    }

    return content || {};
}

function getMessageText(message) {
    const content = getContentNode(message);
    return content.conversation
        || content.extendedTextMessage?.text
        || content.imageMessage?.caption
        || content.videoMessage?.caption
        || content.documentMessage?.caption
        || content.buttonsResponseMessage?.selectedDisplayText
        || content.buttonsResponseMessage?.selectedButtonId
        || content.listResponseMessage?.title
        || content.listResponseMessage?.singleSelectReply?.selectedRowId
        || content.templateButtonReplyMessage?.selectedDisplayText
        || content.templateButtonReplyMessage?.selectedId
        || '';
}

function getMessageContextInfo(message) {
    const content = getContentNode(message);
    return content.extendedTextMessage?.contextInfo
        || content.imageMessage?.contextInfo
        || content.videoMessage?.contextInfo
        || content.documentMessage?.contextInfo
        || content.audioMessage?.contextInfo
        || content.stickerMessage?.contextInfo
        || content.buttonsResponseMessage?.contextInfo
        || content.listResponseMessage?.contextInfo
        || content.templateButtonReplyMessage?.contextInfo
        || null;
}

function getQuotedTextFromMessage(message) {
    return getMessageText(message);
}

function getQuotedText(message) {
    const contextInfo = getMessageContextInfo(message);
    return getQuotedTextFromMessage(contextInfo?.quotedMessage);
}

function isReplyMessage(message) {
    const contextInfo = getMessageContextInfo(message);
    return Boolean(contextInfo?.quotedMessage || contextInfo?.stanzaId);
}

function isMagicPromptText(value) {
    const quotedText = normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!quotedText) return false;

    return quotedText.includes('magias disponiveis')
        || quotedText.includes('escolha sua magia')
        || quotedText.includes('responda esta mensagem') && quotedText.includes('magia')
        || quotedText.includes('raridade do seu roll') && quotedText.includes('magia')
        || quotedText.includes('roll da magia') && quotedText.includes('magia')
        || quotedText.includes('confirmacao') && quotedText.includes('magia');
}

function isMagicReplyMessage(message) {
    if (!isReplyMessage(message)) return false;

    return isMagicPromptText(getQuotedText(message));
}

module.exports = {
    getMessageContextInfo,
    getMessageText,
    getQuotedText,
    isMagicReplyMessage,
    isReplyMessage,
};
