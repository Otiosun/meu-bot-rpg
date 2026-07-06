const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const {
    canManagePlayer,
    formatMention,
    getPlayerById,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const {
    getChecklistSummary,
    getWeeklyChecklistNoticeAudit,
    renderChecklist,
    runWeeklyChecklistResetDispatch,
} = require('../helpers/clover/checklistService');

function normalizeAction(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function formatNoticeLine(row) {
    const name = row.personagem_nome || row.display_name || row.nome || row.player_id || '-';
    const delivery = row.delivery_status || 'sem entrega';
    const error = row.last_error ? ` | erro: ${String(row.last_error).slice(0, 70)}` : '';
    return `#${row.id} ${name} · ${row.status}/${delivery} · job ${row.job_id || '-'}${error}`;
}

function renderNoticeAudit(audit) {
    const stats = new Map((audit.stats || []).map((row) => [row.status, Number(row.total || 0)]));
    return [
        '*♧┃CHECKLIST SEMANAL 𖥔 CLOVER MULTICOLOR*',
        '     ── auditoria de avisos ──',
        '',
        '_`─( ✓ )───── Semana`_',
        '',
        `*Semana:* ${audit.weekKey}`,
        `*Enfileirados:* ${stats.get('queued') || 0}`,
        `*Pulados:* ${stats.get('skipped') || 0}`,
        '',
        '_`─( ◆ )───── Recentes`_',
        '',
        audit.recent?.length ? audit.recent.map(formatNoticeLine).join('\n') : '> Nenhum aviso registrado nessa semana.',
    ].join('\n');
}

async function resolveChecklistTarget({ db, body, m, idJogador }) {
    const targetData = resolveTargetAndRest(body, m);
    const hasExplicitTarget = targetData.source !== 'none';

    if (!hasExplicitTarget) {
        const player = await getPlayerById(db, idJogador);
        if (!player) {
            return { ok: false, error: 'Não encontrei seu personagem no banco.' };
        }
        return { ok: true, player, explicit: false };
    }

    const resolved = await resolveTargetPlayer(db, targetData.targetId, targetData.targetText);
    return { ...resolved, explicit: true };
}

module.exports = {
    nome: `${COMMAND_PREFIX}checklist`,
    aliases: [
        `${COMMAND_PREFIX}check`,
        `${COMMAND_PREFIX}semanal`,
        `${COMMAND_PREFIX}mensal`,
        `${COMMAND_PREFIX}streak`,
    ],
    descricao: 'Mostra checklist semanal, mensal e streak do personagem.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const compact = normalizeAction(String(body || '').trim().split(/\s+/)[0] || '');
        if (['avisar', 'aviso', 'disparar', 'enviar', 'reenviar', 'forcar', 'forçar', 'force'].includes(compact)) {
            if (!isOwner(idJogador)) {
                await sendReply({ sock, idChat, m, text: 'Apenas o dono pode disparar avisos semanais.' });
                return;
            }
            const force = ['reenviar', 'forcar', 'forçar', 'force'].includes(compact);
            const result = await runWeeklyChecklistResetDispatch(db, { force, now: new Date() });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃CHECKLIST SEMANAL 𖥔 CLOVER MULTICOLOR*',
                    '     ── avisos enfileirados ──',
                    '',
                    `*Semana:* ${result.weekKey}`,
                    `*Alvos:* ${result.targets}`,
                    `*Novos envios:* ${result.queued}`,
                    `*Já existiam:* ${result.already}`,
                    `*Falhas:* ${result.failed}`,
                    `*Modo:* ${force ? 'reenvio forçado' : 'somente faltantes'}`,
                    '',
                    '> O envio sai pela fila do MudaZap, espaçado para evitar spam.',
                ].join('\n'),
            });
            return;
        }

        if (['envios', 'auditoria', 'logs', 'log'].includes(compact)) {
            if (!isOwner(idJogador)) {
                await sendReply({ sock, idChat, m, text: 'Apenas o dono pode ver auditoria de avisos semanais.' });
                return;
            }
            const audit = await getWeeklyChecklistNoticeAudit(db);
            await sendReply({ sock, idChat, m, text: renderNoticeAudit(audit) });
            return;
        }

        const target = await resolveChecklistTarget({ db, body, m, idJogador });
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error });
            return;
        }

        const ownView = isSameUser(target.player.id, idJogador);
        if (target.explicit && !ownView && !await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode ver checklist de outro player.',
            });
            return;
        }

        if (!target.explicit) {
            const phaseInfo = await getPlayerPhase(db, idJogador);
            if (!phaseInfo.canPlay) {
                await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
                return;
            }
        }

        const summary = await getChecklistSummary(db, target.player.id);
        const label = `${playerDisplayName(target.player, target.player.id)} (${formatMention(target.player.id)})`;

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [target.player.id],
            text: renderChecklist(summary, label),
        });
    },
};
