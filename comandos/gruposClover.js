const { COMMAND_PREFIX } = require('../config/bot');
const { sendReaction, sendReply } = require('../helpers/chatReply');
const {
    approvePendingOffGroupRequests,
    fetchAndStoreOffGroupInviteLink,
    getCloverGroup,
    getOffGroupInviteLink,
    getOnGroupInviteLink,
    renderCloverGroupStatus,
    setCloverGroup,
} = require('../helpers/clover/groupManager');
const { syncArchiveCardsForGroup } = require('../helpers/clover/archiveManager');
const { enqueueApprovalSweep, enqueuePrivateText } = require('../helpers/clover/deliveryService');
const { renderPostFichaPrivateInstructions } = require('../helpers/clover/registrationManager');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');

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

async function canManageGroup(sock, idChat, idJogador) {
    if (isOwner(idJogador)) return true;
    if (!idChat?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, idChat, idJogador);
}

function resolveAction(matchedCommand, body) {
    const command = normalizeText(matchedCommand);
    const text = normalizeText(body);

    if (command.includes('linkoff')) return 'send_off_link';
    if (command.includes('setgrupooff') || text.startsWith('off')) return 'set_off';
    if (command.includes('setgrupoon') || text.startsWith('on')) return 'set_on';
    if (command.includes('setgrupoarquivos') || command.includes('setarquivos')) return 'set_archive';
    if (
        command.includes('setcomunidade')
        || command.includes('setcommunity')
        || command.includes('setgrupoavisos')
        || command.includes('setavisos')
        || text.startsWith('comunidade')
        || text.startsWith('avisos')
    ) return 'set_community';
    if (command.includes('aprovaroff') || text.startsWith('aprovar')) return 'approve_off';
    return 'status';
}

async function findPlayerBySender(db, playerId) {
    const exact = await db.get(
        `SELECT id, nome, personagem_nome, display_name, ficha_status, personagem_aparencia_status, jogo_status
         FROM jogadores
         WHERE id = ?
         LIMIT 1`,
        [playerId]
    );
    if (exact) return exact;

    const rows = await db.all(
        `SELECT id, nome, personagem_nome, display_name, ficha_status, personagem_aparencia_status, jogo_status
         FROM jogadores`
    );
    return (rows || []).find((row) => isSameUser(row.id, playerId)) || null;
}

function isPlayerGameReleased(player) {
    return normalizeText(player?.jogo_status || '') === 'liberado';
}

function renderOffLinkQueuedMessage({ player, jobId, sweepJobId, offLink }) {
    const name = player?.personagem_nome || player?.nome || player?.display_name || 'player';
    return [
        '*♧┃LINK OFF ENVIADO 𖥔 CLOVER MULTICOLOR*',
        '     ── acesso de jogo liberado ──',
        '',
        `*Destino:* ${name}`,
        `*PV:* ${jobId ? `fila #${jobId}` : 'enfileirado'}`,
        `*Aprovação OFF:* ${sweepJobId ? `fila #${sweepJobId}` : 'agendada'}`,
        '',
        offLink
            ? '> O link foi enviado no privado. Quando pedir entrada no OFF, o bot tenta aprovar automaticamente.'
            : '> O PV foi enviado, mas o link do OFF ainda não estava disponível. Configure o OFF com .#setgrupooff.',
    ].join('\n');
}

function renderApprovalSummary(result) {
    if (!result.ok && result.reason === 'missing_off_group') {
        return 'Grupo OFF ainda nao foi configurado. Use *.#setgrupooff* dentro do grupo OFF.';
    }

    const skipped = result.skipped || [];
    return [
        '*Pedidos do grupo OFF verificados.*',
        '',
        `Pendentes encontrados: *${result.pending?.length || 0}*.`,
        `Aprovados: *${result.approved?.length || 0}*.`,
        `Falhas: *${result.rejected?.length || 0}*.`,
        `Nao reconhecidos: *${skipped.length}*.`,
        skipped.length
            ? `Nao reconhecidos: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? '...' : ''}`
            : '',
    ].filter(Boolean).join('\n');
}

function renderArchiveSyncSummary(result) {
    if (!result.ok && result.reason === 'missing_group') {
        return 'Grupo de arquivos ainda nao foi configurado. Use *.#setgrupoarquivos* dentro do grupo correto.';
    }

    return [
        '*Arquivo Clover sincronizado.*',
        '',
        `Fichas encontradas: *${result.total || 0}*.`,
        `Enviadas: *${result.sent || 0}*.`,
        `Atualizadas: *${result.edited || 0}*.`,
        `Sem mudanca: *${result.unchanged || 0}*.`,
        `Ignoradas: *${result.skipped || 0}*.`,
        `Falhas: *${result.failed || 0}*.`,
        '',
        'Cards ativos ficam com reacao verde. Personagens arquivados ficam com X vermelho.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}gruposclover`,
    aliases: [
        `${COMMAND_PREFIX}grupoclover`,
        `${COMMAND_PREFIX}setgrupooff`,
        `${COMMAND_PREFIX}setgrupoon`,
        `${COMMAND_PREFIX}setgrupoarquivos`,
        `${COMMAND_PREFIX}setarquivos`,
        `${COMMAND_PREFIX}setcomunidade`,
        `${COMMAND_PREFIX}setgrupoavisos`,
        `${COMMAND_PREFIX}setavisos`,
        `${COMMAND_PREFIX}grupooff`,
        `${COMMAND_PREFIX}grupoon`,
        `${COMMAND_PREFIX}grupoarquivos`,
        `${COMMAND_PREFIX}comunidade`,
        `${COMMAND_PREFIX}arquivos`,
        `${COMMAND_PREFIX}linkoff`,
        `${COMMAND_PREFIX}aprovaroff`,
    ],
    descricao: 'Configura grupos ON/OFF/Arquivos do Clover.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, body, matchedCommand, db }) => {
        const action = resolveAction(matchedCommand, body);

        if (action === 'send_off_link') {
            const player = await findPlayerBySender(db, idJogador);
            if (!player) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '*♧┃LINK OFF 𖥔 CLOVER MULTICOLOR*',
                        '     ── registro não encontrado ──',
                        '',
                        '> Não achei sua ficha no sistema.',
                        '> Se isso estiver errado, fale com um ADM.',
                    ].join('\n'),
                });
                return;
            }

            if (!isPlayerGameReleased(player)) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '*♧┃LINK OFF 𖥔 CLOVER MULTICOLOR*',
                        '     ── jogo ainda não liberado ──',
                        '',
                        `*Status atual:* ${player.jogo_status || 'não definido'}`,
                        '',
                        '> Esse link só é reenviado para ficha com jogo liberado.',
                    ].join('\n'),
                });
                return;
            }

            const offLink = await getOffGroupInviteLink(sock, db);
            const privateText = renderPostFichaPrivateInstructions({ offGroupLink: offLink });
            const privateJob = await enqueuePrivateText(db, {
                targetJid: player.id,
                text: privateText,
                source: 'linkoff_player',
                reason: 'reenvio_jogo_liberado',
                priority: 40,
                metadata: {
                    requested_by: idJogador,
                    requested_in: idChat,
                },
            });
            const sweepJob = await enqueueApprovalSweep(db, {
                groupType: 'off',
                source: 'linkoff_player',
                priority: 35,
            });

            await sendReply({
                sock,
                idChat,
                m,
                text: renderOffLinkQueuedMessage({
                    player,
                    jobId: privateJob?.jobId || null,
                    sweepJobId: sweepJob?.jobId || null,
                    offLink,
                }),
            });
            return;
        }

        if (['set_off', 'set_on', 'set_archive', 'set_community'].includes(action) && !idChat?.endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Use esse comando dentro do grupo correto.',
            });
            return;
        }

        if (['set_off', 'set_on', 'set_archive', 'set_community'].includes(action) && !await canManageGroup(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode configurar grupo ON/OFF/Arquivos.',
            });
            return;
        }

        if (action === 'set_off') {
            await setCloverGroup(db, 'off', idChat);

            let link = null;
            try {
                link = await fetchAndStoreOffGroupInviteLink(sock, db);
            } catch (error) {
                console.log('Nao consegui gerar link do grupo OFF:', error?.message || error);
            }

            let approvalResult = null;
            try {
                approvalResult = await approvePendingOffGroupRequests(sock, db);
            } catch (error) {
                console.log('Nao consegui varrer pedidos pendentes do grupo OFF:', error?.message || error);
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Grupo OFF Clover configurado.*',
                    '',
                    link
                        ? `Link salvo: ${link}`
                        : 'Nao consegui pegar o link agora. Confirme se o bot e ADM do grupo.',
                    '',
                    'Quando um player com ficha aprovada pedir para entrar, o bot tenta aprovar automaticamente.',
                    approvalResult ? '' : null,
                    approvalResult ? renderApprovalSummary(approvalResult) : null,
                ].join('\n'),
            });
            return;
        }

        if (action === 'approve_off') {
            if (!isOwner(idJogador)) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: 'Apenas Owner pode varrer/aprovar pedidos pendentes do OFF.',
                });
                return;
            }

            let result = null;
            try {
                result = await approvePendingOffGroupRequests(sock, db);
            } catch (error) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        'Nao consegui verificar os pedidos do grupo OFF.',
                        '',
                        'Confirme se o bot e ADM do grupo OFF e se o grupo foi configurado com *.#setgrupooff*.',
                        `Erro: ${error?.message || error}`,
                    ].join('\n'),
                });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: renderApprovalSummary(result),
            });
            return;
        }

        if (action === 'set_archive') {
            await setCloverGroup(db, 'archive', idChat);
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Grupo de arquivos Clover configurado.*',
                    '',
                    'Vou sincronizar as fichas atuais uma por uma.',
                    'Se a historia ainda estiver pendente, ela aparece como pendente no card.',
                ].join('\n'),
            });

            try {
                const result = await syncArchiveCardsForGroup({ sock, db, groupId: idChat });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderArchiveSyncSummary(result),
                });
            } catch (error) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        'Configurei o grupo de arquivos, mas nao consegui sincronizar as fichas agora.',
                        '',
                        `Erro: ${error?.message || error}`,
                    ].join('\n'),
                });
            }
            return;
        }

        if (action === 'set_on') {
            await setCloverGroup(db, 'on', idChat);
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Grupo ON Clover configurado.*',
            });
            return;
        }

        if (action === 'set_community') {
            await setCloverGroup(db, 'community', idChat);
            await sendReaction({ sock, idChat, m, emoji: '✅' }).catch(() => null);
            return;
        }

        const offGroupId = await getCloverGroup(db, 'off');
        const onGroupId = await getCloverGroup(db, 'on');
        const archiveGroupId = await getCloverGroup(db, 'archive');
        const communityGroupId = await getCloverGroup(db, 'community');
        const offLink = await getOffGroupInviteLink(sock, db);
        const onLink = await getOnGroupInviteLink(sock, db);

        await sendReply({
            sock,
            idChat,
            m,
            text: renderCloverGroupStatus({ offGroupId, onGroupId, archiveGroupId, communityGroupId, offLink, onLink }),
        });
    },
};
