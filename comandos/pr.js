'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { isConfiguredCloverGroup } = require('../helpers/clover/groupManager');
const {
    configureRecruitmentEvent,
    serializeEvent,
} = require('../helpers/clover/recruitmentService');
const {
    PrServiceError,
    addGroupPromotionPr,
    getPrSummary,
} = require('../helpers/clover/prService');
const { resolveTargetPlayer } = require('../helpers/clover/targetResolver');

const GRANT_ACTIONS = new Set(['dar', 'add', 'adicionar', 'conceder', 'aprovar']);

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

function parseGrant(body, contextInfo = {}) {
    const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
    const action = String(tokens[0] || '').toLowerCase();
    if (!GRANT_ACTIONS.has(action)) return { grant: false };
    const amount = Number(tokens[1]);
    if (!Number.isInteger(amount) || amount <= 0) return { grant: true, error: 'Informe uma quantidade positiva de PR.' };

    const mentions = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid.filter(Boolean) : [];
    const quotedParticipant = contextInfo.participant || contextInfo.remoteJid || null;
    if (mentions.length > 1) return { grant: true, error: 'Marque apenas um player.' };

    let targetId = mentions[0] || quotedParticipant || null;
    let targetText = null;
    let reasonStart = 2;
    if (!targetId) {
        targetText = tokens[2] || '';
        reasonStart = 3;
    } else if (mentions.length) {
        reasonStart = tokens[2]?.startsWith('@') ? 3 : 2;
    }
    const reason = tokens.slice(reasonStart).join(' ').trim() || 'Comprovação de divulgação em grupos aprovada.';
    return { grant: true, amount, targetId, targetText, quotedParticipant, reason };
}

function renderSummary(summary) {
    return [
        '*♧┃𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐂𝐑𝐔𝐓𝐀𝐌𝐄𝐍𝐓𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Saldo:* ${summary.balance} PR`,
        `*Divulgação em grupos:* ${summary.groupWeekEarned}/${summary.groupWeekLimit} PR nesta semana`,
        `*Restante do limite:* ${summary.groupWeekRemaining} PR`,
        '',
        summary.shopEnabled
            ? '*Loja:* disponível.'
            : '*Loja:* temporariamente indisponível; seus pontos não expiram.',
    ].join('\n');
}

function renderGrant(result, target, actorId, reason) {
    return [
        '*♧┃𝐃𝐈𝐕𝐔𝐋𝐆𝐀𝐂̧𝐀̃𝐎 𝐀𝐏𝐑𝐎𝐕𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Player:* @${String(target.id).split('@')[0]}`,
        `*Personagem:* ${target.personagem_nome || target.nome || target.display_name || '-'}`,
        '*Origem:* Divulgação em grupos',
        `*Crédito:* +${result.amount} PR`,
        `*Semana:* ${result.summary.groupWeekEarned}/${result.summary.groupWeekLimit} PR`,
        `*Saldo total:* ${result.summary.balance} PR`,
        `*Comprovação:* ${reason}`,
        `*Aprovado por:* @${String(actorId).split('@')[0]}`,
    ].join('\n');
}

function renderEvent(eventRow) {
    const event = serializeEvent(eventRow);
    return [
        '*♧┃𝐄𝐕𝐄𝐍𝐓𝐎 𝐃𝐄 𝐃𝐈𝐕𝐔𝐋𝐆𝐀𝐂̧𝐀̃𝐎 𖥔 𝐀𝐃𝐌*',
        '',
        `*Status:* ${event.status}`,
        `*Início:* ${event.startsAt || '-'}`,
        `*Fim:* ${event.endsAt || '-'}`,
        `*Duração:* ${event.durationDays} dias`,
        `*Limite em grupos:* ${event.groupWeeklyPrLimit} PR por semana`,
        `*Recrutamento:* ${event.recruiterPrReward} PR`,
        `*Loja:* ${event.shop.enabled ? 'disponível' : 'temporariamente indisponível'}`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}pr`,
    aliases: [
        `${COMMAND_PREFIX}pontosrecrutamento`,
        `${COMMAND_PREFIX}pontos recrutamento`,
        `${COMMAND_PREFIX}pontosdivulgacao`,
    ],
    descricao: 'Consulta PR ou registra divulgação em grupos.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const bodyTokens = String(body || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (bodyTokens[0] === 'evento') {
            if (!isOwner(idJogador)) {
                await sendReply({ sock, idChat, m, text: 'Apenas a dona do bot pode alterar o estado do evento.' });
                return;
            }
            const action = bodyTokens[1] || 'status';
            let event;
            if (action === 'ativar') {
                event = await configureRecruitmentEvent(db, { status: 'active', startsAt: new Date() });
            } else if (action === 'pausar') {
                event = await configureRecruitmentEvent(db, { status: 'paused' });
            } else if (action === 'encerrar') {
                event = await configureRecruitmentEvent(db, { status: 'ended' });
            } else if (action === 'status') {
                event = await configureRecruitmentEvent(db, {});
            } else {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: `Use *${COMMAND_PREFIX}pr evento status*, *ativar*, *pausar* ou *encerrar*.`,
                });
                return;
            }
            await sendReply({ sock, idChat, m, text: renderEvent(event) });
            return;
        }
        const contextInfo = getMessageContextInfo(m) || {};
        const request = parseGrant(body, contextInfo);
        if (!request.grant) {
            await sendReply({ sock, idChat, m, text: renderSummary(await getPrSummary(db, idJogador)) });
            return;
        }
        if (request.error) {
            await sendReply({ sock, idChat, m, text: request.error });
            return;
        }
        if (!String(idChat || '').endsWith('@g.us') || !await isConfiguredCloverGroup(db, 'on', idChat)) {
            await sendReply({ sock, idChat, m, text: 'A concessão de PR só funciona no grupo ON configurado.' });
            return;
        }
        if (!isOwner(idJogador) && !await isGroupAdmin(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ON pode aprovar PR de divulgação.' });
            return;
        }

        const targetResult = await resolveTargetPlayer(db, request.targetId, request.targetText, {
            quotedParticipant: request.quotedParticipant,
            mechanical: true,
            playerFilter: (player) => String(player?.jogo_status || '').toLowerCase() === 'liberado',
        });
        if (!targetResult.ok) {
            await sendReply({ sock, idChat, m, text: targetResult.error || 'Não encontrei o player da divulgação.' });
            return;
        }

        try {
            const messageId = m?.key?.id || `${Date.now()}`;
            const result = await addGroupPromotionPr(
                db,
                targetResult.player.id,
                request.amount,
                request.reason,
                idJogador,
                {
                    relatedId: `${idChat}:${messageId}`,
                    idempotencyKey: `pr:group:${idChat}:${messageId}`,
                    metadata: {
                        chat_id: idChat,
                        message_id: messageId,
                        quoted_message_id: contextInfo.stanzaId || null,
                    },
                }
            );
            result.summary = await getPrSummary(db, targetResult.player.id);
            await sendReply({
                sock,
                idChat,
                m,
                text: renderGrant(result, targetResult.player, idJogador, request.reason),
                mentions: [targetResult.player.id, idJogador],
            });
        } catch (error) {
            if (error instanceof PrServiceError && error.code === 'weekly_group_limit_exceeded') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: `Esse lançamento ultrapassa o limite semanal. Restam ${error.details.remaining} PR para o player nesta semana.`,
                });
                return;
            }
            throw error;
        }
    },
    parseGrant,
    renderGrant,
    renderEvent,
    renderSummary,
};
