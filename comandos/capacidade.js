const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { formatPlayerTag } = require('../helpers/clover/archiveManager');
const {
    formatTargetErrorDetails,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const { getPlayerTechnicalCapacity } = require('../helpers/clover/capacityService');
const {
    formatPlayerCapacity,
    formatTechnicalCapacity,
} = require('../helpers/clover/capacityCatalogPresentation');

async function isGroupAdmin(sock, groupId, playerId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
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

function isSpecialCapacityViewer(playerId) {
    const tag = formatPlayerTag(playerId);
    const digits = String(playerId || '').replace(/\D/g, '');
    return tag.endsWith('2790') || digits.endsWith('2790');
}

async function canManagePlayer(sock, idChat, idJogador) {
    if (isOwner(idJogador)) return true;
    if (isSpecialCapacityViewer(idJogador)) return true;
    if (!idChat?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, idChat, idJogador);
}

function splitBody(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

function parseMode(matchedCommand, body) {
    const matched = normalizeText(matchedCommand || '');
    if (matched.includes('tecnica') || matched.includes('tecnico')) {
        return { technical: true, targetBody: String(body || '').trim() };
    }

    const parts = splitBody(body);
    const first = normalizeText(parts[0] || '');
    if (first === 'tecnica' || first === 'tecnico') {
        return { technical: true, targetBody: parts.slice(1).join(' ') };
    }

    return { technical: false, targetBody: '' };
}

async function resolveCapacityTarget(db, body, m, fallbackPlayerId) {
    const target = resolveTargetAndRest(body, m);
    if (!target.targetId && !target.targetText) {
        return { ok: true, targetId: fallbackPlayerId, player: null, ownFallback: true };
    }

    const resolved = await resolveTargetPlayer(db, target.targetId, target.targetText, {
        source: target.source,
        quotedParticipant: target.source === 'quote' ? target.targetId : null,
        rejectEmptyCharacter: false,
    });

    if (!resolved.ok) return resolved;
    return {
        ok: true,
        targetId: resolved.canonicalPlayerId || resolved.player?.id || fallbackPlayerId,
        player: resolved.player || null,
        resolved,
    };
}

async function resolveSelfCapacityTarget(db, playerId) {
    const resolved = await resolveTargetPlayer(db, playerId, '', {
        source: 'self',
        rejectEmptyCharacter: false,
    }).catch(() => null);
    return {
        ok: true,
        targetId: resolved?.canonicalPlayerId || resolved?.player?.id || playerId,
        player: resolved?.player || null,
        resolved,
    };
}

module.exports = {
    nome: `${COMMAND_PREFIX}capacidade`,
    aliases: [
        `${COMMAND_PREFIX}capacidade tecnica`,
        `${COMMAND_PREFIX}capacidade técnica`,
    ],
    descricao: 'Mostra a capacidade técnica atual do personagem Clover.',
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const mode = parseMode(matchedCommand, body);
        const targetResolution = mode.technical
            ? await resolveCapacityTarget(db, mode.targetBody, m, idJogador)
            : await resolveSelfCapacityTarget(db, idJogador);

        if (!targetResolution.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    'Não consegui encontrar esse player para capacidade técnica.',
                    '',
                    formatTargetErrorDetails(targetResolution.details),
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        const targetId = targetResolution.targetId;
        const ownView = isSameUser(targetId, idJogador);

        if (!ownView && !await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode ver a capacidade técnica de outro player.',
            });
            return;
        }

        if (ownView) {
            const phaseInfo = await getPlayerPhase(db, idJogador);
            if (!phaseInfo.canPlay) {
                await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
                return;
            }
        }

        const capacity = await getPlayerTechnicalCapacity(db, targetId);
        const text = mode.technical
            ? formatTechnicalCapacity(capacity, { full: !ownView, admin: !ownView })
            : formatPlayerCapacity(capacity);

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [targetId],
            text,
        });
    },
};
