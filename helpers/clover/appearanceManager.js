const fs = require('fs');
const path = require('path');
const Pino = require('pino');

const { isOwner, isSameUser, getRegisteredOwner } = require('../groupAccess');
const { sendPrivateText } = require('../chatReply');
const { getMessageContextInfo } = require('../messageContext');
const { normalizeText } = require('../textUtils');
const {
    getCloverRegistrationGroup,
    maybeSendPostFichaPrivateInstructions,
    preparePostFichaRelease,
} = require('./registrationManager');
const { syncArchiveCardForPlayer } = require('./archiveManager');
const {
    getPendingConfirmation,
    normalizeAppearanceValue,
    savePendingConfirmation,
} = require('../profileForms');

const APPEARANCE_DIR = path.join(process.cwd(), 'assets', 'appearance');

function ensureAppearanceDir() {
    fs.mkdirSync(APPEARANCE_DIR, { recursive: true });
}

function hasImageMessage(message) {
    return Boolean(message?.message?.imageMessage);
}

function getMessageId(message) {
    return message?.key?.id || null;
}

function getQuotedMessageId(message) {
    return getMessageContextInfo(message)?.stanzaId || null;
}

function safePlayerFilePrefix(playerId) {
    return String(playerId || 'player')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'player';
}

function imageExtensionFromMime(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    return 'jpg';
}

async function saveAppearanceImageFromMessage({
    sock,
    message,
    playerId,
    downloadMediaMessage,
    loggerFactory = Pino,
}) {
    if (!hasImageMessage(message) || !downloadMediaMessage) return null;

    ensureAppearanceDir();
    const mimeType = message.message.imageMessage.mimetype;
    const extension = imageExtensionFromMime(mimeType);
    const filename = `${safePlayerFilePrefix(playerId)}-${Date.now()}.${extension}`;
    const fullPath = path.join(APPEARANCE_DIR, filename);

    const buffer = await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
            logger: loggerFactory({ level: 'silent' }),
            reuploadRequest: sock.updateMediaMessage,
        }
    );

    fs.writeFileSync(fullPath, buffer);
    return {
        imagePath: fullPath,
        messageId: getMessageId(message),
    };
}

function hasStoredAppearanceImage(player) {
    return Boolean(player?.personagem_aparencia_image_path && fs.existsSync(player.personagem_aparencia_image_path));
}

function renderYesNo(value) {
    return value ? 'SIM' : 'NAO';
}

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

async function getGroupAdminMentions(sock, groupId) {
    const mentions = [];
    try {
        const metadata = await sock.groupMetadata(groupId);
        for (const participant of metadata.participants || []) {
            const jid = participant.id || participant.jid || participant.lid;
            if (jid && ['admin', 'superadmin'].includes(participant.admin)) {
                mentions.push(jid);
            }
        }
    } catch {
        // Falha ao ler metadata nao deve travar a recepcao.
    }

    const owner = getRegisteredOwner();
    if (owner.registeredJid) mentions.push(owner.registeredJid);

    return [...new Set(mentions)];
}

async function isGroupAdmin(sock, groupId, playerId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        return (metadata.participants || []).some((participant) => (
            ['admin', 'superadmin'].includes(participant.admin)
            && (
                isSameUser(participant.id, playerId)
                || isSameUser(participant.jid, playerId)
                || isSameUser(participant.lid, playerId)
            )
        ));
    } catch {
        return false;
    }
}

async function canReviewAppearance(sock, groupId, reviewerId) {
    if (isOwner(reviewerId)) return true;
    if (!groupId?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, groupId, reviewerId);
}

function renderReceptionPendingMessage({ playerId, appearance, hasImage, adminMentions }) {
    const adminLine = adminMentions.length
        ? adminMentions.map(formatMention).join(' ')
        : 'ADMs';

    return [
        '𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄',
        '',
        adminLine,
        '',
        `${formatMention(playerId)} quer usar:`,
        '',
        `*${appearance}*`,
        '',
        `> ⤷ Imαgᥱm: *${renderYesNo(hasImage)}*`,
        '',
        'Rᥱspondα ᥱstα mᥱnsαgᥱm com:',
        '',
        '*ok* — αprovαr',
        '*negado* — nᥱgαr',
        '*negado: motivo* — nᥱgαr com motivo',
        '',
        '*ⓘ A prımᥱırα αvαlıαçα̃o vάlıdα fᥱchα ᥱssα αpαrᥱ̂ncıα.*',
    ].join('\n');
}

function renderRegistrationPendingMessage({ playerId, appearance, hasImage }) {
    return [
        '𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄',
        '',
        `${formatMention(playerId)} quer usar:`,
        '',
        `*${appearance}*`,
        '',
        `> ⤷ Imαgᥱm: *${renderYesNo(hasImage)}*`,
        '',
        'ADM podᥱ αvαlıαr:',
        '',
        '✅ — αprovαr',
        '❌ — nᥱgαr',
        '',
        'Ou rᥱspondᥱr:',
        '',
        '*ok*',
        '*negado*',
        '*negado: motivo*',
        '',
        '*ⓘ A prımᥱırα αvαlıαçα̃o vάlıdα fᥱchα ᥱssα αpαrᥱ̂ncıα.*',
    ].join('\n');
}

async function registerAppearanceReviewMessage(db, { playerId, groupId, messageId, scope, appearance, hasImage, appearanceRevision }) {
    if (!groupId || !messageId) return;
    await db.run(
        `INSERT OR IGNORE INTO clover_appearance_reviews
         (player_id, group_id, message_id, scope, appearance, appearance_normalized, has_image, appearance_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            playerId,
            groupId,
            messageId,
            scope,
            appearance,
            normalizeAppearanceValue(appearance),
            hasImage ? 1 : 0,
            appearanceRevision,
        ]
    );
}

async function sendAppearancePendingNotice({ sock, db, playerId, groupId, scope }) {
    if (!groupId?.endsWith('@g.us')) return { skipped: true, reason: 'not_group' };

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    const appearance = player?.personagem_aparencia && player.personagem_aparencia !== '-'
        ? player.personagem_aparencia
        : null;
    if (!appearance) return { skipped: true, reason: 'missing_appearance' };
    if (player.personagem_aparencia_status !== 'pending') return { skipped: true, reason: 'not_pending' };

    const hasImage = hasStoredAppearanceImage(player);
    const adminMentions = scope === 'reception' ? await getGroupAdminMentions(sock, groupId) : [];
    const mentions = scope === 'reception'
        ? [...new Set([playerId, ...adminMentions])]
        : [playerId];
    const text = scope === 'reception'
        ? renderReceptionPendingMessage({ playerId, appearance, hasImage, adminMentions })
        : renderRegistrationPendingMessage({ playerId, appearance, hasImage });

    const message = hasImage
        ? { image: fs.readFileSync(player.personagem_aparencia_image_path), caption: text, mentions }
        : { text, mentions };
    const sent = await sock.sendMessage(groupId, message);

    await registerAppearanceReviewMessage(db, {
        playerId,
        groupId,
        messageId: sent?.key?.id,
        scope,
        appearance,
        hasImage,
        appearanceRevision: player.appearance_revision,
    });

    return { ok: true, groupId, messageId: sent?.key?.id };
}

async function sendAppearancePendingNotices({ sock, db, playerId, receptionGroupId }) {
    const results = [];
    if (receptionGroupId?.endsWith('@g.us')) {
        results.push(await sendAppearancePendingNotice({
            sock,
            db,
            playerId,
            groupId: receptionGroupId,
            scope: 'reception',
        }));
    }

    const registrationGroup = await getCloverRegistrationGroup(db);
    if (registrationGroup) {
        results.push(await sendAppearancePendingNotice({
            sock,
            db,
            playerId,
            groupId: registrationGroup,
            scope: 'registration',
        }));
    }

    return results;
}

async function updatePendingProfileAppearance(db, playerId, appearance) {
    const pending = await getPendingConfirmation(db, playerId);
    if (!pending) return;

    pending.personagemAparencia = appearance;
    pending.personagemAparenciaNormalizada = normalizeAppearanceValue(appearance);
    await savePendingConfirmation(db, playerId, pending);
}

async function setAppearancePending(db, playerId, appearance, imageInfo = null, {expectedRevision = null} = {}) {
    const normalized = normalizeAppearanceValue(appearance);
    const changed = await db.run(
        `UPDATE jogadores
         SET personagem_aparencia = ?,
             personagem_aparencia_normalizada = ?,
             aparencia = ?,
             personagem_aparencia_status = 'pending',
             personagem_aparencia_motivo = NULL,
             personagem_aparencia_image_path = ?,
             personagem_aparencia_image_message_id = ?,
             personagem_aparencia_approved_by = NULL,
             personagem_aparencia_approved_at = NULL,
             personagem_aparencia_updated_at = CURRENT_TIMESTAMP,
             jogo_status = CASE
                 WHEN jogo_status = 'liberado' THEN jogo_status
                 ELSE 'bloqueado'
             END,
             jogo_liberado_at = CASE
                 WHEN jogo_status = 'liberado' THEN jogo_liberado_at
                 ELSE NULL
             END,
             jogo_liberado_by = CASE
                 WHEN jogo_status = 'liberado' THEN jogo_liberado_by
                 ELSE NULL
             END
         WHERE id = ? AND (? IS NULL OR (appearance_revision = ? AND personagem_aparencia_status = 'pending'))`,
        [
            appearance,
            normalized,
            appearance,
            imageInfo?.imagePath || null,
            imageInfo?.messageId || null,
            playerId, expectedRevision, expectedRevision,
        ]
    );

    if(!changed.changes) return false;
    await updatePendingProfileAppearance(db, playerId, appearance);
    return true;
}

async function markProfileAppearancePending(db, playerId, payload, imageInfo = null) {
    if (!payload?.personagemAparencia) return;
    await setAppearancePending(db, playerId, payload.personagemAparencia, imageInfo);
}

function parseAppearanceReviewText(text) {
    const raw = String(text || '').trim();
    const normalized = normalizeText(raw);
    if (['ok', 'aprovar', 'aprovado', 'sim'].includes(normalized)) {
        return { action: 'approve', reason: null };
    }

    if (normalized === 'negado' || normalized === 'negar' || normalized === 'reprovado') {
        return { action: 'reject', reason: null };
    }

    const match = raw.match(/^negad[oa]\s*:\s*(.+)$/i);
    if (match) {
        return { action: 'reject', reason: match[1].trim() || null };
    }

    return null;
}

function parseAppearanceReaction(text) {
    if (text === '✅') return { action: 'approve', reason: null };
    if (text === '❌') return { action: 'reject', reason: null };
    return null;
}

async function findAppearanceReviewByMessage(db, groupId, messageId) {
    if (!groupId || !messageId) return null;
    return db.get(
        `SELECT *
         FROM clover_appearance_reviews
         WHERE group_id = ? AND message_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [groupId, messageId]
    );
}

function renderStatusLabel(status) {
    if (status === 'approved') return 'Aprovada';
    if (status === 'rejected') return 'Negada';
    return 'Pendente';
}

async function sendAlreadyEvaluated(sock, idChat, m, player, reviewerId) {
    const admin = player.personagem_aparencia_approved_by || reviewerId;
    await sock.sendMessage(idChat, {
        text: [
            '𝐉𝐀́ 𝐀𝐕𝐀𝐋𝐈𝐀𝐃𝐀',
            '',
            'Essα αpαrᥱ̂ncıα jά foı αvαlıαdα.',
            '',
            `> ⤷ Status: *${renderStatusLabel(player.personagem_aparencia_status)}*`,
            `> ⤷ Por: ${formatMention(admin)}`,
            '',
            '*ⓘ A novα αvαlıαçα̃o foı ıgnorαdα.*',
        ].join('\n'),
        mentions: [admin],
    }, m ? { quoted: m } : undefined);
}

function renderApprovedGroupMessage(playerId, appearance, reviewerId) {
    return [
        '𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐀𝐏𝐑𝐎𝐕𝐀𝐃𝐀',
        '',
        `A αpαrᥱ̂ncıα dᥱ ${formatMention(playerId)} foı αprovαdα.`,
        '',
        `> ⤷ Aparência: *${appearance}*`,
        `> ⤷ ADM: ${formatMention(reviewerId)}`,
    ].join('\n');
}

function renderRejectedGroupMessage(playerId, appearance, reviewerId, reason) {
    return [
        '𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐍𝐄𝐆𝐀𝐃𝐀',
        '',
        `A αpαrᥱ̂ncıα dᥱ ${formatMention(playerId)} foı nᥱgαdα.`,
        '',
        `> ⤷ Aparência: *${appearance}*`,
        `> ⤷ ADM: ${formatMention(reviewerId)}`,
        `> ⤷ Motıvo: ${reason || 'nao informado'}`,
    ].join('\n');
}

function renderApprovedPlayerMessage(appearance) {
    return [
        '𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐀𝐏𝐑𝐎𝐕𝐀𝐃𝐀',
        '',
        'Suα αpαrᥱ̂ncıα foı αprovαdα pᥱlα αdmınıstrαçα̃o.',
        '',
        `> ⤷ Aparência: *${appearance}*`,
        '',
        '*ⓘ Seu rᥱgıstro vısuαl ᥱstά confırmαdo.*',
    ].join('\n');
}

function renderRejectedPlayerMessage(appearance, reason) {
    return [
        '𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐍𝐄𝐆𝐀𝐃𝐀',
        '',
        'Suα αpαrᥱ̂ncıα foı nᥱgαdα.',
        '',
        `> ⤷ Aparência: *${appearance}*`,
        `> ⤷ Motıvo: ${reason || 'nao informado'}`,
        '',
        'Você nα̃o prᥱcısα rᥱfαzᥱr α fıchα.',
        '',
        'Envıᥱ umα novα αpαrᥱ̂ncıα no formato:',
        '',
        '*Personagem — Obra*',
        '',
        'Sᥱ quısᥱr, αnᥱxᥱ umα novα imαgᥱm.',
    ].join('\n');
}

async function notifyPlayerAppearanceResult(sock, fallbackGroupId, playerId, text, mentions = [], policy = {}) {
    try {
        await sendPrivateText({ sock, playerId, text, policy });
        return { ok: true, private: true };
    } catch (error) {
        await sock.sendMessage(fallbackGroupId, {
            text: `${formatMention(playerId)}\n\n${text}`,
            mentions: [playerId, ...mentions],
        });
        return { ok: false, private: false, error };
    }
}

function isCurrentAppearanceReview(player, review){
    return player && review && review.appearance_revision != null
        && Number(player.appearance_revision) === Number(review.appearance_revision)
        && player.personagem_aparencia_status==='pending';
}
async function sendStaleAppearanceReview(sock,idChat,m){
    await sock.sendMessage(idChat,{text:[
        '♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𝐃𝐄𝐒𝐀𝐓𝐔𝐀𝐋𝐈𝐙𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  registro visual  ──','',
        'ⓘ Esta mensagem não corresponde à revisão atual da aparência.',
        '> Use o aviso mais recente de avaliação.',
        '> Nenhuma mudança foi aplicada.',
    ].join('\n')},m?{quoted:m}:undefined);
}

async function evaluateAppearanceReview({ sock, db, m, idChat, reviewerId, review, action, reason = null }) {
    if (!review) return false;
    if (!await canReviewAppearance(sock, idChat, reviewerId)) return false;

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [review.player_id]);
    if (!player) return true;

    if (review.appearance_revision == null || Number(review.appearance_revision)!==Number(player.appearance_revision)) {
        await sendStaleAppearanceReview(sock,idChat,m);
        return true;
    }

    const currentSignature = player.personagem_aparencia_normalizada || normalizeAppearanceValue(player.personagem_aparencia);
    if (
        ['approved', 'rejected'].includes(player.personagem_aparencia_status)
        || (review.appearance_normalized && currentSignature && review.appearance_normalized !== currentSignature)
    ) {
        // A prior approval may have committed before its post-ficha effects.
        if (action==='approve' && player.personagem_aparencia_status==='approved') {
            await maybeSendPostFichaPrivateInstructions(sock,db,review.player_id,{expectedRevision:review.appearance_revision});
        }
        await sendAlreadyEvaluated(sock, idChat, m, player, reviewerId);
        return true;
    }

    const nextStatus = action === 'approve' ? 'approved' : 'rejected';
    const update = await db.run(
        `UPDATE jogadores
         SET personagem_aparencia_status = ?,
             personagem_aparencia_motivo = ?,
             personagem_aparencia_approved_by = ?,
             personagem_aparencia_approved_at = CURRENT_TIMESTAMP,
             personagem_aparencia_updated_at = CURRENT_TIMESTAMP,
             jogo_status = CASE WHEN ? = 'rejected' THEN 'bloqueado' ELSE jogo_status END
         WHERE id = ?
           AND personagem_aparencia_status = 'pending'
           AND personagem_aparencia_normalizada = ?
           AND appearance_revision = ?`,
        [
            nextStatus,
            action === 'reject' ? reason || null : null,
            reviewerId,
            nextStatus,
            review.player_id,
            currentSignature,
            review.appearance_revision,
        ]
    );

    const updatedPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [review.player_id]);
    if (!update.changes) {
        if (Number(updatedPlayer?.appearance_revision)!==Number(review.appearance_revision)) await sendStaleAppearanceReview(sock,idChat,m);
        else await sendAlreadyEvaluated(sock, idChat, m, updatedPlayer || player, reviewerId);
        return true;
    }

    if(action==='approve'){
        // Do not allow an unavailable transport to prevent game release.
        await preparePostFichaRelease(db,review.player_id,{expectedRevision:review.appearance_revision});
    }
    const groupText = action === 'approve'
        ? renderApprovedGroupMessage(review.player_id, updatedPlayer.personagem_aparencia, reviewerId)
        : renderRejectedGroupMessage(review.player_id, updatedPlayer.personagem_aparencia, reviewerId, reason);
    try {
        await sock.sendMessage(idChat, {
            text: groupText,
            mentions: [review.player_id, reviewerId],
        }, m ? { quoted: m } : undefined);
    } catch(error) {
        console.warn('[aparencia] aviso de avaliação não enviado:',error?.message);
    }

    const playerText = action === 'approve'
        ? renderApprovedPlayerMessage(updatedPlayer.personagem_aparencia)
        : renderRejectedPlayerMessage(updatedPlayer.personagem_aparencia, reason);
    try { await notifyPlayerAppearanceResult(
        sock,
        idChat,
        review.player_id,
        playerText,
        [reviewerId],
        {
            source: action === 'approve' ? 'appearance_approved' : 'appearance_rejected',
            dedupeKey: `appearance_result:${review.player_id}:${review.appearance_revision}:${action}`,
        }
    ); } catch(error) { console.warn('[aparencia] aviso ao jogador não enviado:',error?.message); }

    if (action === 'approve') {
        const privateInstructions = await maybeSendPostFichaPrivateInstructions(sock, db, review.player_id,{expectedRevision:review.appearance_revision});
        if (!privateInstructions.ok) {
            console.log(`[aparencia] Nao consegui enviar PV de historia para ${review.player_id}:`, privateInstructions.error?.message || privateInstructions.error);
        }
    }

    try {
        await syncArchiveCardForPlayer({ sock, db, playerId: review.player_id });
    } catch (error) {
        console.log(`[arquivo] Nao consegui sincronizar aparencia de ${review.player_id}:`, error?.message || error);
    }

    return true;
}

async function tryHandleAppearanceReviewReply({ sock, db, m, idChat, reviewerId, text }) {
    const parsed = parseAppearanceReviewText(text);
    if (!parsed) return false;

    const review = await findAppearanceReviewByMessage(db, idChat, getQuotedMessageId(m));
    if (!review) return false;

    return evaluateAppearanceReview({
        sock,
        db,
        m,
        idChat,
        reviewerId,
        review,
        action: parsed.action,
        reason: parsed.reason,
    });
}

async function tryHandleAppearanceReaction({ sock, db, m, idChat, reviewerId }) {
    const reaction = m.message?.reactionMessage;
    const parsed = parseAppearanceReaction(reaction?.text);
    if (!parsed) return false;

    const review = await findAppearanceReviewByMessage(db, idChat, reaction?.key?.id);
    if (!review || review.scope !== 'registration') return false;

    const registrationGroup = await getCloverRegistrationGroup(db);
    if (!registrationGroup || registrationGroup !== idChat) return false;

    return evaluateAppearanceReview({
        sock,
        db,
        m,
        idChat,
        reviewerId,
        review,
        action: parsed.action,
        reason: parsed.reason,
    });
}

async function findAttachableAppearance(db, playerId, quotedMessageId = null, groupId = null) {
    if (quotedMessageId && groupId) {
        const review = await findAppearanceReviewByMessage(db, groupId, quotedMessageId);
        if (review?.player_id === playerId) return review;
    }

    return null;
}

async function tryAttachAppearanceImage({
    sock,
    db,
    m,
    idChat,
    playerId,
    downloadMediaMessage,
    loggerFactory = Pino,
}) {
    if (!hasImageMessage(m)) return false;

    const attachable = await findAttachableAppearance(db, playerId, getQuotedMessageId(m), idChat);
    if (!attachable) {
        return false;
    }

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if(!isCurrentAppearanceReview(player,attachable)){
        await sendStaleAppearanceReview(sock,idChat,m);
        return true;
    }
    const imageInfo = await saveAppearanceImageFromMessage({
        sock,message:m,playerId,downloadMediaMessage,loggerFactory,
    });
    const appearance=player.personagem_aparencia;
    if(!await setAppearancePending(db,playerId,appearance,imageInfo,{expectedRevision:attachable.appearance_revision})){
        await sendStaleAppearanceReview(sock,idChat,m);
        return true;
    }

    await sock.sendMessage(idChat, {
        text: [
            '𝐈𝐌𝐀𝐆𝐄𝐌 𝐀𝐍𝐄𝐗𝐀𝐃𝐀',
            '',
            'A imαgᥱm dα αpαrᥱ̂ncıα foı αnᥱxαdα.',
            '',
            `> ⤷ Aparência: *${appearance}*`,
            '> ⤷ Status: *pᥱndᥱntᥱ dᥱ αprovαçα̃o*',
        ].join('\n'),
    }, { quoted: m });

    await sendAppearancePendingNotices({
        sock,
        db,
        playerId,
        receptionGroupId: idChat?.endsWith('@g.us') ? idChat : null,
    });

    return true;
}

module.exports = {
    canReviewAppearance,
    markProfileAppearancePending,
    normalizeAppearanceValue,
    saveAppearanceImageFromMessage,
    sendAppearancePendingNotices,
    sendAppearancePendingNotice,
    setAppearancePending,
    tryAttachAppearanceImage,
    tryHandleAppearanceReaction,
    tryHandleAppearanceReviewReply,
};
