'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    canManagePlayer,
    formatMention,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    concludeSpellReviewEntry,
    deferSpellReviewEntry,
    getSpellReviewFlowState,
    holdSpellReviewEntry,
    resumeSpellReviewEntry,
    setSpellReviewAutoFlowEnabled,
    setSpellReviewCapacity,
} = require('../helpers/clover/spellReviewFlowService');
const {
    fillAndInviteSpellReviewCapacity,
    removeSpellReviewParticipantSafely,
    startSpellReviewFlowScheduler,
} = require('../helpers/clover/spellReviewFlowOrchestrator');
const { getCloverGroup, sendSpellReviewInviteToPlayer } = require('../helpers/clover/groupManager');


function compact(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function inferAliasAction(matchedCommand) {
    const command = compact(matchedCommand);
    if (['pendentefeitico', 'pendentefeitiço'].includes(command)) return 'pending_player';
    if (['retomarfeitico', 'retomarfeitiço'].includes(command)) return 'resume_player';
    if (['concluirfeitico', 'concluirfeitiço', 'finalizarfeitico', 'finalizarfeitiço'].includes(command)) return 'conclude_player';
    if (['adiarfeitico', 'adiarfeitiço'].includes(command)) return 'defer_player';
    return null;
}

function splitAction(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return {
        action: compact(match?.[1]),
        rest: String(match?.[2] || '').trim(),
    };
}

function normalizeMainAction(action) {
    if (!action || ['status', 'ver', 'painel'].includes(action)) return 'status';
    if (['preencher', 'encher', 'chamar'].includes(action)) return 'fill';
    if (['pausar', 'parar', 'pause'].includes(action)) return 'pause';
    if (['retomar', 'continuar', 'resume'].includes(action)) return 'resume_flow';
    if (/^\d+$/.test(action)) return 'capacity';
    if (['pendente', 'segurar'].includes(action)) return 'pending_player';
    if (['concluir', 'finalizar', 'aprovar'].includes(action)) return 'conclude_player';
    if (['adiar', 'pular'].includes(action)) return 'defer_player';
    return null;
}

async function resolvePlayerTarget(db, text, m) {
    const { targetId, targetText, rest } = resolveTargetAndRest(text, m);
    if (!targetId && !targetText) {
        return {
            ok: false,
            error: 'Marque, responda ou informe o nome do player.',
        };
    }
    const resolved = await resolveTargetPlayer(db, targetId, targetText, { mechanical: true });
    if (!resolved.ok) return resolved;
    return { ok: true, player: resolved.player, rest };
}

function label(entry) {
    return playerDisplayName(entry, entry.player_id || entry.id);
}

async function reviewGroupPresence(sock, db, entries) {
    try {
        const groupId = await getCloverGroup(db, 'spell_review');
        if (!groupId) return new Map();
        const metadata = await sock.groupMetadata(groupId);
        const participants = (metadata?.participants || []).map((row) => row.id).filter(Boolean);
        return new Map(entries.map((entry) => [
            entry.id,
            participants.some((id) => isSameUser(id, entry.player_id)),
        ]));
    } catch {
        return new Map();
    }
}

function renderEntry(entry, presence) {
    const state = entry.status === 'waiting'
        ? 'aguardando'
        : entry.review_state === 'pending'
            ? 'pendente no grupo'
            : 'em avaliação';
    const group = presence.has(entry.id)
        ? ` · ${presence.get(entry.id) ? 'no grupo' : 'fora do grupo'}`
        : '';
    return `> ${entry.position}. ${label(entry)} — ${state}${group}`;
}

async function renderStatus(sock, db) {
    const state = await getSpellReviewFlowState(db);
    const presence = await reviewGroupPresence(sock, db, state.entries);
    return {
        mentions: state.entries.map((entry) => entry.player_id),
        text: [
            '♧┃FLUXO DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
            '     ── capacidade simultânea da avaliação ──',
            '',
            `*Capacidade:* ${state.capacity}`,
            `*Em avaliação:* ${state.active}/${state.capacity}`,
            `*Pendentes no grupo:* ${state.pending}`,
            `*Aguardando na fila:* ${state.waiting}`,
            `*Vagas livres:* ${state.vacancies}`,
            `*Fluxo automático:* ${state.autoFlow ? 'ativo' : 'pausado'}`,
            '',
            ...(state.entries.length
                ? state.entries.slice(0, 25).map((entry) => renderEntry(entry, presence))
                : ['A fila está vazia.']),
            state.entries.length > 25 ? `> ...e mais ${state.entries.length - 25} entrada(s).` : null,
            '',
            `*Definir capacidade:* ${COMMAND_PREFIX}fluxofeitico 5`,
            `*Preencher agora:* ${COMMAND_PREFIX}fluxofeitico preencher`,
            `*Pausar/retomar:* ${COMMAND_PREFIX}fluxofeitico pausar | retomar`,
            `*Segurar no grupo:* ${COMMAND_PREFIX}pendentefeitico @player motivo`,
            `*Voltar à avaliação:* ${COMMAND_PREFIX}retomarfeitico @player`,
            `*Salvar e concluir:* ${COMMAND_PREFIX}addfeitico @player + ficha`,
            `*Concluir manualmente:* ${COMMAND_PREFIX}concluirfeitico @player`,
            `*Mandar ao fim:* ${COMMAND_PREFIX}adiarfeitico @player motivo`,
        ].filter(Boolean).join('\n'),
    };
}

function countSuccessfulInvites(fill) {
    return (fill?.invites || []).filter((item) => item.invite?.ok).length;
}

function calledNames(fill) {
    return (fill?.called || []).map((entry) => label(entry));
}

module.exports = {
    nome: `${COMMAND_PREFIX}fluxofeitico`,
    aliases: [
        `${COMMAND_PREFIX}fluxofeitiço`,
        `${COMMAND_PREFIX}fluxo feitico`,
        `${COMMAND_PREFIX}fluxo feitiço`,
        `${COMMAND_PREFIX}pendentefeitico`,
        `${COMMAND_PREFIX}pendentefeitiço`,
        `${COMMAND_PREFIX}retomarfeitico`,
        `${COMMAND_PREFIX}retomarfeitiço`,
        `${COMMAND_PREFIX}concluirfeitico`,
        `${COMMAND_PREFIX}concluirfeitiço`,
        `${COMMAND_PREFIX}finalizarfeitico`,
        `${COMMAND_PREFIX}finalizarfeitiço`,
        `${COMMAND_PREFIX}adiarfeitico`,
        `${COMMAND_PREFIX}adiarfeitiço`,
    ],
    descricao: 'Controla capacidade, pendências e avanço da fila de avaliação de feitiços.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode controlar o fluxo de feitiços.' });
            return;
        }

        const aliasAction = inferAliasAction(matchedCommand);
        const parsed = splitAction(body);
        const action = aliasAction || normalizeMainAction(parsed.action);
        const rest = aliasAction ? String(body || '').trim() : parsed.rest;

        if (!action) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `Ação inválida. Use *${COMMAND_PREFIX}fluxofeitico* para ver o painel.`,
            });
            return;
        }

        if (action === 'status') {
            const status = await renderStatus(sock, db);
            await sendReply({ sock, idChat, m, ...status });
            return;
        }

        if (action === 'capacity') {
            const capacity = Number(parsed.action);
            const configured = await setSpellReviewCapacity(db, capacity);
            if (!configured.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: `A capacidade precisa ficar entre ${configured.min} e ${configured.max}.`,
                });
                return;
            }
            const fill = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: idJogador,
                force: true,
                rotate: true,
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: (fill.called || []).map((entry) => entry.player_id),
                text: [
                    '♧┃CAPACIDADE DE FEITIÇOS ATUALIZADA',
                    '',
                    `*Nova capacidade:* ${configured.capacity}`,
                    `*Chamados agora:* ${fill.called?.length || 0}`,
                    `*Convites confirmados:* ${countSuccessfulInvites(fill)}/${fill.called?.length || 0}`,
                    calledNames(fill).length ? `*Novos:* ${calledNames(fill).join(', ')}` : null,
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        if (action === 'fill') {
            const fill = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: idJogador,
                force: true,
                rotate: true,
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: (fill.called || []).map((entry) => entry.player_id),
                text: [
                    '♧┃VAGAS DE FEITIÇO PREENCHIDAS',
                    '',
                    `*Capacidade:* ${fill.capacity}`,
                    `*Chamados agora:* ${fill.called?.length || 0}`,
                    `*Ativos:* ${fill.state?.active || 0}/${fill.capacity}`,
                    `*Pendentes:* ${fill.state?.pending || 0}`,
                    `*Aguardando:* ${fill.state?.waiting || 0}`,
                    calledNames(fill).length ? `*Novos:* ${calledNames(fill).join(', ')}` : null,
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        if (action === 'pause') {
            await setSpellReviewAutoFlowEnabled(db, false);
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Fluxo automático pausado. Quem já está chamado ou pendente permanece no grupo; nenhuma nova pessoa será chamada automaticamente.',
            });
            return;
        }

        if (action === 'resume_flow') {
            await setSpellReviewAutoFlowEnabled(db, true);
            const fill = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: idJogador,
                force: true,
                rotate: true,
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: (fill.called || []).map((entry) => entry.player_id),
                text: `Fluxo automático retomado. ${fill.called?.length || 0} nova(s) pessoa(s) chamada(s); ${fill.state?.active || 0}/${fill.capacity} vagas ocupadas.`,
            });
            return;
        }

        const target = await resolvePlayerTarget(db, rest, m);
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error || 'Não encontrei esse player.' });
            return;
        }
        const playerId = target.player.id;
        const reason = target.rest || null;

        if (action === 'pending_player') {
            const pending = await holdSpellReviewEntry(
                db,
                playerId,
                idJogador,
                reason || 'aguardando correção da ficha'
            );
            if (!pending.ok) {
                const text = pending.code === 'already_pending'
                    ? 'Esse player já está pendente no grupo.'
                    : pending.code === 'not_called'
                        ? 'Esse player ainda não está em avaliação ativa.'
                        : 'Não encontrei uma avaliação ativa para esse player.';
                await sendReply({ sock, idChat, m, text });
                return;
            }
            const fill = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: idJogador,
                force: false,
                rotate: true,
                excludePlayerIds: [playerId],
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [playerId, ...(fill.called || []).map((entry) => entry.player_id)],
                text: [
                    '♧┃FEITIÇO MANTIDO COMO PENDENTE',
                    '',
                    `*Player:* ${playerDisplayName(target.player, playerId)} (${formatMention(playerId)})`,
                    '*Grupo:* permanece dentro',
                    '*Vaga:* liberada',
                    `*Motivo:* ${reason || 'aguardando correção da ficha'}`,
                    `*Novos chamados:* ${fill.called?.length || 0}`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'resume_player') {
            const resumed = await resumeSpellReviewEntry(db, playerId, idJogador);
            if (!resumed.ok) {
                const text = resumed.code === 'capacity_full'
                    ? `As ${resumed.capacity} vagas estão ocupadas. O player continua pendente no grupo.`
                    : 'Esse player não está marcado como pendente.';
                await sendReply({ sock, idChat, m, text });
                return;
            }
            const invite = await sendSpellReviewInviteToPlayer(sock, db, playerId, {
                rotate: false,
                queueFallback: false,
            }).catch(() => null);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [playerId],
                text: [
                    '♧┃AVALIAÇÃO RETOMADA',
                    '',
                    `*Player:* ${playerDisplayName(target.player, playerId)} (${formatMention(playerId)})`,
                    `*Vaga:* ocupada novamente (${resumed.capacity} simultâneas)`,
                    `*Presença/convite:* ${invite?.ok ? 'confirmado ou reenviado' : 'não confirmado; confira o grupo'}`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'conclude_player') {
            const concluded = await concludeSpellReviewEntry(
                db,
                playerId,
                idJogador,
                reason || 'avaliação concluída pelo ADM'
            );
            if (!concluded.ok) {
                await sendReply({ sock, idChat, m, text: 'Esse player não está em avaliação ativa.' });
                return;
            }
            const removal = await removeSpellReviewParticipantSafely(sock, db, playerId);
            const fill = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: idJogador,
                force: false,
                rotate: true,
                excludePlayerIds: [playerId],
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [playerId, ...(fill.called || []).map((entry) => entry.player_id)],
                text: [
                    '♧┃AVALIAÇÃO DE FEITIÇO CONCLUÍDA',
                    '',
                    `*Player:* ${playerDisplayName(target.player, playerId)} (${formatMention(playerId)})`,
                    `*Saída do grupo:* ${removal?.ok ? 'processada' : 'não confirmada; a fila foi concluída mesmo assim'}`,
                    `*Novos chamados:* ${fill.called?.length || 0}`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'defer_player') {
            const deferred = await deferSpellReviewEntry(
                db,
                playerId,
                idJogador,
                reason || 'adiado pelo ADM'
            );
            if (!deferred.ok) {
                await sendReply({ sock, idChat, m, text: 'Esse player não possui entrada ativa na fila.' });
                return;
            }
            if (deferred.previousStatus === 'called') {
                await removeSpellReviewParticipantSafely(sock, db, playerId);
            }
            const fill = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: idJogador,
                force: false,
                rotate: true,
                excludePlayerIds: [playerId],
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [playerId, ...(fill.called || []).map((entry) => entry.player_id)],
                text: [
                    '♧┃FEITIÇO ADIADO',
                    '',
                    `*Player:* ${playerDisplayName(target.player, playerId)} (${formatMention(playerId)})`,
                    '*Novo estado:* fim da fila',
                    `*Motivo:* ${reason || 'adiado pelo ADM'}`,
                    `*Novos chamados:* ${fill.called?.length || 0}`,
                ].join('\n'),
            });
        }
    },
    renderStatus,
};
