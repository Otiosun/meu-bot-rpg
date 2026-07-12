const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const { canManagePlayer, formatMention } = require('../helpers/clover/commandTargetUtils');
const {
    getCloverGroup,
    getSpellReviewAutoFlowEnabled,
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
    sendSpellReviewInviteToPlayer,
} = require('../helpers/clover/groupManager');
const {
    callNextHealthyQueueEntry,
    closeQueueEntryById,
    diagnoseSpellReviewQueue,
    getQueueEntryByPosition,
    requeueQueueEntryById,
} = require('../helpers/clover/spellQueueAdminService');

function compact(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function splitAction(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return {
        action: compact(match?.[1]),
        rest: String(match?.[2] || '').trim(),
    };
}

function inferAliasAction(matchedCommand) {
    const command = compact(matchedCommand);
    if (command === 'diagnosticarfila') return 'diagnose';
    if (command === 'filaproximo') return 'next';
    if (command === 'filaremover') return 'remove';
    if (command === 'filapular') return 'skip';
    return null;
}

function normalizeAction(value) {
    const action = compact(value);
    if (['diagnosticar', 'diagnostico', 'ver', 'status'].includes(action)) return 'diagnose';
    if (['proximo', 'chamar', 'avancar'].includes(action)) return 'next';
    if (['remover', 'tirar', 'excluir'].includes(action)) return 'remove';
    if (['pular', 'adiar', 'recuar'].includes(action)) return 'skip';
    return null;
}

function parsePositionAndReason(text) {
    const match = String(text || '').trim().match(/^(\d+)(?:\s+([\s\S]*))?$/);
    if (!match) return { ok: false };

    const rawReason = String(match[2] || '').trim();
    const quoted = rawReason.match(/motivo\s*=\s*"([^"]+)"/i);
    const plain = rawReason.replace(/^motivo\s*=\s*/i, '').trim();

    return {
        ok: true,
        position: Number(match[1]),
        reason: quoted?.[1]?.trim() || plain || null,
    };
}

function playerLabel(entry) {
    const name = [entry.personagem_nome, entry.display_name, entry.nome]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-');
    return name || formatMention(entry.player_id);
}

function issueLabel(code) {
    const labels = {
        player_not_found: 'cadastro inexistente',
        character_missing: 'personagem ausente',
        profile_not_approved: 'ficha não aprovada',
        game_not_released: 'jogo não liberado',
    };
    return labels[code] || code;
}

async function getReviewGroupMembers(sock, db) {
    try {
        const groupId = await getCloverGroup(db, 'spell_review');
        if (!groupId) return { available: false, reason: 'missing_group', members: [] };
        const metadata = await sock.groupMetadata(groupId);
        return {
            available: true,
            groupId,
            members: (metadata?.participants || []).map((participant) => participant.id).filter(Boolean),
        };
    } catch (error) {
        return { available: false, reason: error?.message || 'metadata_failed', members: [] };
    }
}

function isEntryInGroup(entry, groupState) {
    if (!groupState.available) return null;
    return groupState.members.some((memberId) => isSameUser(memberId, entry.player_id));
}

function renderEntry(entry, groupState) {
    const problems = [
        ...entry.integrity.blocking.map((item) => issueLabel(item.code)),
        ...entry.integrity.warnings.map((item) => issueLabel(item.code)),
    ];
    const groupPresence = isEntryInGroup(entry, groupState);

    return [
        `*${entry.position}. ${playerLabel(entry)}*`,
        `> Fila: ${entry.status === 'called' ? 'chamado' : 'aguardando'}`,
        `> Integridade: ${entry.integrity.ok ? (problems.length ? 'atenção' : 'ok') : 'órfão/bloqueante'}`,
        problems.length ? `> Problemas: ${problems.join(', ')}` : null,
        groupPresence === null ? null : `> Grupo de avaliação: ${groupPresence ? 'dentro' : 'fora'}`,
        `> ID da entrada: ${entry.id}`,
    ].filter(Boolean).join('\n');
}

function renderSkipped(skipped) {
    if (!skipped?.length) return [];
    return [
        '',
        '_`─( ! )───── Entradas órfãs ignoradas`_',
        '',
        ...skipped.map((entry) => (
            `> ${playerLabel(entry)} — ${entry.integrity.blocking.map((item) => issueLabel(item.code)).join(', ')}`
        )),
        '> Essas entradas foram fechadas como removidas. Nenhum personagem ou histórico foi apagado.',
    ];
}

async function removeSkippedCalledParticipants(sock, db, skipped) {
    const called = (skipped || []).filter((entry) => entry.previousStatus === 'called');
    for (const entry of called) {
        await removeSpellReviewParticipant(sock, db, entry.player_id).catch(() => null);
    }
    return called.length;
}

async function rotateLinkSafely(sock, db) {
    try {
        return await rotateSpellReviewInviteLink(sock, db);
    } catch (error) {
        console.log('[fila-admin] não consegui redefinir link:', error?.message || error);
        return null;
    }
}

async function callAndInviteHealthy({ sock, db, adminId, excludePlayerId = null }) {
    const result = await callNextHealthyQueueEntry(db, adminId, { excludePlayerId });
    const removedCalled = await removeSkippedCalledParticipants(sock, db, result.skipped);

    if (!result.ok) {
        if (removedCalled) await rotateLinkSafely(sock, db);
        return { result, invite: null };
    }

    const invite = await sendSpellReviewInviteToPlayer(sock, db, result.entry.player_id, {
        rotate: true,
        queueFallback: false,
    });
    return { result, invite };
}

function renderHelp() {
    return [
        '♧┃ADMINISTRAÇÃO DA FILA 𖥔 CLOVER MULTICOLOR',
        '     ── diagnóstico e correção segura ──',
        '',
        `> ${COMMAND_PREFIX}diagnosticarfila`,
        `> ${COMMAND_PREFIX}filaproximo`,
        `> ${COMMAND_PREFIX}filapular 1 motivo="Player pediu adiamento"`,
        `> ${COMMAND_PREFIX}filaremover 1 motivo="Cadastro sem personagem"`,
        '',
        'Os números são os mesmos exibidos no diagnóstico.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}filaadmin`,
    aliases: [
        `${COMMAND_PREFIX}diagnosticarfila`,
        `${COMMAND_PREFIX}fila diagnosticar`,
        `${COMMAND_PREFIX}filaproximo`,
        `${COMMAND_PREFIX}filaremover`,
        `${COMMAND_PREFIX}filapular`,
    ],
    descricao: 'Diagnostica e corrige entradas quebradas da fila de avaliação de feitiços.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode administrar a fila.' });
            return;
        }

        const aliasAction = inferAliasAction(matchedCommand);
        const parsed = splitAction(body);
        const action = aliasAction || normalizeAction(parsed.action);
        const actionRest = aliasAction ? String(body || '').trim() : parsed.rest;

        if (!action) {
            await sendReply({ sock, idChat, m, text: renderHelp() });
            return;
        }

        if (action === 'diagnose') {
            const diagnosis = await diagnoseSpellReviewQueue(db);
            const groupState = await getReviewGroupMembers(sock, db);
            const lines = diagnosis.entries.map((entry) => renderEntry(entry, groupState));

            await sendReply({
                sock,
                idChat,
                m,
                mentions: diagnosis.entries.map((entry) => entry.player_id),
                text: [
                    '♧┃DIAGNÓSTICO DA FILA 𖥔 CLOVER MULTICOLOR',
                    '     ── nenhuma alteração foi aplicada ──',
                    '',
                    `*Entradas ativas:* ${diagnosis.total}`,
                    `*Chamados:* ${diagnosis.called}`,
                    `*Aguardando:* ${diagnosis.waiting}`,
                    `*Saudáveis:* ${diagnosis.healthy}`,
                    `*Bloqueantes/órfãs:* ${diagnosis.blocking.length}`,
                    `*Com avisos:* ${diagnosis.warnings.length}`,
                    groupState.available ? '*Grupo:* conferido com o WhatsApp.' : '*Grupo:* não foi possível conferir agora.',
                    '',
                    ...(lines.length ? lines : ['A fila está vazia.']),
                    '',
                    `Para retirar uma entrada quebrada: *${COMMAND_PREFIX}filaremover N motivo="..."*`,
                ].join('\n'),
            });
            return;
        }

        if (action === 'next') {
            const { result, invite } = await callAndInviteHealthy({
                sock,
                db,
                adminId: idJogador,
            });

            if (!result.ok && result.code === 'already_called') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [result.entry.player_id],
                    text: [
                        '♧┃FILA PRESERVADA 𖥔 CLOVER MULTICOLOR',
                        '',
                        `*Chamado atual:* ${playerLabel(result.entry)} (${formatMention(result.entry.player_id)})`,
                        'A entrada é válida e continua aguardando avaliação.',
                        ...renderSkipped(result.skipped),
                    ].join('\n'),
                });
                return;
            }

            if (!result.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '♧┃FILA SEM PRÓXIMO VÁLIDO 𖥔 CLOVER MULTICOLOR',
                        '',
                        'Nenhuma entrada saudável ficou disponível.',
                        ...renderSkipped(result.skipped),
                    ].join('\n'),
                });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [result.entry.player_id],
                text: [
                    '♧┃PRÓXIMO VÁLIDO CHAMADO 𖥔 CLOVER MULTICOLOR',
                    '',
                    `*Player:* ${playerLabel(result.entry)} (${formatMention(result.entry.player_id)})`,
                    `*Convite:* ${invite?.ok ? 'enviado/tentado com sucesso' : 'não confirmado; confira o PV e o grupo'}`,
                    ...renderSkipped(result.skipped),
                ].join('\n'),
            });
            return;
        }

        const target = parsePositionAndReason(actionRest);
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: `Informe a posição. Exemplo: *${COMMAND_PREFIX}filaremover 1 motivo="Cadastro inválido"*` });
            return;
        }

        const found = await getQueueEntryByPosition(db, target.position);
        if (!found.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: found.code === 'position_not_found'
                    ? `A posição ${target.position} não existe. A fila possui ${found.total || 0} entrada(s) ativa(s).`
                    : 'Posição inválida.',
            });
            return;
        }

        if (action === 'skip') {
            const result = await requeueQueueEntryById(
                db,
                found.entry.id,
                idJogador,
                target.reason || 'pulado pelo ADM por posição'
            );
            if (!result.ok) {
                await sendReply({ sock, idChat, m, text: 'A entrada mudou e não está mais ativa.' });
                return;
            }

            let next = null;
            if (result.previousStatus === 'called') {
                await removeSpellReviewParticipant(sock, db, found.entry.player_id).catch(() => null);
                next = await callAndInviteHealthy({
                    sock,
                    db,
                    adminId: idJogador,
                    excludePlayerId: found.entry.player_id,
                });
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [found.entry.player_id, next?.result?.entry?.player_id].filter(Boolean),
                text: [
                    '♧┃ENTRADA PULADA 𖥔 CLOVER MULTICOLOR',
                    '',
                    `*Posição anterior:* ${target.position}`,
                    `*Player:* ${playerLabel(found.entry)} (${formatMention(found.entry.player_id)})`,
                    '*Novo estado:* aguardando no fim da fila',
                    `*Motivo:* ${target.reason || 'pulado pelo ADM por posição'}`,
                    next?.result?.ok ? `*Próximo:* ${playerLabel(next.result.entry)}` : null,
                    ...(next ? renderSkipped(next.result.skipped) : []),
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        const result = await closeQueueEntryById(
            db,
            found.entry.id,
            'removed',
            idJogador,
            target.reason || 'removido pelo ADM por posição'
        );
        if (!result.ok) {
            await sendReply({ sock, idChat, m, text: 'A entrada mudou e não está mais ativa.' });
            return;
        }

        if (found.entry.status === 'called') {
            await removeSpellReviewParticipant(sock, db, found.entry.player_id).catch(() => null);
            await rotateLinkSafely(sock, db);
        }

        let next = null;
        if (await getSpellReviewAutoFlowEnabled(db)) {
            next = await callAndInviteHealthy({ sock, db, adminId: idJogador });
        }

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [found.entry.player_id, next?.result?.entry?.player_id].filter(Boolean),
            text: [
                '♧┃ENTRADA REMOVIDA DA FILA 𖥔 CLOVER MULTICOLOR',
                '',
                `*Posição:* ${target.position}`,
                `*Player:* ${playerLabel(found.entry)} (${formatMention(found.entry.player_id)})`,
                `*Motivo:* ${target.reason || 'removido pelo ADM por posição'}`,
                '',
                'Nenhum personagem, grimório, PH ou histórico foi apagado.',
                next?.result?.ok ? `*Próximo chamado:* ${playerLabel(next.result.entry)}` : null,
                ...(next ? renderSkipped(next.result.skipped) : []),
            ].filter(Boolean).join('\n'),
        });
    },
};
