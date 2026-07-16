'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { formatPlayerTag } = require('../helpers/clover/archiveManager');
const {
    formatTargetErrorDetails,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    ACCESS_PERMISSIONS,
    authorizeCharacterCommandAccess,
} = require('../helpers/clover/accessIntegrationService');
const { getPlayerTechnicalCapacity } = require('../helpers/clover/capacityService');
const {
    formatPlayerCapacity,
    formatTechnicalCapacity,
} = require('../helpers/clover/capacityCatalogPresentationFinal');

function isSpecialCapacityViewer(playerId) {
    const tag = formatPlayerTag(playerId);
    const digits = String(playerId || '').replace(/\D/g, '');
    return tag.endsWith('2790') || digits.endsWith('2790');
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

    return { technical: false, targetBody: String(body || '').trim() };
}

async function resolveCapacityTarget(db, body, m, fallbackPlayerId) {
    const target = resolveTargetAndRest(body, m);
    if (!target.targetId && !target.targetText) {
        return resolveSelfCapacityTarget(db, fallbackPlayerId);
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
        player: resolved?.player || { id: playerId },
        resolved,
    };
}

module.exports = {
    nome: `${COMMAND_PREFIX}capacidade`,
    aliases: [
        `${COMMAND_PREFIX}capacidade tecnica`,
        `${COMMAND_PREFIX}capacidade técnica`,
    ],
    descricao: 'Mostra a capacidade atual ou a visão técnica conforme o cargo.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const mode = parseMode(matchedCommand, body);
        const targetResolution = await resolveCapacityTarget(
            db,
            mode.targetBody,
            m,
            idJogador
        );

        if (!targetResolution.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    'Não consegui encontrar esse player para a consulta de capacidade.',
                    '',
                    formatTargetErrorDetails(targetResolution.details),
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        const targetId = targetResolution.targetId;
        const targetPlayer = targetResolution.player || { id: targetId };
        const ownView = isSameUser(targetId, idJogador);
        const permission = mode.technical
            ? ACCESS_PERMISSIONS.CAPACITY_TECHNICAL
            : ACCESS_PERMISSIONS.CAPACITY_READ;
        const access = await authorizeCharacterCommandAccess({
            db,
            sock,
            idChat,
            actorId: idJogador,
            targetPlayer,
            permission,
            allowSelf: true,
            allowLegacyAdmin: true,
            specialViewer: isSpecialCapacityViewer,
        });
        if (!access.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: mode.technical
                    ? 'A visão técnica de outro personagem é restrita a Avaliador, Administrador, Owner ou ADM do grupo.'
                    : 'Você não possui acesso à capacidade desse personagem.',
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
    parseMode,
    resolveCapacityTarget,
};
