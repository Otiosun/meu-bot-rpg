const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    cancelDeliveryJob,
    getDeliveryStats,
    listRecentDeliveryJobs,
    retryDeliveryJob,
} = require('../helpers/clover/deliveryService');

function parseArgs(body) {
    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    return {
        action: String(parts.shift() || 'status').toLowerCase(),
        id: Number(parts.shift() || 0),
    };
}

function renderJobLine(job) {
    const target = String(job.target_jid || job.group_id || '-').replace(/@.+$/, '');
    const error = job.last_error ? ` | erro: ${String(job.last_error).slice(0, 80)}` : '';
    return `#${job.id} ${job.status} ${job.kind} -> ${target} (${job.attempts}/${job.max_attempts})${error}`;
}

async function renderStatus(db) {
    const stats = await getDeliveryStats(db);
    const recent = await listRecentDeliveryJobs(db, 10);
    return [
        '*♧┃ENTREGAS AUXILIARES 𖥔 CLOVER MULTICOLOR*',
        '     ── ponte Clover + Mudzap ──',
        '',
        '_`─( ✓ )───── Status`_',
        '',
        `*Pendentes:* ${stats.pending}`,
        `*Processando:* ${stats.processing}`,
        `*Enviadas:* ${stats.sent}`,
        `*Falhas:* ${stats.failed}`,
        `*Canceladas:* ${stats.cancelled}`,
        '',
        '_`─( ◆ )───── Recentes`_',
        '',
        recent.length ? recent.map(renderJobLine).join('\n') : '> Nenhuma entrega registrada ainda.',
        '',
        '_`─( ✦ )───── Ações`_',
        '',
        `*${COMMAND_PREFIX}entregas reenviar <id>*`,
        `*${COMMAND_PREFIX}entregas cancelar <id>*`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}entregas`,
    aliases: [
        `${COMMAND_PREFIX}delivery`,
        `${COMMAND_PREFIX}deliveryqueue`,
        `${COMMAND_PREFIX}carteiro`,
        `${COMMAND_PREFIX}filaentregas`,
    ],
    descricao: 'Mostra e controla a fila auxiliar de PV/convites do Mudzap.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!isOwner(idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode ver as entregas auxiliares.' });
            return;
        }

        const { action, id } = parseArgs(body);
        if (['reenviar', 'retry', 'reprocessar'].includes(action)) {
            if (!id) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}entregas reenviar <id>*.` });
                return;
            }
            const result = await retryDeliveryJob(db, id);
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok ? `Entrega #${id} voltou para a fila.` : `Não encontrei entrega #${id} em estado reenviável.`,
            });
            return;
        }

        if (['cancelar', 'cancel', 'apagar'].includes(action)) {
            if (!id) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}entregas cancelar <id>*.` });
                return;
            }
            const result = await cancelDeliveryJob(db, id);
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok ? `Entrega #${id} cancelada.` : `Não encontrei entrega #${id} cancelável.`,
            });
            return;
        }

        await sendReply({ sock, idChat, m, text: await renderStatus(db) });
    },
};
