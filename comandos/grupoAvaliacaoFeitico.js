const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { setGroupEnabled } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');
const {
    approvePendingSpellReviewRequests,
    getCloverGroup,
    getSpellReviewAutoFlowEnabled,
    getSpellReviewGroupInviteLink,
    revokeAndStoreGroupInviteLink,
    setCloverGroup,
} = require('../helpers/clover/groupManager');

function normalizeAction(matchedCommand, body) {
    const command = normalizeText(matchedCommand || '').replace(/[^a-z0-9]+/g, '');
    const text = normalizeText(body || '').replace(/[^a-z0-9]+/g, '');

    if (command.includes('setgrupo') || text.startsWith('set') || text.startsWith('definir')) return 'set';
    if (command.includes('aprovar') || text.startsWith('aprovar')) return 'approve';
    return 'status';
}

function renderApprovalSummary(result) {
    if (!result.ok && result.reason === 'missing_spell_review_group') {
        return `Grupo de avaliação de feitiços ainda não foi configurado. Use *${COMMAND_PREFIX}setgrupoavaliacaofeitico* dentro do grupo correto.`;
    }

    return [
        '*Pedidos do grupo de avaliação verificados.*',
        '',
        `Pendentes encontrados: *${result.pending?.length || 0}*.`,
        `Aprovados: *${result.approved?.length || 0}*.`,
        `Falhas: *${result.rejected?.length || 0}*.`,
        `Ignorados: *${result.skipped?.length || 0}*.`,
    ].join('\n');
}

function renderStatus(groupId, link, autoFlowEnabled) {
    return [
        '♧┃GRUPO DE AVALIAÇÃO DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
        '',
        `*Grupo:* ${groupId || 'não configurado'}`,
        `*Link atual:* ${link || 'indisponível'}`,
        `*Fluxo automático:* ${autoFlowEnabled ? 'ligado' : 'desligado'}`,
        '',
        `*Definir:* ${COMMAND_PREFIX}setgrupoavaliacaofeitico`,
        `*Aprovar pendentes:* ${COMMAND_PREFIX}aprovaravaliacaofeitico`,
        `*Fluxo:* ${COMMAND_PREFIX}fluxofeitico ligar/desligar`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}setgrupoavaliacaofeitico`,
    aliases: [
        `${COMMAND_PREFIX}setgrupoavaliacaofeitiço`,
        `${COMMAND_PREFIX}setgrupoavaliacao`,
        `${COMMAND_PREFIX}setgrupoavaliação`,
        `${COMMAND_PREFIX}grupoavaliacaofeitico`,
        `${COMMAND_PREFIX}grupoavaliacaofeitiço`,
        `${COMMAND_PREFIX}grupoavaliaçãofeitico`,
        `${COMMAND_PREFIX}linkavaliacaofeitico`,
        `${COMMAND_PREFIX}linkavaliacaofeitiço`,
        `${COMMAND_PREFIX}aprovaravaliacaofeitico`,
        `${COMMAND_PREFIX}aprovaravaliacaofeitiço`,
    ],
    descricao: 'Configura o grupo de avaliação de feitiços.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const action = normalizeAction(matchedCommand, body);

        if (action === 'set') {
            if (!idChat?.endsWith('@g.us')) {
                await sendReply({ sock, idChat, m, text: 'Use esse comando dentro do grupo de avaliação de feitiços.' });
                return;
            }
            if (!await canManagePlayer(sock, idChat, idJogador)) {
                await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode configurar esse grupo.' });
                return;
            }

            await setCloverGroup(db, 'spell_review', idChat);
            await setGroupEnabled(db, idChat, true);

            let link = null;
            try {
                link = await revokeAndStoreGroupInviteLink(sock, db, 'spell_review');
            } catch (error) {
                console.log('Nao consegui gerar link do grupo de avaliacao de feiticos:', error?.message || error);
            }

            let approvalResult = null;
            try {
                approvalResult = await approvePendingSpellReviewRequests(sock, db);
            } catch (error) {
                console.log('Nao consegui varrer pedidos pendentes do grupo de avaliacao:', error?.message || error);
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '♧┃GRUPO DE AVALIAÇÃO DEFINIDO 𖥔 CLOVER MULTICOLOR',
                    '',
                    'Este grupo agora é o grupo de avaliação de feitiços.',
                    '',
                    link
                        ? `*Link salvo:* ${link}`
                        : 'Não consegui gerar link agora. Confirme se o bot é ADM do grupo.',
                    '',
                    'Quando um player for chamado na fila, o bot manda o link no PV dele.',
                    'Se ele pedir para entrar enquanto estiver chamado, o bot aprova automaticamente.',
                    approvalResult ? '' : null,
                    approvalResult ? renderApprovalSummary(approvalResult) : null,
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        if (action === 'approve') {
            if (!await canManagePlayer(sock, idChat, idJogador)) {
                await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode aprovar pendentes.' });
                return;
            }

            try {
                const result = await approvePendingSpellReviewRequests(sock, db);
                await sendReply({ sock, idChat, m, text: renderApprovalSummary(result) });
            } catch (error) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        'Não consegui verificar os pedidos do grupo de avaliação.',
                        '',
                        'Confirme se o bot é ADM e se o grupo foi configurado.',
                        `Erro: ${error?.message || error}`,
                    ].join('\n'),
                });
            }
            return;
        }

        const groupId = await getCloverGroup(db, 'spell_review');
        const link = await getSpellReviewGroupInviteLink(sock, db);
        const autoFlowEnabled = await getSpellReviewAutoFlowEnabled(db);
        await sendReply({
            sock,
            idChat,
            m,
            text: renderStatus(groupId, link, autoFlowEnabled),
        });
    },
};
