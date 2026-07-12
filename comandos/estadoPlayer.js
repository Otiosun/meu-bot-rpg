const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    formatMention,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const { getPlayerLifecycleState } = require('../helpers/clover/playerLifecycleService');

function statusLabel(value) {
    const labels = {
        active: 'ativo',
        archived: 'arquivado',
        reactivation_pending: 'reativação pendente',
    };
    return labels[value] || value || 'ativo';
}

function eventLabel(value) {
    if (value === 'archive') return 'arquivamento';
    if (value === 'reactivate') return 'reativação';
    return value || '-';
}

module.exports = {
    nome: `${COMMAND_PREFIX}estadoplayer`,
    aliases: [
        `${COMMAND_PREFIX}ciclovida`,
        `${COMMAND_PREFIX}statusadminplayer`,
    ],
    descricao: 'Owner: mostra estado de arquivamento, reservas e fila de um player.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!isOwner(idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode consultar o ciclo de vida completo de um player.' });
            return;
        }

        const { targetId, targetText } = resolveTargetAndRest(body, m);
        const resolved = await resolveTargetPlayer(db, targetId, targetText, {
            allowShadow: true,
        });
        if (!resolved.ok) {
            await sendReply({ sock, idChat, m, text: resolved.error || 'Player não encontrado.' });
            return;
        }

        const state = await getPlayerLifecycleState(db, resolved.player.id);
        if (!state.ok) {
            await sendReply({ sock, idChat, m, text: state.error || 'Não consegui consultar esse player.' });
            return;
        }

        const player = state.player;
        const latest = state.latestEvent;

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [player.id],
            text: [
                '♧┃ESTADO ADMINISTRATIVO 𖥔 CLOVER MULTICOLOR',
                '     ── ciclo de vida do player ──',
                '',
                '_`─( ✓ )───── Cadastro`_',
                '',
                `*Player:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
                `*Player ID:* ${player.id}`,
                `*Ciclo de vida:* ${statusLabel(state.lifecycleStatus)}`,
                `*Jogo:* ${player.jogo_status || '-'}`,
                `*Ficha:* ${player.ficha_status || '-'}`,
                `*Esquadrão:* ${player.esquadrao || '-'}`,
                `*Arquivado em:* ${player.archived_at || '-'}`,
                `*Motivo:* ${player.archive_reason || '-'}`,
                '',
                '_`─( ◆ )───── Vínculos ativos`_',
                '',
                `*Reservas de vaga:* ${state.reservations.length}`,
                `*Entradas na fila:* ${state.queueEntries.length}`,
                `*Cargos de liderança:* ${state.leadership.length}`,
                '',
                '_`─( ◇ )───── Último evento`_',
                '',
                latest ? `*Operação:* ${eventLabel(latest.operation_type)}` : '*Operação:* nenhuma',
                latest ? `*Código:* ${latest.operation_code}` : null,
                latest ? `*Data:* ${latest.created_at}` : null,
                latest ? `*Motivo:* ${latest.reason}` : null,
                '',
                '> Consulta somente leitura.',
            ].filter(Boolean).join('\n'),
        });
    },
};
