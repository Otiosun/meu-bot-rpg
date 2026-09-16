const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const {
    HEXAGON_SIDES,
    HexagonServiceError,
    normalizeSide,
    setHexagonSide,
} = require('../helpers/clover/hexagonService');
const { resolveTargetPlayer } = require('../helpers/clover/commandTargetUtils');

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

async function canManagePlayer(sock, idChat, idJogador) {
    if (isOwner(idJogador)) return true;
    if (!idChat?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, idChat, idJogador);
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
    if (withoutLeadingAt.includes('@')) return withoutLeadingAt;

    const digits = withoutLeadingAt.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

function resolveTargetAndRest(body, m) {
    const mentions = getMentions(m);
    if (mentions.length) {
        return {
            targetId: mentions[0],
            rest: String(body || '').replace(/@\S+/g, '').trim(),
        };
    }

    const quoted = getQuotedParticipant(m);
    if (quoted) {
        return { targetId: quoted, rest: String(body || '').trim() };
    }

    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    const targetId = jidFromToken(parts[0]);
    return {
        targetId,
        rest: targetId ? parts.slice(1).join(' ').trim() : '',
    };
}

function parseSetArgs(rest) {
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    return {
        side: parts[0],
        value: Number(parts[1]),
        reason: parts.slice(2).join(' ').trim(),
    };
}

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function renderUsage() {
    return [
        'Use:',
        `${COMMAND_PREFIX}sethexagono @player <lado> <valor> <motivo>`,
        '',
        'Lados válidos:',
        HEXAGON_SIDES.map((side) => `> ${side.key}`).join('\n'),
        '',
        `Exemplo: *${COMMAND_PREFIX}sethexagono @Killian controle 2 treino aprovado*`,
    ].join('\n');
}

function renderServiceError(error) {
    if (error instanceof HexagonServiceError) {
        if (error.code === 'invalid_side') return renderUsage();
        if (error.code === 'invalid_value') return 'Valor inválido. Use um número inteiro de 1 a 7.';
    }
    return 'Não consegui atualizar o Hexágono agora.';
}

module.exports = {
    nome: `${COMMAND_PREFIX}sethexagono`,
    aliases: [`${COMMAND_PREFIX}sethexágono`],
    descricao: 'Ajusta um lado do Hexágono de Mana de um player.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode ajustar Hexágono.',
            });
            return;
        }

        const { targetId, rest } = resolveTargetAndRest(body, m);
        if (!targetId) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        const resolved = await resolveTargetPlayer(db, targetId, '', { mechanical: true });
        const player = resolved.ok ? resolved.player : null;
        if (!player) {
            await sendReply({ sock, idChat, m, text: resolved.error || 'Player nao encontrado no banco.' });
            return;
        }

        const parsed = parseSetArgs(rest);
        const side = normalizeSide(parsed.side);
        if (!side || !Number.isInteger(parsed.value) || parsed.value < 1 || parsed.value > 7 || parsed.reason.length < 3) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        try {
            const result = await setHexagonSide(
                db,
                player.id,
                side,
                parsed.value,
                idJogador,
                parsed.reason
            );

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [player.id],
                text: [
                    'Hexágono atualizado.',
                    '',
                    `*Player:* ${formatMention(player.id)}`,
                    `*Lado:* ${result.sideLabel}`,
                    `*Valor:* ${result.oldValue} → ${result.newValue}`,
                    `*Motivo:* ${result.reason}`,
                    `*Ledger:* #${result.ledgerId}`,
                    '',
                    'O bot não aprova técnica; apenas registrou o ajuste informado pelo ADM.',
                ].join('\n'),
            });
        } catch (error) {
            await sendReply({ sock, idChat, m, text: renderServiceError(error) });
        }
    },
};
