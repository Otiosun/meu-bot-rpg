const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    applyReopeningCleanup,
    getReopeningCleanupStatus,
} = require('../helpers/clover/reopeningCleanupService');

function normalize(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function header(title, subtitle) {
    return [
        `*♧┃${title} 𖥔 CLOVER MULTICOLOR*`,
        `     ── ${subtitle} ──`,
    ];
}

function renderStepSummary(byStep) {
    if (!byStep?.length) return '> Nenhuma etapa pendente.';
    return byStep
        .slice(0, 10)
        .map(([step, count]) => `> ${step}: ${count}`)
        .join('\n');
}

function renderStatus({ totalPlayers, releasedPlayers, placeholders, summary }, mode = 'STATUS') {
    return [
        ...header(`REABERTURA ${mode}`, mode === 'APLICADA' ? 'limpeza executada' : 'auditoria de entrada'),
        '',
        '_`─( ✓ )───── Protegidos`_',
        '',
        `*Jogo liberado:* ${releasedPlayers}`,
        `*Cadastros totais:* ${totalPlayers}`,
        '',
        '_`─( ! )───── Entrada antiga`_',
        '',
        `*Placeholders:* ${placeholders}`,
        `*Alvos seguros para limpeza:* ${summary.candidates}`,
        `*Rolls antigos:* ${summary.rolls}`,
        `*Roll escolhido preso:* ${summary.selectedRolls}`,
        `*Magia pendente:* ${summary.pendingMagic}`,
        `*Ficha pendente:* ${summary.pendingProfile}`,
        `*Reservas de vaga:* ${summary.slotReservations}`,
        `*Sacrifício de roll:* ${summary.sacrificed}`,
        '',
        '_`─( ◆ )───── Etapas`_',
        '',
        renderStepSummary(summary.byStep),
        '',
        mode === 'STATUS'
            ? `> Use *${COMMAND_PREFIX}reabertura simular* para ver a limpeza.`
            : null,
        mode === 'SIMULAÇÃO'
            ? `> Para aplicar: *${COMMAND_PREFIX}reabertura aplicar confirmar*`
            : null,
    ].filter(Boolean).join('\n');
}

function renderApplied(result) {
    return [
        ...header('REABERTURA APLICADA', 'entrada antiga limpa'),
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Cadastros limpos:* ${result.cleaned}`,
        `*Rolls removidos:* ${result.summaryBefore.rolls}`,
        `*Reservas liberadas:* ${result.summaryBefore.slotReservations}`,
        `*Magias pendentes removidas:* ${result.summaryBefore.pendingMagic}`,
        `*Fichas pendentes removidas:* ${result.summaryBefore.pendingProfile}`,
        '',
        '_`─( ◆ )───── Agora`_',
        '',
        '> Quem estava preso na recepção volta como nova entrada.',
        '> Quem tinha jogo liberado não foi tocado.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}reabertura`,
    aliases: [
        `${COMMAND_PREFIX}reabrir`,
        `${COMMAND_PREFIX}limparrecepcao`,
        `${COMMAND_PREFIX}limparrecepção`,
    ],
    descricao: 'Audita e limpa a recepção antiga antes de reabrir o RPG.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, texto }) => {
        if (!isOwner(idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Apenas o dono pode mexer na reabertura.*',
            });
            return;
        }

        const body = normalize(texto)
            .replace(/^\.?#?(reabertura|reabrir|limparrecepcao)\b/, '')
            .trim();

        if (!body || body === 'status') {
            const status = await getReopeningCleanupStatus(db);
            await sendReply({ sock, idChat, m, text: renderStatus(status) });
            return;
        }

        if (body.startsWith('simular') || body.startsWith('preview')) {
            const status = await getReopeningCleanupStatus(db);
            await sendReply({ sock, idChat, m, text: renderStatus(status, 'SIMULAÇÃO') });
            return;
        }

        if (body.startsWith('aplicar')) {
            if (!body.includes('confirmar')) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        ...header('REABERTURA', 'confirmação necessária'),
                        '',
                        '> Esse comando limpa somente pendentes seguros da recepção antiga.',
                        `> Para aplicar de verdade: *${COMMAND_PREFIX}reabertura aplicar confirmar*`,
                    ].join('\n'),
                });
                return;
            }

            const result = await applyReopeningCleanup(db, {
                actorId: idJogador,
                reason: 'limpeza antes da reabertura',
            });
            await sendReply({ sock, idChat, m, text: renderApplied(result) });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                ...header('REABERTURA', 'comando'),
                '',
                `> ${COMMAND_PREFIX}reabertura status`,
                `> ${COMMAND_PREFIX}reabertura simular`,
                `> ${COMMAND_PREFIX}reabertura aplicar confirmar`,
            ].join('\n'),
        });
    },
};
