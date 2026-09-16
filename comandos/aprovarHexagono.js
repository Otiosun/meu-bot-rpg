const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const { approvePendingHexagonUpgrade } = require('../helpers/clover/hexagonService');

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

function resolveTargetAndReason(body, m) {
    const mentions = getMentions(m);
    if (mentions.length) {
        return {
            targetId: mentions[0],
            reason: String(body || '').replace(/@\S+/g, '').trim(),
        };
    }

    const quoted = getQuotedParticipant(m);
    if (quoted) {
        return { targetId: quoted, reason: String(body || '').trim() };
    }

    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    const targetId = jidFromToken(parts[0]);
    return {
        targetId,
        reason: targetId ? parts.slice(1).join(' ').trim() : '',
    };
}

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function renderUsage() {
    return [
        'Use:',
        `*̣${COMMAND_PREFIX}aprovarhexagono @player <motivo>*`,
        '',
        `Exemplo: *̣${COMMAND_PREFIX}aprovarhexagono @Maksim treino narrativo aprovado*`,
    ].join('\n');
}

function renderFailure(result) {
    if (result?.reason === 'expired_pending') {
        return [
            '♧ 𝐏𝐄𝐃𝐈𝐃𝐎 𝐄𝐗𝐏𝐈𝐑𝐀𝐃𝐎',
            '',
            'O pedido de up do Hexágono expirou.',
        ].join('\n');
    }

    if (result?.reason === 'stale_pending') {
        return [
            '♧ 𝐏𝐄𝐃𝐈𝐃𝐎 𝐃𝐄𝐒𝐀𝐓𝐔𝐀𝐋𝐈𝐙𝐀𝐃𝐎',
            '',
            'O Hexágono mudou depois que esse pedido foi criado.',
            'Peça para o player abrir um pedido novo.',
        ].join('\n');
    }

    return [
        '♧ 𝐒𝐄𝐌 𝐏𝐄𝐃𝐈𝐃𝐎 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄',
        '',
        'Esse player não tem up de Hexágono pendente.',
    ].join('\n');
}

function renderSuccess(targetId, result) {
    const pending = result.pending;
    return [
        '♧ 𝐇𝐄𝐗𝐀́𝐆𝐎𝐍𝐎 𝐀𝐏𝐑𝐎𝐕𝐀𝐃𝐎',
        '',
        `*Player:* ${formatMention(targetId)}`,
        `*Lado:* ${pending.sideLabel}`,
        `*Valor:* ${pending.oldValue}/7 → ${pending.newValue}/7`,
        `*PH gasto:* ${pending.cost}`,
        `*PH restante:* ${result.spend.after.phAvailable}`,
        `*Ledger:* #${result.ledgerId}`,
        '',
        '──  𝐄𝐅𝐄𝐈𝐓𝐎  ──',
        `> ${pending.oldLimitLabel} → ${pending.newLimitLabel}`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}aprovarhexagono`,
    aliases: [`${COMMAND_PREFIX}aprovarhexágono`],
    descricao: 'Aprova um up pendente do Hexágono de Mana.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode aprovar Hexágono.',
            });
            return;
        }

        const { targetId, reason } = resolveTargetAndReason(body, m);
        if (!targetId) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [targetId]);
        if (!player) {
            await sendReply({ sock, idChat, m, text: 'Player não encontrado no banco.' });
            return;
        }

        try {
            const result = await approvePendingHexagonUpgrade(db, targetId, idJogador, reason);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [targetId],
                text: result.ok ? renderSuccess(targetId, result) : renderFailure(result),
            });
        } catch (error) {
            if (error?.code === 'insufficient_ph') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [targetId],
                    text: [
                        '♧ 𝐏𝐇 𝐈𝐍𝐒𝐔𝐅𝐈𝐂𝐈𝐄𝐍𝐓𝐄',
                        '',
                        `${formatMention(targetId)} não tem PH disponível suficiente para esse up.`,
                    ].join('\n'),
                });
                return;
            }
            throw error;
        }
    },
};
