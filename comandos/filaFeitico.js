const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    canManagePlayer,
    formatMention,
    getPlayerById,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    callNextQueueEntry,
    cancelQueueEntry,
    closeQueueEntry,
    enterQueue,
    getActiveQueueEntry,
    getQueuePosition,
    listActiveQueue,
    requeueActiveQueueEntry,
    resetSpellReviewQueue,
} = require('../helpers/clover/spellbookService');
const {
    getSpellReviewAutoFlowEnabled,
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
    sendSpellReviewInviteToPlayer,
    setSpellReviewAutoFlow,
} = require('../helpers/clover/groupManager');

function splitAction(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const action = normalizeText(match?.[1] || '').replace(/[^a-z0-9]+/g, '');
    return {
        action,
        rest: String(match?.[2] || '').trim(),
    };
}

function normalizeAction(action) {
    if (['entrar', 'entrei', 'participar', 'pedir'].includes(action)) return 'enter';
    if (['sair', 'cancelar', 'cancela'].includes(action)) return 'cancel';
    if (['status', 'posicao', 'posição'].includes(action)) return 'status';
    if (['fila', 'listar', 'lista'].includes(action)) return 'list';
    if (['proximo', 'próximo', 'chamar', 'call'].includes(action)) return 'call';
    if (['concluir', 'concluido', 'concluído', 'avaliado', 'avaliada', 'feito'].includes(action)) return 'conclude';
    if (['pular', 'pendente', 'adiar'].includes(action)) return 'skip';
    if (['remover', 'tirar', 'excluir'].includes(action)) return 'remove';
    if (['auto', 'automatico', 'automático', 'fluxo', 'fluxoautomatico'].includes(action)) return 'auto';
    if (['reset', 'resetar', 'limpar', 'zerar'].includes(action)) return 'reset';
    return null;
}

function inferActionFromCommand(command) {
    const compact = normalizeText(command || '').replace(/[^a-z0-9]+/g, '');
    if ([
        'entrarfila',
        'entrarfilafeitico',
        'entrarfilafeitico',
        'entraravaliacao',
        'entraravaliacaofeitico',
    ].includes(compact)) return 'enter';
    if (['sairfila', 'sairfilafeitico', 'sairavaliacao', 'cancelarfila'].includes(compact)) return 'cancel';
    if (['statusfila', 'statusfilafeitico', 'statusavaliacao'].includes(compact)) return 'status';
    if (['proximo', 'prox', 'chamarproximo'].includes(compact)) return 'call';
    if (['concluir', 'concluido', 'feito', 'avaliado'].includes(compact)) return 'conclude';
    if (['pularfila', 'pendente', 'pendentefila', 'adiarfila'].includes(compact)) return 'skip';
    if (['removerfila', 'tirarfila'].includes(compact)) return 'remove';
    if (['fluxofeitico', 'fluxoautomatico', 'autoavaliacao', 'automaticofeitico'].includes(compact)) return 'auto';
    if (['resetfila', 'resetfilafeitico', 'limparfila', 'limparfilafeitico'].includes(compact)) return 'reset';
    return null;
}

function statusLabel(status) {
    const labels = {
        waiting: 'aguardando',
        called: 'chamado',
        concluded: 'concluído',
        removed: 'removido',
        cancelled: 'cancelado',
    };
    return labels[status] || status || '-';
}

async function playerLabel(db, playerId) {
    const player = await getPlayerById(db, playerId);
    return `${playerDisplayName(player, playerId)} (${formatMention(playerId)})`;
}

async function renderQueueList(db, entries) {
    if (!entries.length) {
        return [
            '♧┃FILA DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
            '',
            'A fila está vazia.',
        ].join('\n');
    }

    const lines = await Promise.all(entries.map(async (entry, index) => (
        `*${index + 1}. ${await playerLabel(db, entry.player_id)}*\n> Status: ${statusLabel(entry.status)}`
    )));

    return [
        '♧┃FILA DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
        '     ── entrada no grupo de avaliação ──',
        '',
        ...lines,
        '',
        `*Player:* ${COMMAND_PREFIX}entrarfila`,
        `*ADM:* ${COMMAND_PREFIX}proximo`,
        `*ADM:* responda o player com ${COMMAND_PREFIX}concluir`,
    ].join('\n');
}

function renderQueueHelp() {
    return [
        '♧┃FILA DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
        '',
        '*Player:*',
        `> ${COMMAND_PREFIX}entrarfila`,
        `> ${COMMAND_PREFIX}statusfila`,
        `> ${COMMAND_PREFIX}sairfila`,
        '',
        '*ADM:*',
        `> ${COMMAND_PREFIX}fila`,
        `> ${COMMAND_PREFIX}proximo`,
        `> ${COMMAND_PREFIX}concluir @player`,
        `> ${COMMAND_PREFIX}pularfila @player motivo`,
        `> ${COMMAND_PREFIX}removerfila @player motivo`,
        `> ${COMMAND_PREFIX}resetfila`,
        `> ${COMMAND_PREFIX}fluxoautomatico ligar`,
        '',
        'Também funciona respondendo uma mensagem do player.',
    ].join('\n');
}

function parseAutoFlowIntent(rest) {
    const compact = normalizeText(rest || '').replace(/[^a-z0-9]+/g, '');
    if (['ligar', 'ativar', 'on', 'auto', 'automatico', 'sim'].includes(compact)) return true;
    if (['desligar', 'desativar', 'off', 'manual', 'nao', 'não'].includes(compact)) return false;
    return null;
}

function renderAutoFlowStatus(enabled) {
    return [
        '♧┃FLUXO AUTOMÁTICO DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
        '',
        `*Status:* ${enabled ? 'ligado' : 'desligado'}`,
        '',
        enabled
            ? 'Ao concluir ou remover alguém, o bot remove do grupo, mantém o link atual e chama o próximo.'
            : `O bot só fecha a vez. Use *${COMMAND_PREFIX}proximo* para chamar manualmente.`,
        '',
        `*Ligar:* ${COMMAND_PREFIX}fluxoautomatico ligar`,
        `*Desligar:* ${COMMAND_PREFIX}fluxoautomatico desligar`,
    ].join('\n');
}

async function resolveQueueTarget(db, rest, m) {
    const { targetId, targetText, rest: reason } = resolveTargetAndRest(rest, m);
    if (!targetId && !targetText) {
        return { ok: false, error: 'Marque o player, informe o número/nome, ou responda uma mensagem dele.' };
    }

    const resolved = await resolveTargetPlayer(db, targetId, targetText);
    if (resolved.ok) return { ok: true, playerId: resolved.player.id, reason };
    if (targetId) return { ok: true, playerId: targetId, reason };
    return resolved;
}

function renderInviteResult(inviteResult) {
    const lines = [];
    if (inviteResult?.add?.ok) {
        lines.push(inviteResult.add.alreadyInGroup
            ? '*Grupo:* player já estava no grupo.'
            : '*Grupo:* tentativa de adicionar enviada.');
    } else if (inviteResult?.add?.reason === 'missing_group') {
        lines.push(`*Grupo:* não configurado. Use *${COMMAND_PREFIX}setgrupoavaliacaofeitico*.`);
    } else {
        lines.push('*Grupo:* não consegui adicionar direto.');
    }

    if (inviteResult?.officialInvite?.ok) {
        lines.push(`*Convite:* convite oficial enviado para ${formatMention(inviteResult.officialInvite.sentTo)}.`);
    } else if (!inviteResult?.add?.ok) {
        lines.push('*Convite:* não consegui enviar convite oficial.');
    }

    if (inviteResult?.linkMessage?.ok || inviteResult?.sentTo) {
        lines.push(`*Link:* enviado no PV para ${formatMention(inviteResult.sentTo || inviteResult.linkMessage?.sentTo)}.`);
    } else if (inviteResult?.reason === 'missing_link') {
        lines.push(`*Link:* não disponível. Configure com *${COMMAND_PREFIX}setgrupoavaliacaofeitico*.`);
    } else {
        lines.push('*Link:* não consegui enviar no PV.');
    }

    return lines.join('\n');
}

function renderRemovalResult(removalResult) {
    if (removalResult?.ok) return '*Grupo:* player removido do grupo de avaliação.';
    if (removalResult?.reason === 'missing_group') {
        return `*Grupo:* não removi. Configure com *${COMMAND_PREFIX}setgrupoavaliacaofeitico*.`;
    }
    if (removalResult?.reason === 'remove_failed') {
        return '*Grupo:* tentei remover, mas o WhatsApp recusou. Confirme se o bot é ADM e se o player está no grupo.';
    }
    return '*Grupo:* não consegui remover agora.';
}

async function callNextAndInvite({ sock, db, adminId, rotateLink, excludePlayerId = null }) {
    const result = await callNextQueueEntry(db, adminId, { excludePlayerId });
    if (!result.ok) return { result, invite: null };

    const invite = await sendSpellReviewInviteToPlayer(sock, db, result.entry.player_id, {
        rotate: rotateLink,
        queueFallback: false,
    });
    return { result, invite };
}

async function rotateLinkSafely(sock, db) {
    try {
        return await rotateSpellReviewInviteLink(sock, db);
    } catch (error) {
        console.log('Nao consegui buscar link do grupo de avaliacao de feiticos:', error?.message || error);
        return null;
    }
}

module.exports = {
    nome: `${COMMAND_PREFIX}filafeitico`,
    aliases: [
        `${COMMAND_PREFIX}fila`,
        `${COMMAND_PREFIX}fila feitico`,
        `${COMMAND_PREFIX}fila feitiço`,
        `${COMMAND_PREFIX}filafeitiço`,
        `${COMMAND_PREFIX}entrarfila`,
        `${COMMAND_PREFIX}entrarfilafeitico`,
        `${COMMAND_PREFIX}entrarfilafeitiço`,
        `${COMMAND_PREFIX}sairfila`,
        `${COMMAND_PREFIX}sairfilafeitico`,
        `${COMMAND_PREFIX}sairfilafeitiço`,
        `${COMMAND_PREFIX}statusfila`,
        `${COMMAND_PREFIX}statusfilafeitico`,
        `${COMMAND_PREFIX}statusfilafeitiço`,
        `${COMMAND_PREFIX}proximo`,
        `${COMMAND_PREFIX}próximo`,
        `${COMMAND_PREFIX}prox`,
        `${COMMAND_PREFIX}chamarproximo`,
        `${COMMAND_PREFIX}concluir`,
        `${COMMAND_PREFIX}concluido`,
        `${COMMAND_PREFIX}concluído`,
        `${COMMAND_PREFIX}feito`,
        `${COMMAND_PREFIX}pularfila`,
        `${COMMAND_PREFIX}pendente`,
        `${COMMAND_PREFIX}pendentefila`,
        `${COMMAND_PREFIX}removerfila`,
        `${COMMAND_PREFIX}tirarfila`,
        `${COMMAND_PREFIX}resetfila`,
        `${COMMAND_PREFIX}resetfilafeitico`,
        `${COMMAND_PREFIX}resetfilafeitiço`,
        `${COMMAND_PREFIX}limparfila`,
        `${COMMAND_PREFIX}limparfilafeitico`,
        `${COMMAND_PREFIX}limparfilafeitiço`,
        `${COMMAND_PREFIX}fluxoautomatico`,
        `${COMMAND_PREFIX}fluxoautomático`,
        `${COMMAND_PREFIX}autoavaliacao`,
        `${COMMAND_PREFIX}autoavaliação`,
    ],
    descricao: 'Gerencia a fila de entrada no grupo de avaliação de feitiços.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const { action: rawAction, rest } = splitAction(body);
        const aliasAction = inferActionFromCommand(matchedCommand);
        let action = aliasAction || normalizeAction(rawAction);
        const actionRest = aliasAction ? String(body || '').trim() : rest;
        const bareFilaAlias = normalizeText(matchedCommand || '').replace(/[^a-z0-9]+/g, '') === 'fila'
            && !String(body || '').trim();

        if (!action && bareFilaAlias) {
            action = await canManagePlayer(sock, idChat, idJogador) ? 'list' : 'status';
        }

        if (!action) {
            await sendReply({ sock, idChat, m, text: renderQueueHelp() });
            return;
        }

        if (action === 'enter') {
            const result = await enterQueue(db, idJogador);
            if (!result.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [idJogador],
                    text: [
                        'Você já está na fila de avaliação de feitiços.',
                        '',
                        `*Status:* ${statusLabel(result.entry.status)}`,
                        result.position ? `*Posição:* ${result.position}` : '*Posição:* já chamado',
                    ].join('\n'),
                });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [idJogador],
                text: [
                    '♧┃FILA DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
                    '',
                    `${formatMention(idJogador)}, você entrou na fila.`,
                    `*Posição:* ${result.position}`,
                    '',
                    'Quando for chamado, entre no grupo de avaliação e mande o feitiço por lá.',
                ].join('\n'),
            });
            return;
        }

        if (action === 'cancel') {
            const result = await cancelQueueEntry(db, idJogador, idJogador, 'cancelado pelo player');
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [idJogador],
                text: result.ok
                    ? `${formatMention(idJogador)}, sua entrada saiu da fila de feitiços.`
                    : 'Você não está na fila de feitiços agora.',
            });
            return;
        }

        if (action === 'status') {
            const entry = await getActiveQueueEntry(db, idJogador);
            if (!entry) {
                await sendReply({ sock, idChat, m, text: `Você não está na fila. Use *${COMMAND_PREFIX}entrarfila*.` });
                return;
            }
            const position = await getQueuePosition(db, entry);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [idJogador],
                text: [
                    '♧┃STATUS DA FILA 𖥔 CLOVER MULTICOLOR',
                    '',
                    `*Player:* ${formatMention(idJogador)}`,
                    `*Status:* ${statusLabel(entry.status)}`,
                    position ? `*Posição:* ${position}` : '*Posição:* já chamado',
                ].join('\n'),
            });
            return;
        }

        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode gerenciar a fila de feitiços.' });
            return;
        }

        if (action === 'auto') {
            const intent = parseAutoFlowIntent(actionRest);
            if (intent === null) {
                const enabled = await getSpellReviewAutoFlowEnabled(db);
                await sendReply({ sock, idChat, m, text: renderAutoFlowStatus(enabled) });
                return;
            }

            await setSpellReviewAutoFlow(db, intent);
            await sendReply({ sock, idChat, m, text: renderAutoFlowStatus(intent) });
            return;
        }

        if (action === 'reset') {
            if (!isOwner(idJogador)) {
                await sendReply({ sock, idChat, m, text: 'Apenas o dono pode resetar a fila de feitiços.' });
                return;
            }

            const reset = await resetSpellReviewQueue(db, idJogador);
            const rotatedLink = await rotateLinkSafely(sock, db);
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '♧┃FILA DE FEITIÇOS RESETADA 𖥔 CLOVER MULTICOLOR',
                    '',
                    `*Cancelados:* ${reset.cancelled}`,
                    `*Chamado atual:* ${reset.called ? 'cancelado' : 'nenhum'}`,
                    `*Aguardando:* ${reset.waiting}`,
                    rotatedLink
                        ? '*Link do grupo:* link atual mantido.'
                        : '*Link do grupo:* não consegui buscar agora.',
                    '',
                    'Feitiços aprovados e grimórios não foram alterados.',
                ].join('\n'),
            });
            return;
        }

        if (action === 'list') {
            const entries = await listActiveQueue(db);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: entries.map((entry) => entry.player_id),
                text: await renderQueueList(db, entries),
            });
            return;
        }

        if (action === 'call') {
            const { result, invite } = await callNextAndInvite({
                sock,
                db,
                adminId: idJogador,
                rotateLink: true,
            });
            if (!result.ok && result.code === 'already_called') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [result.entry.player_id],
                    text: [
                        'Já existe um player chamado para avaliação.',
                        '',
                        `*Atual:* ${await playerLabel(db, result.entry.player_id)}`,
                        `Conclua com *${COMMAND_PREFIX}concluir* respondendo uma mensagem dele.`,
                    ].join('\n'),
                });
                return;
            }
            if (!result.ok) {
                await sendReply({ sock, idChat, m, text: 'A fila de feitiços está vazia.' });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [result.entry.player_id],
                text: [
                    '♧┃CHAMADO PARA AVALIAÇÃO 𖥔 CLOVER MULTICOLOR',
                    '',
                    `${await playerLabel(db, result.entry.player_id)} é o próximo da fila.`,
                    '',
                    'O link foi enviado no PV dele.',
                    renderInviteResult(invite),
                ].join('\n'),
            });
            return;
        }

        const target = await resolveQueueTarget(db, actionRest, m);
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error });
            return;
        }

        if (action === 'skip') {
            const result = await requeueActiveQueueEntry(db, target.playerId, idJogador, target.reason || 'pulado pelo ADM');
            if (!result.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [target.playerId],
                    text: `${formatMention(target.playerId)} não está ativo na fila de feitiços.`,
                });
                return;
            }

            const rotatedLink = await rotateLinkSafely(sock, db);
            const next = await callNextAndInvite({
                sock,
                db,
                adminId: idJogador,
                rotateLink: false,
                excludePlayerId: target.playerId,
            });

            const nextLines = [];
            if (next.result.ok) {
                nextLines.push('');
                nextLines.push('_`─( ✦ )───── Próximo`_');
                nextLines.push('');
                nextLines.push(`${await playerLabel(db, next.result.entry.player_id)} foi chamado.`);
                nextLines.push(renderInviteResult(next.invite));
            } else {
                nextLines.push('');
                nextLines.push('Ninguém foi chamado agora. O player pulado ficou aguardando no fim da fila.');
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [target.playerId, next.result?.entry?.player_id].filter(Boolean),
                text: [
                    '♧┃FILA ATUALIZADA 𖥔 CLOVER MULTICOLOR',
                    '',
                    `*Player pulado:* ${formatMention(target.playerId)}`,
                    '*Status:* aguardando no fim da fila',
                    target.reason ? `*Motivo:* ${target.reason}` : null,
                    '',
                    rotatedLink
                        ? '*Link do grupo:* link atual mantido.'
                        : '*Link do grupo:* não consegui buscar agora.',
                    ...nextLines,
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        const nextStatus = action === 'conclude' ? 'concluded' : 'removed';
        const result = await closeQueueEntry(db, target.playerId, nextStatus, idJogador, target.reason);
        if (!result.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [target.playerId],
                text: `${formatMention(target.playerId)} não está ativo na fila de feitiços.`,
            });
            return;
        }

        const removal = await removeSpellReviewParticipant(sock, db, target.playerId);
        const rotatedLink = await rotateLinkSafely(sock, db);
        const autoFlow = await getSpellReviewAutoFlowEnabled(db);
        const next = autoFlow
            ? await callNextAndInvite({
                sock,
                db,
                adminId: idJogador,
                rotateLink: false,
            })
            : { result: { ok: false, code: 'auto_disabled' }, invite: null };

        const nextLines = [];
        if (next.result.ok) {
            nextLines.push('');
            nextLines.push('_`─( ✦ )───── Próximo`_');
            nextLines.push('');
            nextLines.push(`${await playerLabel(db, next.result.entry.player_id)} foi chamado automaticamente.`);
            nextLines.push(renderInviteResult(next.invite));
        } else if (next.result.code === 'empty') {
            nextLines.push('');
            nextLines.push('A fila ficou vazia depois dessa atualização.');
        } else if (next.result.code === 'already_called') {
            nextLines.push('');
            nextLines.push(`${await playerLabel(db, next.result.entry.player_id)} continua como chamado atual.`);
        } else if (next.result.code === 'auto_disabled') {
            nextLines.push('');
            nextLines.push(`Fluxo automático desligado. Use *${COMMAND_PREFIX}proximo* para chamar manualmente.`);
        }

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [target.playerId, next.result?.entry?.player_id].filter(Boolean),
            text: [
                '♧┃FILA ATUALIZADA 𖥔 CLOVER MULTICOLOR',
                '',
                `*Player:* ${formatMention(target.playerId)}`,
                `*Status:* ${statusLabel(result.entry.status)}`,
                target.reason ? `*Motivo:* ${target.reason}` : null,
                '',
                rotatedLink
                    ? '*Link do grupo:* link atual mantido.'
                    : '*Link do grupo:* não consegui buscar agora.',
                renderRemovalResult(removal),
                ...nextLines,
            ].filter(Boolean).join('\n'),
        });
    },
};
