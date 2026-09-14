const { assertLifecycleAllowed, lifecycleSkip, isPreResetLifecycle } = require('./lifecyclePolicy');
const { randomUUID } = require('node:crypto');

const { sendReply } = require('../chatReply');
const { isSameUser, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const { resolvePlayerPhoneDigits } = require('./archiveManager');
const { getGroupInviteLink } = require('./groupManager');
const { archiveAndResetPlayer } = require('./playerReset');
const { resolveTargetDetails } = require('./targetResolver');

const EXIT_STATUS = {
    PENDING: 'pending',
    CANCELLED: 'cancelled',
    CONFIRMED: 'confirmed',
    EXPIRED: 'expired',
};

const CLAIM_STALE_MINUTES = Math.max(
    5,
    Number.parseInt(process.env.CLOVER_EXIT_CLAIM_STALE_MINUTES || '15', 10) || 15
);
const RECENT_RELEASE_GRACE_DAYS = Math.max(
    0,
    Number.isFinite(Number.parseInt(process.env.CLOVER_EXIT_RECENT_RELEASE_GRACE_DAYS || '7', 10))
        ? Number.parseInt(process.env.CLOVER_EXIT_RECENT_RELEASE_GRACE_DAYS || '7', 10)
        : 7
);

async function tableColumns(db, tableName) {
    return new Set((await db.all(`PRAGMA table_info(${tableName})`)).map((column) => column.name));
}

async function ensureExitConfirmationSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_exit_confirmations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            source_group_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'cancelled', 'confirmed', 'expired')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            responded_at TEXT DEFAULT NULL,
            response_text TEXT DEFAULT NULL,
            backup_path TEXT DEFAULT NULL
        )
    `);

    const columns = await tableColumns(db, 'clover_exit_confirmations');
    if (!columns.has('processing_token')) {
        await db.exec('ALTER TABLE clover_exit_confirmations ADD COLUMN processing_token TEXT DEFAULT NULL');
    }
    if (!columns.has('processing_started_at')) {
        await db.exec('ALTER TABLE clover_exit_confirmations ADD COLUMN processing_started_at TEXT DEFAULT NULL');
    }
    if (!columns.has('last_error')) {
        await db.exec('ALTER TABLE clover_exit_confirmations ADD COLUMN last_error TEXT DEFAULT NULL');
    }

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_exit_confirmations_player_status
        ON clover_exit_confirmations (player_id, status, expires_at)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_exit_confirmations_processing
        ON clover_exit_confirmations (status, processing_token, processing_started_at)
    `);

    await db.run(`
        UPDATE clover_exit_confirmations
        SET status = 'cancelled',
            responded_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            response_text = 'deduplicated_pending',
            processing_token = NULL,
            processing_started_at = NULL,
            last_error = NULL
        WHERE status = 'pending'
          AND EXISTS (
              SELECT 1
              FROM clover_exit_confirmations newer
              WHERE newer.player_id = clover_exit_confirmations.player_id
                AND newer.status = 'pending'
                AND newer.id > clover_exit_confirmations.id
          )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_clover_exit_confirmations_one_pending_per_player
        ON clover_exit_confirmations (player_id)
        WHERE status = 'pending'
    `);
}

function renderCommunityExitMessageClean() {
    return [
        '*♧┃MIMOSA NOTOU SUA AUSÊNCIA 𖥔 CLOVER MULTICOLOR*',
        '     ── saída da comunidade ──',
        '',
        '_`─( ! )───── Ei...`_',
        '',
        '*Você saiu da comunidade oficial.*',
        '',
        '> Foi de propósito?',
        '',
        '*SIM*',
        '> Eu encerro seu registro e libero sua vaga.',
        '',
        '*NÃO*',
        '> Eu te mando o caminho de volta, mas você precisa entrar de novo.',
        '',
        '_`─( ◆ )───── Importante`_',
        '',
        '> Responder NÃO não segura personagem sozinho.',
        '> O registro só volta ao normal quando você entrar na comunidade novamente.',
    ].join('\n');
}

function renderExitCancelledMessageClean() {
    return [
        '*♧┃RETORNO CONFIRMADO 𖥔 CLOVER MULTICOLOR*',
        '     ── situação regularizada ──',
        '',
        'Vi que você voltou para a comunidade.',
        '',
        'Seu personagem continua salvo normalmente.',
        'Obrigada por resolver.',
    ].join('\n');
}

function renderExitConfirmedMessageClean() {
    return [
        '*♧┃REGISTRO ENCERRADO 𖥔 CLOVER MULTICOLOR*',
        '     ── saída confirmada ──',
        '',
        'Entendido.',
        '',
        'Seu registro foi encerrado e sua vaga foi liberada.',
        '',
        'Se isso foi um engano, fale com a administração.',
    ].join('\n');
}

function renderReturnPendingMessage(link) {
    return [
        '*♧┃RETORNO PENDENTE 𖥔 CLOVER MULTICOLOR*',
        '     ── aguardando sua entrada ──',
        '',
        'Certo. Vou considerar que você quer continuar.',
        '',
        'Te enviei o caminho de volta para a comunidade.',
        'Quando você entrar novamente, sua situação volta ao normal.',
        '',
        '_`─( ! )───── Atenção`_',
        '',
        'Se não conseguir entrar, fale com a staff.',
        'Se não voltar dentro do prazo, seu personagem volta para risco de remoção.',
        '',
        'Convite:',
        `> ${link || 'não consegui gerar o convite agora. Fale com a staff.'}`,
    ].join('\n');
}

function renderRecentReleaseGraceMessage(link) {
    return [
        '*CLOVER MULTICOLOR - retorno protegido*',
        '',
        'Vi que voce saiu da comunidade pouco depois de liberar o jogo.',
        'Seu personagem nao foi arquivado automaticamente.',
        '',
        'Entre de novo pela comunidade para manter tudo regularizado:',
        `> ${link || 'nao consegui gerar o convite agora. Fale com a staff.'}`,
        '',
        'Se a saida foi definitiva, fale com a administracao para encerrar o registro.',
    ].join('\n');
}

function classifyExitReply(text) {
    const normalized = normalizeText(text).replace(/[^a-z0-9]+/g, ' ').trim();
    if (['sim', 's', 'si', 'yes'].includes(normalized)) return 'yes';
    if (['nao', 'n', 'no'].includes(normalized)) return 'no';
    return null;
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function getComparablePhoneDigits(jid) {
    const mapped = resolvePlayerPhoneDigits(jid);
    if (mapped) return mapped;

    const normalized = normalizeJid(jid);
    if (!normalized) return '';

    const [userPart, domain] = normalized.split('@');
    if (domain === 'lid') return '';
    return extractDigits(userPart);
}

function isSamePlayerIdentity(playerId, participantId) {
    if (isSameUser(playerId, participantId)) return true;
    if (normalizeJid(playerId) === normalizeJid(participantId)) return true;

    const playerDigits = getComparablePhoneDigits(playerId);
    const participantDigits = getComparablePhoneDigits(participantId);
    return Boolean(playerDigits) && playerDigits === participantDigits;
}

async function findPlayerByParticipant(db, participantId) {
    const normalized = normalizeJid(participantId);
    if (!normalized) return null;

    const resolved = await resolveTargetDetails(db, {
        targetId: normalized,
        targetText: normalized,
    }).catch(() => null);
    if (resolved?.ok && resolved.player) return resolved.player;

    const rows = await db.all(
        `SELECT *
         FROM jogadores
         WHERE ficha_status = 'aprovada'
            OR personagem_aparencia_status IN ('approved', 'aprovada')
            OR jogo_status = 'liberado'`
    );

    return rows.find((player) => isSamePlayerIdentity(player.id, normalized)) || null;
}

function parseSqliteTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
        ? normalized
        : `${normalized}Z`;
    const timestamp = Date.parse(withTimezone);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function isWithinRecentReleaseGrace(player, nowMs = Date.now()) {
    if (!player || RECENT_RELEASE_GRACE_DAYS <= 0) return false;
    if (String(player.jogo_status || '').toLowerCase() !== 'liberado') return false;

    const releasedAt = parseSqliteTimestamp(player.jogo_liberado_at);
    if (!releasedAt) return false;

    const graceMs = RECENT_RELEASE_GRACE_DAYS * 24 * 60 * 60 * 1000;
    return nowMs - releasedAt <= graceMs;
}

async function readExitPlayer(db, playerId) {
    try {
        return await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    } catch (error) {
        if (/no such table/i.test(error?.message || '')) return null;
        throw error;
    }
}

function availableClaimSql() {
    return `(
        processing_token IS NULL
        OR processing_started_at IS NULL
        OR datetime(processing_started_at) <= datetime('now', '-${CLAIM_STALE_MINUTES} minutes')
    )`;
}

async function getPendingExitConfirmation(db, playerId) {
    await ensureExitConfirmationSchema(db);
    const exact = await db.get(
        `SELECT *
         FROM clover_exit_confirmations
         WHERE player_id = ?
           AND status = 'pending'
           AND ${availableClaimSql()}
         ORDER BY id DESC
         LIMIT 1`,
        [playerId]
    );
    if (exact) return exact;

    const pendingRows = await db.all(
        `SELECT *
         FROM clover_exit_confirmations
         WHERE status = 'pending'
           AND ${availableClaimSql()}
         ORDER BY id DESC
         LIMIT 100`
    );
    return pendingRows.find((row) => isSamePlayerIdentity(row.player_id, playerId)) || null;
}

async function claimExitConfirmation(db, confirmationId) {
    await ensureExitConfirmationSchema(db);
    const token = randomUUID();
    const result = await db.run(
        `UPDATE clover_exit_confirmations
         SET processing_token = ?,
             processing_started_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP,
             last_error = NULL
         WHERE id = ?
           AND status = 'pending'
           AND ${availableClaimSql()}`,
        [token, confirmationId]
    );

    return result.changes === 1
        ? { ok: true, token }
        : { ok: false, reason: 'already_claimed' };
}

async function releaseExitConfirmationClaim(db, confirmationId, token, error = null) {
    await db.run(
        `UPDATE clover_exit_confirmations
         SET processing_token = NULL,
             processing_started_at = NULL,
             updated_at = CURRENT_TIMESTAMP,
             last_error = ?
         WHERE id = ?
           AND processing_token = ?`,
        [error ? String(error).slice(0, 1000) : null, confirmationId, token]
    );
}

async function createOrRefreshExitConfirmation({ sock, db, groupId, participantId }) {
    assertLifecycleAllowed({surface:'internal',operation:'createOrRefreshExitConfirmation',mutationClass:'CURRENT_WORLD'});

    await ensureExitConfirmationSchema(db);
    const player = await findPlayerByParticipant(db, participantId);
    if (!player) return { ok: false, reason: 'player_not_found' };

    const existing = await getPendingExitConfirmation(db, player.id);
    if (isWithinRecentReleaseGrace(player)) {
        const link = await getGroupInviteLink(sock, db, 'community').catch(() => null);
        if (existing) {
            await db.run(
                `UPDATE clover_exit_confirmations
                 SET status = 'cancelled',
                     responded_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP,
                     response_text = 'recent_release_grace',
                     processing_token = NULL,
                     processing_started_at = NULL
                 WHERE id = ?
                   AND status = 'pending'
                   AND ${availableClaimSql()}`,
                [existing.id]
            );
        }
        await sendReply({
            sock,
            idChat: player.id,
            text: renderRecentReleaseGraceMessage(link),
            policy: {
                source: 'community_exit_confirmation',
                dedupeKey: `community_exit_grace:${player.id}:${player.jogo_liberado_at || 'current'}`,
            },
        });
        return { ok: true, skipped: true, reason: 'recent_release_grace', player };
    }

    if (existing) {
        await db.run(
            `UPDATE clover_exit_confirmations
             SET source_group_id = ?,
                 updated_at = CURRENT_TIMESTAMP,
                 expires_at = datetime('now', '+72 hours')
             WHERE id = ?`,
            [groupId, existing.id]
        );
        return { ok: true, skipped: true, reason: 'already_pending', player };
    }

    const created = await db.run(
        `INSERT OR IGNORE INTO clover_exit_confirmations
         (player_id, source_group_id, status, expires_at)
         VALUES (?, ?, 'pending', datetime('now', '+72 hours'))`,
        [player.id, groupId]
    );

    if (created.changes !== 1) {
        const concurrent = await getPendingExitConfirmation(db, player.id);

        if (!concurrent) {
            const error = new Error('A confirmação concorrente não pôde ser recuperada.');
            error.code = 'exit_pending_conflict_unresolved';
            throw error;
        }

        await db.run(
            `UPDATE clover_exit_confirmations
             SET source_group_id = ?,
                 updated_at = CURRENT_TIMESTAMP,
                 expires_at = datetime('now', '+72 hours')
             WHERE id = ?
               AND status = 'pending'`,
            [groupId, concurrent.id]
        );

        return { ok: true, skipped: true, reason: 'already_pending', player };
    }

    await sendReply({
        sock,
        idChat: player.id,
        text: renderCommunityExitMessageClean(),
        policy: {
            source: 'community_exit_confirmation',
            dedupeKey: `community_exit:${player.id}:${created?.lastID || groupId}`,
        },
    });
    return { ok: true, player };
}

async function cancelPendingExitForReturn({ sock, db, participantId }) {
    await ensureExitConfirmationSchema(db);
    const player = await findPlayerByParticipant(db, participantId);
    if (!player) return { ok: false, reason: 'player_not_found' };

    const pending = await getPendingExitConfirmation(db, player.id);
    if (!pending) return { ok: false, reason: 'no_pending', player };

    const result = await db.run(
        `UPDATE clover_exit_confirmations
         SET status = 'cancelled',
             responded_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP,
             response_text = 'return',
             processing_token = NULL,
             processing_started_at = NULL
         WHERE id = ?
           AND status = 'pending'
           AND ${availableClaimSql()}`,
        [pending.id]
    );
    if (result.changes !== 1) return { ok: false, reason: 'already_processing', player };

    await sendReply({
        sock,
        idChat: player.id,
        text: renderExitCancelledMessageClean(),
        policy: {
            source: 'community_exit_confirmation',
            dedupeKey: `community_exit_cancel:${player.id}:${pending.id}`,
        },
    });
    return { ok: true, player };
}

async function confirmExitAndReset({
    sock,
    db,
    playerId,
    confirmationId,
    status,
    responseText,
    archivePlayerFn = archiveAndResetPlayer,
}) {
    assertLifecycleAllowed({surface:'internal',operation:'confirmExitAndReset',mutationClass:'CURRENT_WORLD'});

    const claim = await claimExitConfirmation(db, confirmationId);
    if (!claim.ok) return { ok: false, skipped: true, reason: claim.reason };

    try {
        const player = await readExitPlayer(db, playerId);
        if (isWithinRecentReleaseGrace(player)) {
            const updated = await db.run(
                `UPDATE clover_exit_confirmations
                 SET status = 'cancelled',
                     responded_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP,
                     response_text = ?,
                     backup_path = NULL,
                     processing_token = NULL,
                     processing_started_at = NULL,
                     last_error = NULL
                 WHERE id = ?
                   AND processing_token = ?`,
                [
                    responseText ? `recent_release_grace:${responseText}` : 'recent_release_grace',
                    confirmationId,
                    claim.token,
                ]
            );

            if (updated.changes !== 1) {
                const error = new Error('A confirmacao perdeu a posse atomica antes de concluir a carencia.');
                error.code = 'exit_claim_lost';
                throw error;
            }

            return { ok: true, skipped: true, reason: 'recent_release_grace' };
        }

        const result = await archivePlayerFn({
            sock,
            db,
            playerId,
            reason: status === EXIT_STATUS.EXPIRED ? 'community-exit-expired' : 'community-exit-confirmed',
        });

        const updated = await db.run(
            `UPDATE clover_exit_confirmations
             SET status = ?,
                 responded_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP,
                 response_text = ?,
                 backup_path = ?,
                 processing_token = NULL,
                 processing_started_at = NULL,
                 last_error = NULL
             WHERE id = ?
               AND processing_token = ?`,
            [status, responseText || null, result.backupPath || null, confirmationId, claim.token]
        );

        if (updated.changes !== 1) {
            const error = new Error('A confirmação perdeu a posse atômica antes de concluir.');
            error.code = 'exit_claim_lost';
            throw error;
        }

        return result;
    } catch (error) {
        const normalizedError = normalizeText(error?.message || error || '');
        const noValidCharacter = normalizedError.includes(
            'nao possui personagem valido para arquivar'
        );

        if (noValidCharacter) {
            const terminalResponse = responseText
                ? `${responseText}:no_valid_character`
                : 'no_valid_character';

            const updated = await db.run(
                `UPDATE clover_exit_confirmations
                 SET status = ?,
                     responded_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP,
                     response_text = ?,
                     backup_path = NULL,
                     processing_token = NULL,
                     processing_started_at = NULL,
                     last_error = ?
                 WHERE id = ?
                   AND processing_token = ?`,
                [
                    status,
                    terminalResponse,
                    String(error?.message || error || 'player_not_archivable').slice(0, 1000),
                    confirmationId,
                    claim.token,
                ]
            );

            if (updated.changes !== 1) {
                const claimError = new Error('A confirmação perdeu a posse antes do encerramento terminal.');
                claimError.code = 'exit_claim_lost';
                throw claimError;
            }

            return {
                ok: true,
                mode: 'no_archive_required',
                noArchiveRequired: true,
                reason: 'player_not_archivable',
                backupPath: null,
            };
        }

        await releaseExitConfirmationClaim(
            db,
            confirmationId,
            claim.token,
            error?.message || error
        ).catch(() => null);

        throw error;
    }
}

async function sendPrivateExitReply({ sock, playerId, text, sendPrivateTextFn }) {
    const policy = { source: 'community_exit_reply' };
    if (typeof sendPrivateTextFn === 'function') {
        return sendPrivateTextFn({ sock, playerId, text, policy });
    }
    return sendReply({ sock, idChat: playerId, text, policy });
}

async function handleExitConfirmationReply({ sock, db, playerId, text, sendPrivateTextFn = null }) {
    const denied = lifecycleSkip({surface:'private_reply',operation:'community_exit.reply',mutationClass:'CURRENT_WORLD'});
    if (denied) return {...denied,handled:false};
    await ensureExitConfirmationSchema(db);
    const pending = await getPendingExitConfirmation(db, playerId);
    if (!pending) return { handled: false };

    const answer = classifyExitReply(text);
    if (!answer) return { handled: false };

    if (answer === 'no') {
        const link = await getGroupInviteLink(sock, db, 'community').catch(() => null);
        const updated = await db.run(
            `UPDATE clover_exit_confirmations
             SET responded_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP,
                 response_text = ?,
                 expires_at = datetime('now', '+48 hours')
             WHERE id = ?
               AND status = 'pending'
               AND ${availableClaimSql()}`,
            [text, pending.id]
        );
        if (updated.changes !== 1) return { handled: true, action: 'already_processing' };

        await sendPrivateExitReply({
            sock,
            playerId,
            text: renderReturnPendingMessage(link),
            sendPrivateTextFn,
        });
        return { handled: true, action: 'return_pending' };
    }

    const result = await confirmExitAndReset({
        sock,
        db,
        playerId,
        confirmationId: pending.id,
        status: EXIT_STATUS.CONFIRMED,
        responseText: text,
    });
    if (result?.skipped) {
        if (result.reason === 'recent_release_grace') {
            const link = await getGroupInviteLink(sock, db, 'community').catch(() => null);
            await sendPrivateExitReply({
                sock,
                playerId,
                text: renderRecentReleaseGraceMessage(link),
                sendPrivateTextFn,
            });
            return { handled: true, action: 'recent_release_grace' };
        }
        return { handled: true, action: 'already_processing' };
    }

    await sendPrivateExitReply({
        sock,
        playerId,
        text: renderExitConfirmedMessageClean(),
        sendPrivateTextFn,
    });
    return { handled: true, action: 'confirmed' };
}

async function processExpiredExitConfirmations({ sock, db, limit = 20, archivePlayerFn = archiveAndResetPlayer }) {
    assertLifecycleAllowed({surface:'internal',operation:'processExpiredExitConfirmations',mutationClass:'CURRENT_WORLD'});

    await ensureExitConfirmationSchema(db);
    const rows = await db.all(
        `SELECT *
         FROM clover_exit_confirmations
         WHERE status = 'pending'
           AND datetime(expires_at) <= datetime('now')
           AND ${availableClaimSql()}
         ORDER BY expires_at ASC
         LIMIT ?`,
        [limit]
    );

    const processed = [];
    for (const row of rows) {
        try {
            const result = await confirmExitAndReset({
                sock,
                db,
                playerId: row.player_id,
                confirmationId: row.id,
                status: EXIT_STATUS.EXPIRED,
                responseText: row.response_text ? `expired:${row.response_text}` : 'expired',
                archivePlayerFn,
            });
            processed.push({
                playerId: row.player_id,
                ok: !result?.skipped,
                skipped: Boolean(result?.skipped),
                reason: result?.reason || null,
                backupPath: result?.backupPath || null,
            });
        } catch (error) {
            processed.push({ playerId: row.player_id, ok: false, error });
            console.log('[community-exit] falha ao expirar saida:', row.player_id, error?.message || error);
        }
    }

    return processed;
}

module.exports = {
    cancelPendingExitForReturn,
    claimExitConfirmation,
    confirmExitAndReset,
    createOrRefreshExitConfirmation,
    ensureExitConfirmationSchema,
    findPlayerByParticipant,
    handleExitConfirmationReply,
    processExpiredExitConfirmations,
    releaseExitConfirmationClaim,
    renderCommunityExitMessage: renderCommunityExitMessageClean,
    renderRecentReleaseGraceMessage,
};
