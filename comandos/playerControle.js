const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    formatMention,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    resetPlayerActivity,
} = require('../helpers/clover/antiGhostService');

function normalizeAction(value) {
    const text = normalizeText(value || '').replace(/[^a-z0-9]+/g, '');
    if (['ativar', 'ativo', 'reativar', 'liberar'].includes(text)) return 'activate';
    if (['desativar', 'inativo', 'bloquear', 'pausar'].includes(text)) return 'deactivate';
    if (['status', 'ver', 'info'].includes(text)) return 'status';
    return '';
}

function inferActionFromCommand(command) {
    const text = normalizeText(command || '').replace(/[^a-z0-9]+/g, '');
    if (text.includes('ativarplayer') || text.includes('ativarjogador')) return 'activate';
    if (text.includes('desativarplayer') || text.includes('desativarjogador')) return 'deactivate';
    return '';
}

function splitAction(body, matchedCommand) {
    const inferred = inferActionFromCommand(matchedCommand);
    if (inferred) {
        return { action: inferred, rest: String(body || '').trim() };
    }

    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return {
        action: normalizeAction(match?.[1] || ''),
        rest: String(match?.[2] || '').trim(),
    };
}

function parseKeyValues(text) {
    const kv = {};
    const regex = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const key = String(match[1] || '').toLowerCase().trim();
        const value = String(match[2] || '').trim().replace(/^["']|["']$/g, '');
        if (key) kv[key] = value;
    }
    return kv;
}

function stripKeyValues(text) {
    return String(text || '')
        .replace(/([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function renderUsage() {
    return [
        '*♧┃CONTROLE DE PLAYER 𖥔 CLOVER MULTICOLOR*',
        '     ── ativar e desativar manualmente ──',
        '',
        '_`─( ✓ )───── Uso`_',
        '',
        `> ${COMMAND_PREFIX}ativarplayer @player motivo`,
        `> ${COMMAND_PREFIX}desativarplayer 1234 motivo`,
        `> ${COMMAND_PREFIX}player ativar personagem="Nome do Personagem" motivo="correção manual"`,
        `> ${COMMAND_PREFIX}player desativar tel=8599136380 motivo="pausa manual"`,
    ].join('\n');
}

async function resolveControlTarget(db, rest, m) {
    const kv = parseKeyValues(rest);
    const clean = stripKeyValues(rest);
    const targetData = resolveTargetAndRest(clean, m);
    const hasDirectContext = targetData.source === 'mention' || targetData.source === 'quote';
    const targetOptions = { mechanical: true };

    let resolved = null;
    if (hasDirectContext) {
        resolved = await resolveTargetPlayer(db, targetData.targetId, targetData.targetText, targetOptions);
    } else if (kv.tel || kv.telefone || kv.phone) {
        resolved = await resolveTargetPlayer(db, null, kv.tel || kv.telefone || kv.phone, targetOptions);
    } else if (kv.personagem || kv.personagem_nome || kv.nome) {
        resolved = await resolveTargetPlayer(db, null, kv.personagem || kv.personagem_nome || kv.nome, targetOptions);
    } else {
        resolved = await resolveTargetPlayer(db, targetData.targetId, targetData.targetText, targetOptions);
    }

    if (!resolved.ok) return resolved;

    return {
        ...resolved,
        reason: kv.motivo || kv.reason || targetData.rest || clean || 'controle manual',
    };
}

async function setPlayerActiveState(db, playerId, action, actorId, reason) {
    if (action === 'activate') {
        await db.run(
            `UPDATE jogadores
             SET jogo_status = 'liberado',
                 jogo_bloqueio_motivo = NULL,
                 jogo_liberado_at = CURRENT_TIMESTAMP,
                 jogo_liberado_by = ?,
                 canonical_player_id = COALESCE(canonical_player_id, id),
                 is_shadow = 0,
                 identity_status = 'active'
             WHERE id = ?`,
            [actorId, playerId]
        );
        await resetPlayerActivity(db, playerId, reason || 'ativação manual');
        return;
    }

    await db.run(
        `UPDATE jogadores
         SET jogo_status = 'bloqueado',
             jogo_bloqueio_motivo = ?,
             identity_status = 'inactive'
         WHERE id = ?`,
        [reason || 'desativação manual', playerId]
    );
}

function renderResult({ player, before, action, reason }) {
    const active = action === 'activate';
    return [
        active
            ? '*♧┃PLAYER ATIVADO 𖥔 CLOVER MULTICOLOR*'
            : '*♧┃PLAYER DESATIVADO 𖥔 CLOVER MULTICOLOR*',
        active
            ? '     ── registro liberado manualmente ──'
            : '     ── registro bloqueado manualmente ──',
        '',
        '_`─( ✓ )───── Alvo`_',
        '',
        `*Player:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        `*Antes:* ${before.jogo_status || '-'} / ${before.identity_status || '-'}`,
        `*Agora:* ${active ? 'liberado / active' : 'bloqueado / inactive'}`,
        `*Motivo:* ${reason || 'controle manual'}`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}player`,
    aliases: [
        `${COMMAND_PREFIX}jogador`,
        `${COMMAND_PREFIX}ativarplayer`,
        `${COMMAND_PREFIX}ativarjogador`,
        `${COMMAND_PREFIX}desativarplayer`,
        `${COMMAND_PREFIX}desativarjogador`,
    ],
    descricao: 'Ativa ou desativa manualmente um player canônico.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!isOwner(idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode ativar ou desativar players manualmente.' });
            return;
        }

        const { action, rest } = splitAction(body, matchedCommand);
        if (!['activate', 'deactivate'].includes(action) || !rest) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        const target = await resolveControlTarget(db, rest, m);
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error || 'Não consegui resolver esse player.' });
            return;
        }

        const before = {
            jogo_status: target.player.jogo_status,
            identity_status: target.player.identity_status,
        };
        await setPlayerActiveState(db, target.player.id, action, idJogador, target.reason);
        const updated = await resolveTargetPlayer(db, target.player.id, '', { mechanical: true });

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [target.player.id],
            text: renderResult({
                player: updated.ok ? updated.player : target.player,
                before,
                action,
                reason: target.reason,
            }),
        });
    },
};
