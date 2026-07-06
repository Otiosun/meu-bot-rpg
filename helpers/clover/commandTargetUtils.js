const { getMessageContextInfo } = require('../messageContext');
const {
    extractPhoneNumber,
    isOwner,
    isSameUser,
    normalizeJid,
} = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const targetResolver = require('./targetResolver');

const GROUP_ADMIN_CHECK_TIMEOUT_MS = 3500;

function withTimeout(promise, timeoutMs, fallback) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function isGroupAdmin(sock, groupId, playerId) {
    try {
        const metadata = await withTimeout(
            sock.groupMetadata(groupId),
            GROUP_ADMIN_CHECK_TIMEOUT_MS,
            null
        );
        if (!metadata) return false;

        const participant = (metadata.participants || []).find((item) => (
            isSameUser(item.id, playerId)
            || isSameUser(item.jid, playerId)
            || isSameUser(item.lid, playerId)
        ));
        return ['admin', 'superadmin'].includes(participant?.admin);
    } catch {
        return false;
    }
}

async function canManagePlayer(sock, groupId, playerId) {
    if (isOwner(playerId)) return true;
    if (!groupId?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, groupId, playerId);
}

function getMentions(m) {
    return getMessageContextInfo(m)?.mentionedJid || [];
}

function getQuotedParticipant(m) {
    return getMessageContextInfo(m)?.participant || null;
}

function jidFromToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;

    const withoutLeadingAt = raw.replace(/^@/, '');
    if (withoutLeadingAt.includes('@')) return normalizeJid(withoutLeadingAt);

    const digits = withoutLeadingAt.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

function splitBody(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

function stripMentionTokens(body) {
    return String(body || '').replace(/@\S+/g, '').trim();
}

function splitTargetAndRest(body) {
    const text = String(body || '').trim();
    if (!text) return { targetText: '', rest: '' };
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return {
        targetText: match?.[1] || '',
        rest: String(match?.[2] || '').trim(),
    };
}

function resolveTargetAndRest(body, m) {
    const mentions = getMentions(m);
    if (mentions.length) {
        return {
            targetId: normalizeJid(mentions[0]),
            targetText: '',
            rest: stripMentionTokens(body),
            source: 'mention',
        };
    }

    const quoted = getQuotedParticipant(m);
    if (quoted) {
        return {
            targetId: normalizeJid(quoted),
            targetText: '',
            rest: String(body || '').trim(),
            source: 'quote',
        };
    }

    const { targetText, rest } = splitTargetAndRest(body);
    return {
        targetId: jidFromToken(targetText),
        targetText,
        rest,
        source: targetText ? 'body' : 'none',
    };
}

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function playerDisplayName(player, fallbackId = null) {
    return player?.personagem_nome
        || player?.display_name
        || player?.nome
        || fallbackId
        || '-';
}

module.exports = {
    EMPTY_CHARACTER_MESSAGE: targetResolver.EMPTY_CHARACTER_MESSAGE,
    assertMechanicalTarget: targetResolver.assertMechanicalTarget,
    canManagePlayer,
    describeTargetSource: targetResolver.describeTargetSource,
    ensureTargetResolverSchema: targetResolver.ensureTargetResolverSchema,
    findPlayersByIdentifier: targetResolver.findPlayersByIdentifier,
    formatTargetErrorDetails: targetResolver.formatTargetErrorDetails,
    formatMention,
    getCanonicalPlayer: targetResolver.getCanonicalPlayer,
    getMentions,
    getPlayerById: targetResolver.getPlayerById,
    getRawPlayerById: targetResolver.getRawPlayerById,
    getQuotedParticipant,
    isEmptyCharacterPlayer: targetResolver.isEmptyCharacterPlayer,
    jidFromToken,
    linkPlayerTarget: targetResolver.linkPlayerTarget,
    listPlayerTargetAliases: targetResolver.listPlayerTargetAliases,
    mergePlayerIdentity: targetResolver.mergePlayerIdentity,
    normalizeTargetAliasKey: targetResolver.normalizeTargetAliasKey,
    normalizeTargetAliasLabel: targetResolver.normalizeTargetAliasLabel,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetDetails: targetResolver.resolveTargetDetails,
    resolveTargetPlayer: targetResolver.resolveTargetPlayer,
    stripMentionTokens,
};
