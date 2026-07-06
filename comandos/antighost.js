const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const {
    canManagePlayer,
    formatMention,
    getPlayerById,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    activateAntiGhost,
    deactivateAntiGhost,
    getAntiGhostDeliveryAudit,
    getAntiGhostStatus,
    listCandidates,
    removePlayerForAntiGhost,
    renderCandidatesList,
    renderDeliveryAudit,
    renderPlayerActivityStatus,
    renderStatusMessage,
    resetPlayerActivity,
    runAntiGhostSweep,
    setExemption,
    syncCommunityMembership,
} = require('../helpers/clover/antiGhostService');

function normalizeAction(value) {
    const text = String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (['ativar', 'on', 'ligar'].includes(text)) return 'activate';
    if (['desativar', 'off', 'desligar'].includes(text)) return 'deactivate';
    if (['status', 'ver'].includes(text)) return 'status';
    if (['varrer', 'checar', 'verificar'].includes(text)) return 'sweep';
    if (['avisar', 'aviso'].includes(text)) return 'warn';
    if (['envios', 'enviados', 'auditoria', 'log', 'logs', 'historico', 'histórico'].includes(text)) return 'deliveries';
    if ([
        'sincronizar',
        'sincronizarcomunidade',
        'sync',
        'synccomunidade',
        'comunidade',
        'verificarcomunidade',
    ].includes(text)) return 'sync_community';
    if (['candidatos', 'lista', 'remocao', 'remoção'].includes(text)) return 'candidates';
    if (['remover', 'removermanual', 'banir', 'apagar'].includes(text)) return 'remove';
    if (['pular', 'isentar', 'pausar'].includes(text)) return 'exempt';
    if (['resetar', 'reset', 'zerar'].includes(text)) return 'reset';
    return text || 'status';
}

function splitAction(body) {
    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    const action = normalizeAction(parts.shift() || 'status');
    return { action, rest: parts.join(' ') };
}

async function requireManager({ sock, idChat, idJogador }) {
    if (await canManagePlayer(sock, idChat, idJogador)) return true;
    return false;
}

async function resolveTarget({ db, body, m, idJogador }) {
    const targetData = resolveTargetAndRest(body, m);
    if (targetData.source === 'none') {
        const player = await getPlayerById(db, idJogador);
        if (!player) return { ok: false, error: 'Não encontrei seu personagem no banco.' };
        return { ok: true, player, rest: '' };
    }
    const resolved = await resolveTargetPlayer(db, targetData.targetId, targetData.targetText);
    return { ...resolved, rest: targetData.rest || '' };
}

function parseDaysAndReason(rest, fallbackDays = 30) {
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    let days = fallbackDays;
    if (parts[0]) {
        const match = parts[0].match(/^(\d+)(d|dia|dias)?$/i);
        if (match) {
            days = Number(match[1]);
            parts.shift();
        }
    }
    return {
        days,
        reason: parts.join(' ').trim() || 'ausência avisada',
    };
}

module.exports = {
    nome: `${COMMAND_PREFIX}antighost`,
    aliases: [
        `${COMMAND_PREFIX}anti`,
        `${COMMAND_PREFIX}ghost`,
        `${COMMAND_PREFIX}atividade`,
        `${COMMAND_PREFIX}presente`,
        `${COMMAND_PREFIX}atividadeadm`,
    ],
    descricao: 'Controla anti-ghost, avisos de inatividade e remoções manuais.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const { action, rest } = splitAction(body);
        const manager = await requireManager({ sock, idChat, idJogador });
        const playerActions = new Set(['status']);

        if (!manager && !playerActions.has(action)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar esse comando.' });
            return;
        }

        if (action === 'activate') {
            const result = await activateAntiGhost({ db, sendInitialNotices: false });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃ANTI-GHOST ATIVADO 𖥔 CLOVER MULTICOLOR*',
                    '     ── controle de atividade iniciado ──',
                    '',
                    'O fluxo de atividade foi ativado.',
                    '',
                    `*Players acompanhados:* ${result.players}`,
                    '*PVs iniciais:* pulados por segurança.',
                    '> Isso evita derrubar a conexão com envio em massa.',
                    '',
                    `Use *${COMMAND_PREFIX}antighost avisar* para rodar avisos por inatividade.`,
                    `Use *${COMMAND_PREFIX}antighost status* para acompanhar.`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'deactivate') {
            await deactivateAntiGhost(db);
            await sendReply({
                sock,
                idChat,
                m,
                text: '*♧┃ANTI-GHOST DESATIVADO 𖥔 CLOVER MULTICOLOR*\n     ── fluxo pausado ──\n\nO anti-ghost foi desativado.',
            });
            return;
        }

        if (action === 'sweep' || action === 'warn') {
            const result = await runAntiGhostSweep({ sock, db, force: action === 'warn' });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
                    '     ── varredura concluída ──',
                    '',
                    `*Checados:* ${result.checked || 0}`,
                    `*PVs enviados:* ${result.sent || 0}`,
                    `*Falhas:* ${result.failed || 0}`,
                    `*Candidatos:* ${result.candidates?.length || 0}`,
                    `*Bônus criados:* ${result.bonuses || 0}`,
                    '',
                    `*Seguros/pulados:* ${result.skipped?.safe || 0}`,
                    `*Isentos:* ${result.skipped?.exempt || 0}`,
                    `*Já avisados:* ${result.skipped?.repeat || 0}`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'candidates') {
            const items = await listCandidates(db);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: items.map((item) => item.player.id),
                text: renderCandidatesList(items),
            });
            return;
        }

        if (action === 'deliveries') {
            const limitMatch = rest.match(/\b(\d{1,2})\b/);
            const audit = await getAntiGhostDeliveryAudit(db, {
                limit: limitMatch ? Number(limitMatch[1]) : 20,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderDeliveryAudit(audit),
            });
            return;
        }

        if (action === 'sync_community') {
            const result = await syncCommunityMembership({ sock, db });
            if (!result.ok) {
                const reason = result.reason === 'missing_community_group'
                    ? `Grupo de avisos/comunidade não configurado. Use *${COMMAND_PREFIX}setgrupoavisos* no grupo correto.`
                    : result.reason === 'no_identity_matches'
                        ? [
                            'Sincronização abortada por segurança.',
                            '',
                            `*Membros no grupo:* ${result.participants || 0}`,
                            `*Players acompanhados:* ${result.players || 0}`,
                            '',
                            'Não consegui casar nenhum membro do grupo com os players do banco.',
                            'Isso pode acontecer quando o WhatsApp entrega só LID sem mapa suficiente.',
                        ].join('\n')
                        : `Não consegui sincronizar agora: ${result.reason || 'erro desconhecido'}.`;
                await sendReply({ sock, idChat, m, text: reason });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
                    '     ── comunidade sincronizada ──',
                    '',
                    `*Grupo:* ${result.groupName || result.groupId}`,
                    `*Membros no grupo:* ${result.participants}`,
                    `*Players acompanhados:* ${result.players}`,
                    '',
                    `*Marcados como dentro:* ${result.member}`,
                    `*Marcados como fora:* ${result.out}`,
                    `*Alterados:* ${result.changed}`,
                    `*Sem mudança:* ${result.unchanged}`,
                    result.samples?.out?.length
                        ? ['', '*Primeiros fora:*', ...result.samples.out.map((name) => `> ${name}`)].join('\n')
                        : null,
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        if (action === 'remove') {
            const target = await resolveTarget({ db, body: rest, m, idJogador });
            if (!target.ok) {
                await sendReply({ sock, idChat, m, text: target.error });
                return;
            }
            const result = await removePlayerForAntiGhost({
                sock,
                db,
                player: target.player,
                moderatorId: idJogador,
                reason: target.rest || 'remoção manual anti-ghost',
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [target.player.id],
                text: [
                    '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
                    '     ── remoção registrada ──',
                    '',
                    `*Player:* ${playerDisplayName(target.player, target.player.id)} (${formatMention(target.player.id)})`,
                    `*Backup:* ${result.archive?.backupPath || 'não informado'}`,
                    `*Comunidade:* ${result.community?.ok ? 'removido' : `falha: ${result.community?.reason || 'não removido'}`}`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'exempt') {
            const target = await resolveTarget({ db, body: rest, m, idJogador });
            if (!target.ok) {
                await sendReply({ sock, idChat, m, text: target.error });
                return;
            }
            const parsed = parseDaysAndReason(target.rest, 30);
            const result = await setExemption(db, target.player.id, parsed.days, parsed.reason);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [target.player.id],
                text: [
                    '*♧┃PAUSA REGISTRADA 𖥔 CLOVER MULTICOLOR*',
                    '     ── ausência avisada ──',
                    '',
                    `*Player:* ${playerDisplayName(target.player, target.player.id)} (${formatMention(target.player.id)})`,
                    `*Até:* ${result.until}`,
                    `*Motivo:* ${parsed.reason}`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'reset') {
            const target = await resolveTarget({ db, body: rest, m, idJogador });
            if (!target.ok) {
                await sendReply({ sock, idChat, m, text: target.error });
                return;
            }
            await resetPlayerActivity(db, target.player.id, target.rest || 'reset manual');
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [target.player.id],
                text: [
                    '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
                    '     ── atividade resetada ──',
                    '',
                    `*Player:* ${playerDisplayName(target.player, target.player.id)} (${formatMention(target.player.id)})`,
                    '> O risco de inatividade foi limpo manualmente.',
                ].join('\n'),
            });
            return;
        }

        if (manager && rest) {
            const target = await resolveTarget({ db, body: rest, m, idJogador });
            if (target.ok && !isSameUser(target.player.id, idJogador)) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [target.player.id],
                    text: await renderPlayerActivityStatus(db, target.player),
                });
                return;
            }
        }

        if (manager) {
            const status = await getAntiGhostStatus(db);
            await sendReply({ sock, idChat, m, text: renderStatusMessage(status) });
            return;
        }

        const self = await getPlayerById(db, idJogador);
        if (!self) {
            await sendReply({ sock, idChat, m, text: 'Não encontrei seu personagem no banco.' });
            return;
        }
        await sendReply({ sock, idChat, m, text: await renderPlayerActivityStatus(db, self) });
    },
};
