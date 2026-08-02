const { COMMAND_PREFIX } = require('../config/bot');
const { sendPrivateText, sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { isOwner, isSameUser, normalizeJid } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    isAppearanceApproved,
    isFichaApproved,
} = require('../helpers/clover/playerPhase');
const { syncArchiveCardForPlayer } = require('../helpers/clover/archiveManager');
const { ensureCharacterStats } = require('../helpers/clover/characterStats');
const { ensurePhState } = require('../helpers/clover/phService');

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
    if (raw.includes('@')) return normalizeJid(raw);

    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;
    return digits.length > 13 ? `${digits}@lid` : `${digits}@s.whatsapp.net`;
}

function resolveTarget(body, m) {
    const mentions = getMentions(m);
    if (mentions.length) {
        const reason = String(body || '').replace(/@\d+/g, '').trim();
        return { targetId: mentions[0], reason };
    }

    const quoted = getQuotedParticipant(m);
    if (quoted) {
        return { targetId: quoted, reason: String(body || '').trim() };
    }

    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    const targetId = jidFromToken(parts[0]);
    return {
        targetId,
        reason: targetId ? parts.slice(1).join(' ').trim() : '',
    };
}

function resolveAction(matchedCommand, body) {
    const command = normalizeText(matchedCommand);
    const text = normalizeText(body);

    if (command.includes('aprovarhistoria') || text.startsWith('aprovarhistoria')) return 'approve_story';
    if (command.includes('negarhistoria') || text.startsWith('negarhistoria')) return 'deny_story';
    if (command.includes('liberarjogo') || text.startsWith('liberarjogo')) return 'release_game';
    if (command.includes('bloquearjogo') || text.startsWith('bloquearjogo')) return 'block_game';
    return null;
}

function renderMissingTarget() {
    return [
        'Informe o player por mencao, numero ou respondendo uma mensagem dele.',
        '',
        `Exemplo: *${COMMAND_PREFIX}aprovarhistoria @player*`,
    ].join('\n');
}

function renderMissingRequirements(player) {
    const missing = [];
    if (!isFichaApproved(player)) missing.push('ficha base aprovada');
    if (!isAppearanceApproved(player)) missing.push('aparencia aprovada');

    return [
        '*Nao da para liberar o jogo ainda.*',
        '',
        'Falta:',
        ...missing.map((item) => `> ${item}`),
    ].join('\n');
}

async function getTargetPlayer(db, targetId) {
    if (!targetId) return null;
    const normalizedTarget = normalizeJid(targetId);
    const exact = await db.get('SELECT * FROM jogadores WHERE id = ?', [normalizedTarget]);
    if (exact) return exact;

    const players = await db.all('SELECT * FROM jogadores');
    const matches = players.filter((player) => isSameUser(player.id, normalizedTarget));
    if (!matches.length) return null;

    matches.sort((left, right) => scorePlayerState(right) - scorePlayerState(left));
    return matches[0];
}

function normalizePlayerStateStatus(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function hasFilledPlayerField(value) {
    const normalized = String(value || '').trim();
    return Boolean(normalized) && normalized !== '-';
}

function scorePlayerState(player) {
    if (!player) return -1;

    let score = 0;
    const gameStatus = normalizePlayerStateStatus(player.jogo_status);
    const profileStatus = normalizePlayerStateStatus(player.ficha_status);
    const storyStatus = normalizePlayerStateStatus(player.historia_status);
    const appearanceStatus = normalizePlayerStateStatus(player.personagem_aparencia_status);
    const distributionStatus = normalizePlayerStateStatus(player.distribution_status);

    if (gameStatus === 'liberado') score += 1000;
    if (['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(profileStatus)) score += 500;
    if (['aprovada', 'aprovado'].includes(storyStatus)) score += 100;
    if (['approved', 'aprovada', 'aprovado'].includes(appearanceStatus)) score += 100;
    if (distributionStatus === 'confirmed') score += 50;

    for (const field of ['personagem_nome', 'nome', 'raca', 'classe', 'grimorio', 'magia']) {
        if (hasFilledPlayerField(player[field])) score += 10;
    }

    return score;
}

async function notifyPlayer(sock, fallbackChatId, playerId, text, policy = {}) {
    try {
        await sendPrivateText({ sock, playerId, text, policy });
        return true;
    } catch {
        if (fallbackChatId?.endsWith('@g.us')) {
            await sock.sendMessage(fallbackChatId, {
                text: `@${String(playerId).split('@')[0]}\n\n${text}`,
                mentions: [playerId],
            });
        }
        return false;
    }
}

async function syncArchiveSafely(sock, db, playerId, context) {
    try {
        await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log(`[arquivo:${context}] Nao consegui sincronizar ${playerId}:`, error?.message || error);
    }
}

async function approveStory({ sock, m, idChat, idJogador, db, targetId }) {
    const player = await getTargetPlayer(db, targetId);
    if (!player) {
        await sendReply({ sock, idChat, m, text: 'Player nao encontrado no banco.' });
        return;
    }
    targetId = player.id;

    const shouldReleaseGame = isFichaApproved(player) && isAppearanceApproved(player);
    await db.run(
        `UPDATE jogadores
         SET historia_status = 'aprovada',
             historia_aprovada_at = CURRENT_TIMESTAMP,
             historia_aprovada_by = ?,
             historia_status_updated_at = CURRENT_TIMESTAMP,
             historia_motivo = NULL,
             jogo_status = CASE WHEN ? = 1 THEN 'liberado' WHEN jogo_status = 'liberado' THEN jogo_status ELSE 'historia_aprovada' END,
             jogo_liberado_at = CASE WHEN ? = 1 THEN COALESCE(jogo_liberado_at, CURRENT_TIMESTAMP) ELSE jogo_liberado_at END,
             jogo_liberado_by = CASE WHEN ? = 1 THEN COALESCE(jogo_liberado_by, ?) ELSE jogo_liberado_by END,
             jogo_bloqueio_motivo = CASE WHEN ? = 1 THEN NULL ELSE jogo_bloqueio_motivo END
         WHERE id = ?`,
        [
            idJogador,
            shouldReleaseGame ? 1 : 0,
            shouldReleaseGame ? 1 : 0,
            shouldReleaseGame ? 1 : 0,
            idJogador,
            shouldReleaseGame ? 1 : 0,
            targetId,
        ]
    );

    if (shouldReleaseGame) {
        await ensureCharacterStats(db, targetId);
        await ensurePhState(db, targetId);
    }

    await syncArchiveSafely(sock, db, targetId, 'aprovarhistoria');

    await sendReply({
        sock,
        idChat,
        m,
        mentions: [targetId],
        text: shouldReleaseGame
            ? `Historia/persona de @${String(targetId).split('@')[0]} aprovada. O jogo ja esta liberado.`
            : `Historia/persona de @${String(targetId).split('@')[0]} aprovada. Falta ficha/aparencia para liberar o jogo.`,
    });
}

async function denyStory({ sock, m, idChat, idJogador, db, targetId, reason }) {
    const player = await getTargetPlayer(db, targetId);
    if (!player) {
        await sendReply({ sock, idChat, m, text: 'Player nao encontrado no banco.' });
        return;
    }
    targetId = player.id;

    await db.run(
        `UPDATE jogadores
         SET historia_status = 'negada',
             historia_status_updated_at = CURRENT_TIMESTAMP,
             historia_motivo = ?,
             jogo_status = 'aguardando_historia',
             jogo_bloqueio_motivo = ?
         WHERE id = ?`,
        [reason || null, reason || null, targetId]
    );

    await syncArchiveSafely(sock, db, targetId, 'negarhistoria');

    await notifyPlayer(sock, idChat, targetId, [
        '*Historia/persona precisa de ajuste.*',
        '',
        reason ? `Motivo: ${reason}` : 'A administracao pediu ajustes na historia/persona.',
    ].join('\n'), {
        source: 'history_adjustment',
        dedupeKey: `history_adjustment:${targetId}:${m?.key?.id || 'manual'}`,
    });

    await sendReply({
        sock,
        idChat,
        m,
        mentions: [targetId],
        text: `Historia/persona de @${String(targetId).split('@')[0]} marcada para ajuste.`,
    });
}

async function releaseGame({ sock, m, idChat, idJogador, db, targetId }) {
    const player = await getTargetPlayer(db, targetId);
    if (!player) {
        await sendReply({ sock, idChat, m, text: 'Player nao encontrado no banco.' });
        return;
    }
    targetId = player.id;

    if (!isFichaApproved(player) || !isAppearanceApproved(player)) {
        await sendReply({ sock, idChat, m, text: renderMissingRequirements(player) });
        return;
    }

    await db.run(
        `UPDATE jogadores
         SET jogo_status = 'liberado',
             jogo_liberado_at = CURRENT_TIMESTAMP,
             jogo_liberado_by = ?,
             jogo_bloqueio_motivo = NULL
         WHERE id = ?`,
        [idJogador, targetId]
    );

    await db.run(
        `INSERT INTO player_onboarding
         (player_id, current_step, step_payload, started_at, welcome_sent_at, last_seen_at)
         VALUES (?, 'jogo_liberado', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET
             current_step = 'jogo_liberado',
             step_payload = ?,
             last_seen_at = CURRENT_TIMESTAMP`,
        [targetId, JSON.stringify({ last_message: 'jogo_liberado' })]
    );

    await ensureCharacterStats(db, targetId);
    await ensurePhState(db, targetId);
    await syncArchiveSafely(sock, db, targetId, 'liberarjogo');

    await notifyPlayer(sock, idChat, targetId, [
        '*Personagem liberado para o jogo.*',
        '',
        `Use *${COMMAND_PREFIX}atributos* para distribuir seus PB iniciais.`,
    ].join('\n'), {
        source: 'game_release',
        dedupeKey: `game_release:${targetId}:${m?.key?.id || 'manual'}`,
    });

    await sendReply({
        sock,
        idChat,
        m,
        mentions: [targetId],
        text: `Jogo liberado para @${String(targetId).split('@')[0]}.`,
    });
}

async function blockGame({ sock, m, idChat, idJogador, db, targetId, reason }) {
    const player = await getTargetPlayer(db, targetId);
    if (!player) {
        await sendReply({ sock, idChat, m, text: 'Player nao encontrado no banco.' });
        return;
    }
    targetId = player.id;

    await db.run(
        `UPDATE jogadores
         SET jogo_status = 'bloqueado',
             jogo_bloqueio_motivo = ?,
             jogo_liberado_at = NULL,
             jogo_liberado_by = NULL
         WHERE id = ?`,
        [reason || null, targetId]
    );

    await syncArchiveSafely(sock, db, targetId, 'bloquearjogo');

    await notifyPlayer(sock, idChat, targetId, [
        '*Acesso ao jogo bloqueado.*',
        '',
        reason ? `Motivo: ${reason}` : 'A administracao bloqueou temporariamente seu acesso aos sistemas de jogo.',
    ].join('\n'), {
        source: 'game_block',
        dedupeKey: `game_block:${targetId}:${m?.key?.id || 'manual'}`,
    });

    await sendReply({
        sock,
        idChat,
        m,
        mentions: [targetId],
        text: `Jogo bloqueado para @${String(targetId).split('@')[0]}.`,
    });
}

module.exports = {
    nome: `${COMMAND_PREFIX}aprovarhistoria`,
    aliases: [
        `${COMMAND_PREFIX}negarhistoria`,
        `${COMMAND_PREFIX}liberarjogo`,
        `${COMMAND_PREFIX}bloquearjogo`,
    ],
    descricao: 'Gerencia aprovacao de historia e liberacao de jogo.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, body, matchedCommand, db }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode gerenciar historia/jogo.',
            });
            return;
        }

        const action = resolveAction(matchedCommand, body);
        const { targetId, reason } = resolveTarget(body, m);
        if (!targetId) {
            await sendReply({ sock, idChat, m, text: renderMissingTarget() });
            return;
        }

        if (action === 'approve_story') {
            await approveStory({ sock, m, idChat, idJogador, db, targetId });
            return;
        }
        if (action === 'deny_story') {
            await denyStory({ sock, m, idChat, idJogador, db, targetId, reason });
            return;
        }
        if (action === 'release_game') {
            await releaseGame({ sock, m, idChat, idJogador, db, targetId });
            return;
        }
        if (action === 'block_game') {
            await blockGame({ sock, m, idChat, idJogador, db, targetId, reason });
            return;
        }

        await sendReply({ sock, idChat, m, text: renderMissingTarget() });
    },
};
