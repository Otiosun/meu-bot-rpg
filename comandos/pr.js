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
    getEvent,
    getPrSummary,
} = require('../helpers/clover/prService');
const {
    GROUP_PR_RATE,
    GROUP_WEEKLY_LIMIT,
    RecruitmentGroupServiceError,
    getGroupPromotionDashboard,
    recordGroupPromotion,
} = require('../helpers/clover/recruitmentGroupService');
const { resolveTargetPlayer } = require('../helpers/clover/targetResolver');

const GRANT_ACTIONS = new Set(['dar', 'add', 'adicionar', 'conceder', 'aprovar']);
const GROUP_ACTIONS = new Set(['grupo', 'grupos', 'registrargrupos', 'registrar-grupos']);

function formatPr(value) {
    const amount = Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
    return amount.toLocaleString('pt-BR', {
        minimumFractionDigits: Number.isInteger(amount) ? 0 : 1,
        maximumFractionDigits: 1,
    });
}

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

function parseTarget(tokens, contextInfo, amountIndex = 1) {
    const mentions = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid.filter(Boolean) : [];
    const quotedParticipant = contextInfo.participant || contextInfo.remoteJid || null;
    if (mentions.length > 1) return { error: 'Marque apenas um player.' };

    let targetId = mentions[0] || quotedParticipant || null;
    let targetText = null;
    let reasonStart = amountIndex + 1;
    if (!targetId) {
        targetText = tokens[amountIndex + 1] || '';
        reasonStart = amountIndex + 2;
    } else if (mentions.length) {
        reasonStart = tokens[amountIndex + 1]?.startsWith('@') ? amountIndex + 2 : amountIndex + 1;
    }
    return { targetId, targetText, quotedParticipant, reasonStart };
}

function parseGroupReport(body, contextInfo = {}) {
    const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
    const action = String(tokens[0] || '').toLowerCase();
    if (!GROUP_ACTIONS.has(action)) return { groupReport: false };
    const groups = Number(tokens[1]);
    if (!Number.isInteger(groups) || groups <= 0) {
        return { groupReport: true, error: 'Informe uma quantidade positiva de grupos.' };
    }
    const target = parseTarget(tokens, contextInfo, 1);
    if (target.error) return { groupReport: true, error: target.error };
    const reason = tokens.slice(target.reasonStart).join(' ').trim()
        || `Comprovação de divulgação em ${groups} grupos.`;
    return { groupReport: true, groups, reason, ...target };
}

function parseGrant(body, contextInfo = {}) {
    const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
    const action = String(tokens[0] || '').toLowerCase();
    if (!GRANT_ACTIONS.has(action)) return { grant: false };
    const amount = Number(tokens[1]);
    if (!Number.isInteger(amount) || amount <= 0) return { grant: true, error: 'Informe uma quantidade positiva de PR.' };
    const target = parseTarget(tokens, contextInfo, 1);
    if (target.error) return { grant: true, error: target.error };
    const reason = tokens.slice(target.reasonStart).join(' ').trim() || 'Comprovação de divulgação em grupos aprovada.';
    return { grant: true, amount, reason, ...target };
}

function renderSummary(summary, groups) {
    return [
        '*♧┃𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐂𝐑𝐔𝐓𝐀𝐌𝐄𝐍𝐓𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Saldo:* ${formatPr(summary.balance)} PR`,
        `*Grupos informados:* ${groups.groupsReported} nesta semana`,
        `*Grupos remunerados:* ${groups.groupsCredited}/${groups.groupLimit}`,
        `*Grupos excedentes preservados:* ${groups.groupsExcess}`,
        `*PR por grupos:* ${formatPr(groups.prEarned)}/${formatPr(groups.prLimit)} PR`,
        `*Restante remunerável:* ${groups.groupsRemaining} grupos · ${formatPr(groups.prRemaining)} PR`,
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
        '*Origem:* Ajuste manual de PR por divulgação',
        `*Crédito:* +${formatPr(result.amount)} PR`,
        `*Semana:* ${formatPr(result.summary.groupWeekEarned)}/${formatPr(result.summary.groupWeekLimit)} PR`,
        `*Saldo total:* ${formatPr(result.summary.balance)} PR`,
        `*Comprovação:* ${reason}`,
        `*Aprovado por:* @${String(actorId).split('@')[0]}`,
    ].join('\n');
}

function renderGroupGrant(result, target, actorId, reason) {
    const row = result.submission;
    const summary = result.summary;
    return [
        '*♧┃𝐆𝐑𝐔𝐏𝐎𝐒 𝐑𝐄𝐆𝐈𝐒𝐓𝐑𝐀𝐃𝐎𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Player:* @${String(target.id).split('@')[0]}`,
        `*Personagem:* ${target.personagem_nome || target.nome || target.display_name || '-'}`,
        `*Grupos informados agora:* ${Number(row.groups_reported)}`,
        `*Grupos remunerados agora:* ${Number(row.groups_credited)}`,
        `*Excedente preservado agora:* ${Number(row.groups_excess)}`,
        `*Crédito:* +${formatPr(row.pr_awarded)} PR`,
        '',
        `*Semana:* ${summary.groupsCredited}/${summary.groupLimit} grupos remunerados`,
        `*Total informado:* ${summary.groupsReported} grupos`,
        `*Excedente acumulado:* ${summary.groupsExcess} grupos`,
        `*PR semanal:* ${formatPr(summary.prEarned)}/${formatPr(summary.prLimit)} PR`,
        `*Saldo total:* ${formatPr(summary.balance)} PR`,
        `*Comprovação:* ${reason}`,
        `*Aprovado por:* @${String(actorId).split('@')[0]}`,
        result.duplicate ? '' : null,
        result.duplicate ? '> Este lançamento já havia sido processado. Nenhum valor foi duplicado.' : null,
    ].filter((line) => line !== null).join('\n');
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
        `*Grupos:* ${formatPr(GROUP_PR_RATE)} PR por grupo`,
        `*Teto semanal:* ${GROUP_WEEKLY_LIMIT} grupos · ${formatPr(event.groupWeeklyPrLimit)} PR`,
        `*Recrutamento:* ${formatPr(event.recruiterPrReward)} PR`,
        `*Loja:* ${event.shop.enabled ? 'disponível' : 'temporariamente indisponível'}`,
    ].join('\n');
}

async function validateApprovalContext({ sock, idChat, idJogador, db }) {
    if (!String(idChat || '').endsWith('@g.us') || !await isConfiguredCloverGroup(db, 'on', idChat)) {
        return 'A aprovação de divulgação só funciona no grupo ON configurado.';
    }
    if (!isOwner(idJogador) && !await isGroupAdmin(sock, idChat, idJogador)) {
        return 'Apenas ADM do grupo ON pode aprovar divulgação.';
    }
    return null;
}

async function resolveReleasedTarget(db, request) {
    return resolveTargetPlayer(db, request.targetId, request.targetText, {
        quotedParticipant: request.quotedParticipant,
        mechanical: true,
        playerFilter: (player) => String(player?.jogo_status || '').toLowerCase() === 'liberado',
    });
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
            if (action === 'ativar' || action === 'retomar') {
                const current = await getEvent(db);
                if (current.status === 'ended') {
                    await sendReply({ sock, idChat, m, text: 'Esse evento já foi encerrado e não pode ser reativado.' });
                    return;
                }
                if (current.status === 'active') {
                    event = current;
                } else if (current.status === 'paused') {
                    event = await configureRecruitmentEvent(db, { status: 'active' });
                } else {
                    event = await configureRecruitmentEvent(db, { status: 'active', startsAt: new Date() });
                }
            } else if (action === 'pausar') {
                event = await configureRecruitmentEvent(db, { status: 'paused' });
            } else if (action === 'encerrar') {
                event = await configureRecruitmentEvent(db, { status: 'ended' });
            } else if (action === 'limite') {
                const limit = Number(bodyTokens[2]);
                if (!Number.isInteger(limit) || limit < 0 || limit > 500) {
                    await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}pr evento limite <0 a 500>*.` });
                    return;
                }
                event = await configureRecruitmentEvent(db, { groupWeeklyPrLimit: limit });
            } else if (action === 'status') {
                event = await configureRecruitmentEvent(db, {});
            } else {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: `Use *${COMMAND_PREFIX}pr evento status*, *ativar*, *pausar*, *retomar*, *encerrar* ou *limite <PR>*.`,
                });
                return;
            }
            await sendReply({ sock, idChat, m, text: renderEvent(event) });
            return;
        }

        const contextInfo = getMessageContextInfo(m) || {};
        const groupRequest = parseGroupReport(body, contextInfo);
        if (groupRequest.groupReport) {
            if (groupRequest.error) {
                await sendReply({ sock, idChat, m, text: groupRequest.error });
                return;
            }
            const contextError = await validateApprovalContext({ sock, idChat, idJogador, db });
            if (contextError) {
                await sendReply({ sock, idChat, m, text: contextError });
                return;
            }
            const targetResult = await resolveReleasedTarget(db, groupRequest);
            if (!targetResult.ok) {
                await sendReply({ sock, idChat, m, text: targetResult.error || 'Não encontrei o player da divulgação.' });
                return;
            }
            try {
                const messageId = m?.key?.id || `${Date.now()}`;
                const result = await recordGroupPromotion(
                    db,
                    targetResult.player.id,
                    groupRequest.groups,
                    groupRequest.reason,
                    idJogador,
                    {
                        relatedId: `${idChat}:${messageId}`,
                        idempotencyKey: `groups:${idChat}:${messageId}`,
                        metadata: {
                            chat_id: idChat,
                            message_id: messageId,
                            quoted_message_id: contextInfo.stanzaId || null,
                        },
                    }
                );
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderGroupGrant(result, targetResult.player, idJogador, groupRequest.reason),
                    mentions: [targetResult.player.id, idJogador],
                });
            } catch (error) {
                if (error instanceof RecruitmentGroupServiceError) {
                    await sendReply({ sock, idChat, m, text: error.message });
                    return;
                }
                throw error;
            }
            return;
        }

        const request = parseGrant(body, contextInfo);
        if (!request.grant) {
            const [summary, groups] = await Promise.all([
                getPrSummary(db, idJogador),
                getGroupPromotionDashboard(db, idJogador),
            ]);
            await sendReply({ sock, idChat, m, text: renderSummary(summary, groups) });
            return;
        }
        if (request.error) {
            await sendReply({ sock, idChat, m, text: request.error });
            return;
        }
        const contextError = await validateApprovalContext({ sock, idChat, idJogador, db });
        if (contextError) {
            await sendReply({ sock, idChat, m, text: contextError });
            return;
        }
        const targetResult = await resolveReleasedTarget(db, request);
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
                        legacy_direct_pr: true,
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
            if (error instanceof PrServiceError && error.code === 'event_not_active') {
                await sendReply({ sock, idChat, m, text: 'O evento de divulgação está pausado, em rascunho ou encerrado.' });
                return;
            }
            if (error instanceof PrServiceError && error.code === 'weekly_group_limit_exceeded') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: `Esse lançamento ultrapassa o limite semanal. Restam ${formatPr(error.details.remaining)} PR para o player nesta semana.`,
                });
                return;
            }
            throw error;
        }
    },
    formatPr,
    parseGrant,
    parseGroupReport,
    renderEvent,
    renderGrant,
    renderGroupGrant,
    renderSummary,
};
