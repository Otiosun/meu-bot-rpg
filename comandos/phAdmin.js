const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const {
    isOwner,
    isSameUser,
} = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    PhServiceError,
    addPh,
    adminAdjustPh,
    getPhHistory,
    removeAvailablePh,
} = require('../helpers/clover/phService');
const { resolveTargetPlayer: resolveCentralTargetPlayer } = require('../helpers/clover/targetResolver');

const GROUP_ADMIN_CHECK_TIMEOUT_MS = 3500;

function withTimeout(promise, timeoutMs, fallback) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function isGroupAdmin(sock, groupId, playerId) {
    try {
        const metadata = await withTimeout(
            sock.groupMetadata(groupId),
            GROUP_ADMIN_CHECK_TIMEOUT_MS,
            null
        );
        if (!metadata) return false;

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

async function canManagePlayer(sock, idChat, idJogador) {
    if (isOwner(idJogador)) return true;
    if (!idChat?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, idChat, idJogador);
}

function getMentions(m) {
    return getMessageContextInfo(m)?.mentionedJid || [];
}

function getQuotedParticipant(m) {
    return getMessageContextInfo(m)?.participant || null;
}

function jidFromToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    const withoutLeadingAt = raw.replace(/^@/, '');
    if (withoutLeadingAt.includes('@')) return withoutLeadingAt;

    const digits = withoutLeadingAt.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

function resolveAction(matchedCommand) {
    const command = normalizeText(matchedCommand).replace(/[^a-z0-9]+/g, '');
    if (command.includes('darph')) return 'give';
    if (command.includes('tirarph') || command.includes('retirarph') || command.includes('removerph')) return 'remove';
    if (command.includes('ajustarph')) return 'adjust';
    if (command.includes('historicoph') || command.includes('historicodeph')) return 'history';
    return null;
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function splitBody(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

function stripMentionTokens(body) {
    return String(body || '').replace(/@\S+/g, '').trim();
}

function firstIntegerTokenIndex(parts, startIndex = 0) {
    for (let index = startIndex; index < parts.length; index += 1) {
        if (/^[+-]?\d+$/.test(parts[index])) return index;
    }
    return -1;
}

function splitTargetAndRest(body, action) {
    const parts = splitBody(body);
    if (!parts.length) return { targetText: '', rest: '' };

    const normalizedFirst = normalizeText(parts[0]);
    if (normalizedFirst === 'final' && parts[1]) {
        return {
            targetText: parts[1],
            rest: parts.slice(action === 'history' ? 2 : 2).join(' ').trim(),
        };
    }

    if (action === 'history') {
        return {
            targetText: parts.join(' '),
            rest: '',
        };
    }

    const first = parts[0];
    const firstDigits = extractDigits(first);
    if (firstDigits.length >= 4 && parts[1]) {
        return {
            targetText: first,
            rest: parts.slice(1).join(' ').trim(),
        };
    }

    const amountIndex = firstIntegerTokenIndex(parts, 1);
    if (amountIndex > 0) {
        return {
            targetText: parts.slice(0, amountIndex).join(' ').trim(),
            rest: parts.slice(amountIndex).join(' ').trim(),
        };
    }

    return {
        targetText: first,
        rest: parts.slice(1).join(' ').trim(),
    };
}

function resolveTargetAndRest(body, m, action) {
    const mentions = getMentions(m);
    if (mentions.length) {
        return {
            targetId: mentions[0],
            targetText: '',
            rest: stripMentionTokens(body),
        };
    }

    const quoted = getQuotedParticipant(m);
    if (quoted) {
        return { targetId: quoted, targetText: '', rest: String(body || '').trim() };
    }

    const { targetText, rest } = splitTargetAndRest(body, action);
    const targetId = jidFromToken(targetText);
    return {
        targetId,
        targetText,
        rest,
    };
}

function parseAmountAndReason(rest) {
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    const amount = Number(parts[0]);
    return {
        amount,
        reason: parts.slice(1).join(' ').trim(),
    };
}

function hasValidReason(reason) {
    return String(reason || '').trim().length >= 3;
}

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function formatAmount(amount) {
    const value = Number(amount || 0);
    return value > 0 ? `+${value}` : String(value);
}

function formatShortDate(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) return text || '-';
    return `${match[3]}/${match[2]} ${match[4]}:${match[5]}`;
}

function formatKind(kind) {
    const labels = {
        ganho: 'ganho',
        gasto: 'gasto',
        perda: 'perda',
        ajuste_admin: 'ajuste ADM',
        estorno: 'estorno',
    };
    return labels[kind] || kind || '-';
}

function renderMissingTarget(action) {
    const example = action === 'history'
        ? `${COMMAND_PREFIX}historicoph @player`
        : `${COMMAND_PREFIX}darph @player 20 motivo`;

    return [
        'Informe o player por mencao, numero ou respondendo uma mensagem dele.',
        '',
        `Exemplo: *${example}*`,
    ].join('\n');
}

function renderMissingAmount(action) {
    const examples = {
        give: `${COMMAND_PREFIX}darph @player 20 participacao em cena`,
        remove: `${COMMAND_PREFIX}tirarph @player 10 ajuste administrativo`,
        adjust: `${COMMAND_PREFIX}ajustarph @player +20 correcao de saldo`,
    };

    return [
        'Informe uma quantidade inteira de PH e um motivo.',
        '',
        `Exemplo: *${examples[action] || examples.give}*`,
    ].join('\n');
}

function renderPhError(error) {
    if (error instanceof PhServiceError) {
        if (error.code === 'insufficient_ph') {
            return 'PH disponivel insuficiente para essa operacao.';
        }
        if (error.code === 'invalid_amount') {
            return 'Quantidade de PH invalida. Use um numero inteiro diferente de 0.';
        }
    }
    return 'Nao consegui alterar o PH agora.';
}

function renderMutationResult(targetId, result, reason) {
    const lines = [
        `PH atualizado para ${formatMention(targetId)}.`,
        '',
        `*Motivo:* ${reason}`,
        `*Ledger:* #${result.ledgerId}`,
        '',
        `*PH acumulado:* ${result.before.phAccumulated} -> ${result.after.phAccumulated}`,
        `*PH disponivel:* ${result.before.phAvailable} -> ${result.after.phAvailable}`,
        `*Estagio:* ${result.before.stageName} -> ${result.after.stageName}`,
        `*PB total:* ${result.before.pbTotal} -> ${result.after.pbTotal}`,
    ];

    if (result.stageChanged || result.pbChanged) {
        lines.push('', '*Estagio/PB recalculados pelo PH acumulado.*');
    }

    return lines.join('\n');
}

function renderAdminHistory(targetId, rows) {
    if (!rows.length) {
        return [
            `Historico de PH de ${formatMention(targetId)}`,
            '',
            'Nenhum lancamento registrado ainda.',
        ].join('\n');
    }

    return [
        `Historico de PH de ${formatMention(targetId)}`,
        '',
        ...rows.map((row) => [
            `*${formatShortDate(row.created_at)}* · ${formatKind(row.kind)} · ${formatAmount(row.amount)} PH`,
            `> Motivo: ${row.reason || '-'}`,
            `> Criado por: ${row.created_by ? formatMention(row.created_by) : '-'}`,
        ].join('\n')),
    ].join('\n\n');
}

function isPhEligiblePlayer(player) {
    const ficha = normalizeText(player?.ficha_status || '');
    const jogo = normalizeText(player?.jogo_status || '');
    const characterName = normalizeText(player?.personagem_nome || '');

    return jogo === 'liberado'
        || ficha === 'aprovada'
        || ficha === 'confirmada'
        || Boolean(characterName && characterName !== '-');
}

module.exports = {
    nome: `${COMMAND_PREFIX}darph`,
    aliases: [
        `${COMMAND_PREFIX}dar ph`,
        `${COMMAND_PREFIX}tirarph`,
        `${COMMAND_PREFIX}tirar ph`,
        `${COMMAND_PREFIX}retirarph`,
        `${COMMAND_PREFIX}retirar ph`,
        `${COMMAND_PREFIX}removerph`,
        `${COMMAND_PREFIX}remover ph`,
        `${COMMAND_PREFIX}ajustarph`,
        `${COMMAND_PREFIX}ajustar ph`,
        `${COMMAND_PREFIX}historicoph`,
        `${COMMAND_PREFIX}historico ph`,
        `${COMMAND_PREFIX}histórico ph`,
        `${COMMAND_PREFIX}historico de ph`,
        `${COMMAND_PREFIX}histórico de ph`,
    ],
    descricao: 'Gerencia PH de jogadores.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode gerenciar PH.',
            });
            return;
        }

        const action = resolveAction(matchedCommand);
        const { targetId, targetText, rest } = resolveTargetAndRest(body, m, action);
        if (!targetId && !targetText) {
            await sendReply({ sock, idChat, m, text: renderMissingTarget(action) });
            return;
        }

        const resolvedTarget = await resolveCentralTargetPlayer(db, targetId, targetText, {
            quotedParticipant: getQuotedParticipant(m),
            mechanical: action !== 'history',
        });
        if (!resolvedTarget.ok) {
            await sendReply({ sock, idChat, m, text: resolvedTarget.error });
            return;
        }
        const player = resolvedTarget.player;
        const resolvedTargetId = player.id;

        if (action === 'history') {
            const history = await getPhHistory(db, resolvedTargetId, 10);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [resolvedTargetId],
                text: renderAdminHistory(resolvedTargetId, history),
            });
            return;
        }

        if (!isPhEligiblePlayer(player)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Esse alvo parece ser um cadastro incompleto/placeholder. Use mencao, resposta ou final do numero do personagem aprovado.',
            });
            return;
        }

        const { amount, reason } = parseAmountAndReason(rest);
        if (!Number.isInteger(amount) || amount === 0 || !hasValidReason(reason)) {
            await sendReply({ sock, idChat, m, text: renderMissingAmount(action) });
            return;
        }

        try {
            const metadata = {
                command: matchedCommand,
                chat_id: idChat,
            };
            const source = `comando_${normalizeText(matchedCommand).replace(/[^a-z0-9]+/g, '')}`;
            let result = null;

            if (action === 'give') {
                result = await addPh(db, resolvedTargetId, Math.abs(amount), source, reason, idJogador, metadata);
            } else if (action === 'remove') {
                result = await removeAvailablePh(db, resolvedTargetId, Math.abs(amount), source, reason, idJogador, metadata);
            } else if (action === 'adjust') {
                result = await adminAdjustPh(db, resolvedTargetId, amount, reason, idJogador, { source, metadata });
            }

            if (!result) {
                await sendReply({ sock, idChat, m, text: renderMissingTarget(action) });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [resolvedTargetId],
                text: renderMutationResult(resolvedTargetId, result, reason),
            });
        } catch (error) {
            await sendReply({ sock, idChat, m, text: renderPhError(error) });
        }
    },
};
