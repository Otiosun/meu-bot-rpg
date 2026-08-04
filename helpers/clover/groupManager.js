const { COMMAND_PREFIX } = require('../../config/bot');
const fs = require('fs');
const path = require('path');
const { sendPrivateMessage, sendPrivateText } = require('../chatReply');
const { extractPhoneNumber, isSameUser, normalizeJid } = require('../groupAccess');
const { enqueueSpellReviewInvite } = require('./deliveryService');
const {
    callNextQueueEntry,
    closeQueueEntry,
    findCalledQueueEntryForCandidates,
} = require('./spellbookService');
const { fillSpellReviewSlots } = require('./spellReviewFlowService');

const GROUP_SETTING_KEYS = {
    off: 'clover_off_group_jid',
    on: 'clover_on_group_jid',
    archive: 'clover_archive_group_jid',
    community: 'clover_community_group_jid',
    spell_review: 'clover_spell_review_group_jid',
};

const GROUP_INVITE_KEYS = {
    off: 'clover_off_group_invite_link',
    on: 'clover_on_group_invite_link',
    spell_review: 'clover_spell_review_group_invite_link',
};

const OFF_GROUP_INVITE_KEY = GROUP_INVITE_KEYS.off;
const SPELL_REVIEW_AUTO_FLOW_KEY = 'clover_spell_review_auto_flow';
const AUTH_INFO_DIR = path.join(__dirname, '..', '..', 'auth_info');
const OFF_WELCOME_IMAGE_PATH = path.join(process.cwd(), 'assets', 'clover', 'off-welcome.png');

async function setCloverSetting(db, key, value) {
    await db.run(
        `INSERT INTO clover_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = CURRENT_TIMESTAMP`,
        [key, String(value ?? '').trim()]
    );
}

async function getCloverSetting(db, key) {
    const row = await db.get(
        `SELECT value
         FROM clover_settings
         WHERE key = ?`,
        [key]
    );
    return row?.value || null;
}

function parseConfiguredCloverGroups(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];

    let values = null;
    try {
        const parsed = JSON.parse(raw);
        values = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        values = raw.split(/[\n,;]+/);
    }

    const groups = [];
    for (const valueItem of values || []) {
        const normalized = normalizeJid(valueItem);
        if (!normalized) continue;
        if (!groups.some((existing) => isSameUser(existing, normalized))) {
            groups.push(normalized);
        }
    }
    return groups;
}

async function getCloverGroups(db, type) {
    const key = GROUP_SETTING_KEYS[type];
    if (!key) return [];
    return parseConfiguredCloverGroups(await getCloverSetting(db, key));
}

async function setCloverGroup(db, type, groupId) {
    const key = GROUP_SETTING_KEYS[type];
    if (!key) throw new Error(`Tipo de grupo Clover invalido: ${type}`);

    const normalizedGroupId = normalizeJid(groupId);
    if (!normalizedGroupId) throw new Error('ID de grupo Clover invalido.');

    if (type !== 'on') {
        await setCloverSetting(db, key, normalizedGroupId);
        return [normalizedGroupId];
    }

    const currentGroups = await getCloverGroups(db, type);
    const nextGroups = [
        ...currentGroups.filter((existing) => !isSameUser(existing, normalizedGroupId)),
        normalizedGroupId,
    ];
    await setCloverSetting(db, key, JSON.stringify(nextGroups));
    return nextGroups;
}

async function getCloverGroup(db, type) {
    const groups = await getCloverGroups(db, type);
    return groups.length ? groups[groups.length - 1] : null;
}

async function setGroupInviteLink(db, type, link) {
    if (!link) return;

    const key = GROUP_INVITE_KEYS[type];
    if (!key) throw new Error(`Tipo de link Clover invalido: ${type}`);

    await setCloverSetting(db, key, link);
}

async function setOffGroupInviteLink(db, link) {
    return setGroupInviteLink(db, 'off', link);
}

async function getStoredGroupInviteLink(db, type) {
    const key = GROUP_INVITE_KEYS[type];
    if (!key) return null;

    return getCloverSetting(db, key);
}

async function getStoredOffGroupInviteLink(db) {
    return getStoredGroupInviteLink(db, 'off');
}

async function fetchAndStoreGroupInviteLink(sock, db, type) {
    const groupId = await getCloverGroup(db, type);
    if (!groupId) return null;

    const code = await sock.groupInviteCode(groupId);
    if (!code) return null;

    const link = `https://chat.whatsapp.com/${code}`;
    await setGroupInviteLink(db, type, link);
    return link;
}

async function revokeAndStoreGroupInviteLink(sock, db, type) {
    const groupId = await getCloverGroup(db, type);
    if (!groupId) return null;

    let link = null;
    try {
        const code = await sock.groupRevokeInvite(groupId);
        if (code && typeof code === 'string') {
            link = `https://chat.whatsapp.com/${code}`;
        }
    } catch (error) {
        console.log(`Nao consegui redefinir link do grupo ${String(type || '').toUpperCase()}:`, error?.message || error);
    }

    if (!link) {
        link = await fetchAndStoreGroupInviteLink(sock, db, type);
    } else {
        await setGroupInviteLink(db, type, link);
    }

    return link;
}

async function fetchAndStoreOffGroupInviteLink(sock, db) {
    return fetchAndStoreGroupInviteLink(sock, db, 'off');
}

async function getGroupInviteLink(sock, db, type) {
    try {
        const freshLink = await fetchAndStoreGroupInviteLink(sock, db, type);
        if (freshLink) return freshLink;
    } catch (error) {
        console.log(`Nao consegui buscar link do grupo ${String(type || '').toUpperCase()}:`, error?.message || error);
    }

    return getStoredGroupInviteLink(db, type);
}

async function getOffGroupInviteLink(sock, db) {
    return getGroupInviteLink(sock, db, 'off');
}

async function getOnGroupInviteLink(sock, db) {
    return getGroupInviteLink(sock, db, 'on');
}

async function getSpellReviewGroupInviteLink(sock, db) {
    return getGroupInviteLink(sock, db, 'spell_review');
}

async function rotateSpellReviewInviteLink(sock, db) {
    return getSpellReviewGroupInviteLink(sock, db);
}

async function setSpellReviewAutoFlow(db, enabled) {
    await setCloverSetting(db, SPELL_REVIEW_AUTO_FLOW_KEY, enabled ? '1' : '0');
    return Boolean(enabled);
}

async function getSpellReviewAutoFlowEnabled(db) {
    const value = await getCloverSetting(db, SPELL_REVIEW_AUTO_FLOW_KEY);
    return value !== '0';
}

function parseParticipantValue(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;

    const raw = String(value || '').trim();
    if (!raw) return {};

    try {
        return JSON.parse(raw);
    } catch {
        return { jid: raw };
    }
}

function getParticipantCandidates(value) {
    const parsed = parseParticipantValue(value);
    const rawCandidates = [
        parsed.id,
        parsed.lid,
        parsed.lidJid,
        parsed.lid_jid,
        parsed.jid,
        parsed.participant,
        parsed.participantJid,
        parsed.participant_jid,
        parsed.participantPn,
        parsed.participant_pn,
        parsed.userJid,
        parsed.user_jid,
        parsed.phoneNumber,
        parsed.phone_number,
        parsed.phone,
        parsed.pn,
        parsed.pnJid,
        parsed.pn_jid,
        parsed.requester,
        parsed.requesterJid,
        parsed.requester_jid,
        typeof value === 'string' ? value : '',
    ];
    const candidates = [];

    rawCandidates.forEach((candidate) => {
        const normalized = normalizeJid(candidate);
        if (!normalized) return;
        candidates.push(normalized);

        if (!normalized.includes('@')) {
            const phone = String(normalized).replace(/\D/g, '');
            if (phone) candidates.push(`${phone}@s.whatsapp.net`);
            return;
        }

        const [userPart, domain] = normalized.split('@');
        if (domain === 'lid') {
            const mappedPhone = readMappedPhoneDigits(userPart);
            if (mappedPhone) candidates.push(`${mappedPhone}@s.whatsapp.net`);
        }
    });

    return [...new Set(candidates)];
}

function findNodeByTag(node, tag) {
    if (!node || typeof node !== 'object') return null;
    if (node.tag === tag) return node;

    const children = Array.isArray(node.content) ? node.content : [];
    for (const child of children) {
        const found = findNodeByTag(child, tag);
        if (found) return found;
    }

    return null;
}

function extractInviteFromAddResponse(response) {
    for (const item of response || []) {
        const addRequest = findNodeByTag(item.content, 'add_request') || findNodeByTag(item, 'add_request');
        const attrs = addRequest?.attrs || {};
        const inviteCode = attrs.code || attrs.invite_code || attrs.inviteCode || '';
        const inviteExpiration = Number(attrs.expiration || attrs.expiration_ts || attrs.invite_expiration || 0);
        if (inviteCode) {
            return {
                inviteCode,
                inviteExpiration: Number.isFinite(inviteExpiration) && inviteExpiration > 0
                    ? inviteExpiration
                    : null,
            };
        }
    }

    return null;
}

function stringifyAttemptError(error) {
    if (!error) return '';
    if (error.message) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function formatAttemptErrors(attempts) {
    return (attempts || [])
        .map((attempt) => {
            if (attempt.error) return `${attempt.candidate}: ${stringifyAttemptError(attempt.error)}`;
            if (attempt.response) return `${attempt.candidate}: ${JSON.stringify(attempt.response)}`;
            return `${attempt.candidate}: sem resposta`;
        })
        .join(' | ');
}

function readMappedPhoneDigits(lidDigits) {
    const digits = String(lidDigits || '').replace(/\D/g, '');
    if (!digits) return '';

    const mappingPath = path.join(AUTH_INFO_DIR, `lid-mapping-${digits}_reverse.json`);
    try {
        if (!fs.existsSync(mappingPath)) return '';
        const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        if (typeof parsed === 'string' || typeof parsed === 'number') {
            return String(parsed).replace(/\D/g, '');
        }
        if (parsed && typeof parsed === 'object') {
            return String(parsed.phoneNumber || parsed.pn || parsed.jid || parsed.id || parsed.user || '').replace(/\D/g, '');
        }
    } catch {
        return '';
    }

    return '';
}

async function findApprovedPlayerForJoin(db, participant) {
    const candidates = getParticipantCandidates(participant);
    if (!candidates.length) return null;

    const rows = await db.all(
        `SELECT id, personagem_nome, nome, display_name, ficha_status, personagem_aparencia_status, jogo_status
         FROM jogadores
         WHERE ficha_status = 'aprovada'
           AND personagem_aparencia_status IN ('approved', 'aprovada')
           AND jogo_status = 'liberado'`
    );

    return rows.find((player) => (
        candidates.some((candidate) => (
            normalizeJid(player.id) === candidate
            || isSameUser(player.id, candidate)
        ))
    )) || null;
}

function extractParticipantId(value) {
    const parsed = parseParticipantValue(value);
    const preferred = [
        parsed.jid,
        parsed.participant,
        parsed.participantJid,
        parsed.participant_jid,
        parsed.participantPn,
        parsed.participant_pn,
        parsed.jid,
        parsed.userJid,
        parsed.user_jid,
        parsed.phoneNumber,
        parsed.phone_number,
        parsed.phone,
        parsed.pn,
        parsed.pnJid,
        parsed.pn_jid,
        parsed.lid,
        parsed.lidJid,
        parsed.lid_jid,
        parsed.id,
        typeof value === 'string' ? value : '',
    ];

    for (const candidate of preferred) {
        const normalized = normalizeJid(candidate);
        if (!normalized) continue;
        if (normalized.includes('@')) return normalized;

        const phone = normalized.replace(/\D/g, '');
        if (phone) return `${phone}@s.whatsapp.net`;
    }

    return '';
}

function approvalCandidates(value) {
    return [...new Set([
        extractParticipantId(value),
        ...getParticipantCandidates(value),
    ].filter(Boolean))];
}

async function approveJoinRequestForCandidates(sock, groupId, rawParticipant) {
    const attempts = [];

    for (const candidate of approvalCandidates(rawParticipant)) {
        try {
            const response = await sock.groupRequestParticipantsUpdate(groupId, [candidate], 'approve');
            const affected = (response || []).find((item) => isSameUser(item.jid, candidate)) || response?.[0] || null;
            if (participantStatusOk(affected?.status)) {
                return { ok: true, participantId: candidate, response, affected };
            }
            attempts.push({ candidate, response });
        } catch (error) {
            attempts.push({ candidate, error });
        }
    }

    return { ok: false, attempts };
}

async function isConfiguredCloverGroup(db, type, groupId) {
    const configuredGroups = await getCloverGroups(db, type);
    return configuredGroups.some((configured) => isSameUser(groupId, configured));
}

async function tryApproveOffGroupJoinRequests({ sock, db, groupId, participants }) {
    const offGroupId = await getCloverGroup(db, 'off');
    if (!offGroupId || !isSameUser(groupId, offGroupId)) {
        return { handled: false, approved: [], rejected: [], skipped: [] };
    }

    const approved = [];
    const rejected = [];
    const skipped = [];

    for (const rawParticipant of participants || []) {
        const participantId = extractParticipantId(rawParticipant);
        if (!participantId) continue;

        const player = await findApprovedPlayerForJoin(db, rawParticipant);
        if (!player) {
            skipped.push(participantId);
            continue;
        }

        const approval = await approveJoinRequestForCandidates(sock, groupId, rawParticipant);
        if (approval.ok) {
            approved.push({ participantId: approval.participantId, player, response: approval.response });
        } else {
            rejected.push({ participantId, player, attempts: approval.attempts });
            console.log(`Falha ao aprovar pedido no grupo OFF para ${participantId}: ${formatAttemptErrors(approval.attempts)}`);
        }
    }

    return {
        handled: true,
        approved,
        rejected,
        skipped,
    };
}

async function tryApproveSpellReviewJoinRequests({ sock, db, groupId, participants }) {
    const reviewGroupId = await getCloverGroup(db, 'spell_review');
    if (!reviewGroupId || !isSameUser(groupId, reviewGroupId)) {
        return { handled: false, approved: [], rejected: [], skipped: [] };
    }

    const approved = [];
    const rejected = [];
    const skipped = [];

    for (const rawParticipant of participants || []) {
        const participantId = extractParticipantId(rawParticipant);
        if (!participantId) continue;

        const candidates = getParticipantCandidates(rawParticipant);
        const entry = await findCalledQueueEntryForCandidates(db, candidates);
        if (!entry) {
            skipped.push(participantId);
            continue;
        }

        const approval = await approveJoinRequestForCandidates(sock, groupId, rawParticipant);
        if (approval.ok) {
            approved.push({ participantId: approval.participantId, entry, response: approval.response });
        } else {
            rejected.push({ participantId, entry, attempts: approval.attempts });
            console.log(`Falha ao aprovar pedido no grupo de avaliacao de feiticos para ${participantId}: ${formatAttemptErrors(approval.attempts)}`);
        }
    }

    return {
        handled: true,
        approved,
        rejected,
        skipped,
    };
}

async function approvePendingOffGroupRequests(sock, db) {
    const offGroupId = await getCloverGroup(db, 'off');
    if (!offGroupId) {
        return { ok: false, reason: 'missing_off_group', pending: [], approved: [], rejected: [], skipped: [] };
    }

    const pending = await sock.groupRequestParticipantsList(offGroupId);
    const result = await tryApproveOffGroupJoinRequests({
        sock,
        db,
        groupId: offGroupId,
        participants: pending,
    });

    return {
        ok: true,
        offGroupId,
        pending,
        ...result,
    };
}

async function approvePendingSpellReviewRequests(sock, db) {
    const reviewGroupId = await getCloverGroup(db, 'spell_review');
    if (!reviewGroupId) {
        return { ok: false, reason: 'missing_spell_review_group', pending: [], approved: [], rejected: [], skipped: [] };
    }

    const pending = await sock.groupRequestParticipantsList(reviewGroupId);
    const result = await tryApproveSpellReviewJoinRequests({
        sock,
        db,
        groupId: reviewGroupId,
        participants: pending,
    });

    return {
        ok: true,
        reviewGroupId,
        pending,
        ...result,
    };
}

function privateInviteCandidates(playerId) {
    const normalized = normalizeJid(playerId);
    const phone = extractPhoneNumber(normalized);
    return [...new Set([
        normalized,
        phone ? `${phone}@s.whatsapp.net` : '',
    ].filter(Boolean))];
}

function participantStatusOk(status) {
    return ['200', '409'].includes(String(status || ''));
}

function inviteCodeFromLink(link) {
    const match = String(link || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    return match?.[1] || '';
}

async function addSpellReviewParticipant(sock, db, playerId) {
    const groupId = await getCloverGroup(db, 'spell_review');
    if (!groupId) return { ok: false, reason: 'missing_group' };

    const errors = [];
    for (const candidate of getParticipantCandidates(playerId)) {
        try {
            const response = await sock.groupParticipantsUpdate(groupId, [candidate], 'add');
            const affected = (response || []).find((item) => isSameUser(item.jid, candidate)) || response?.[0] || null;
            if (participantStatusOk(affected?.status)) {
                return {
                    ok: true,
                    groupId,
                    addedId: candidate,
                    alreadyInGroup: String(affected?.status || '') === '409',
                    status: String(affected?.status || '200'),
                    response,
                };
            }

            const invite = extractInviteFromAddResponse(response);
            if (invite) {
                return {
                    ok: false,
                    reason: 'privacy_invite_required',
                    groupId,
                    invite,
                    invitedId: candidate,
                    response,
                    errors,
                };
            }

            errors.push({ candidate, response });
        } catch (error) {
            errors.push({ candidate, error });
        }
    }

    return { ok: false, reason: 'add_failed', groupId, errors };
}

function buildSpellReviewPrivatePolicy(playerId, inviteIdentity) {
    return {
        source: 'spell_review_invite',
        dedupeKey: `spell_review_invite:${playerId}:${inviteIdentity || 'current'}`,
    };
}

async function sendOfficialSpellReviewInvite(sock, db, playerId, options = {}) {
    const groupId = await getCloverGroup(db, 'spell_review');
    if (!groupId) return { ok: false, reason: 'missing_group' };

    const link = options.link || await getSpellReviewGroupInviteLink(sock, db);
    const addInvite = options.add?.invite || null;
    const inviteCode = options.inviteCode
        || addInvite?.inviteCode
        || inviteCodeFromLink(link)
        || await sock.groupInviteCode(groupId);
    if (!inviteCode) return { ok: false, reason: 'missing_invite_code' };
    const privatePolicy = buildSpellReviewPrivatePolicy(playerId, inviteCode);

    let subject = 'Avaliação de Feitiços';
    try {
        const metadata = await sock.groupMetadata(groupId);
        subject = metadata?.subject || subject;
    } catch {
        // O assunto padrão é suficiente para montar o convite.
    }

    const inviteExpiration = Number(options.inviteExpiration || addInvite?.inviteExpiration || 0)
        || Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
    const errors = [];

    const recipientCandidates = [...new Set([
        options.add?.invitedId,
        ...privateInviteCandidates(playerId),
    ].filter(Boolean))];

    for (const jid of recipientCandidates) {
        try {
            const privateResult = await sendPrivateMessage({
                sock,
                playerId: jid,
                message: {
                    groupInvite: {
                        inviteCode,
                        inviteExpiration,
                        text: 'Sua vez chegou na avaliação de feitiço. Entre pelo convite e mande a ficha no grupo.',
                        jid: groupId,
                        subject,
                    },
                },
                policy: privatePolicy,
            });
            if (privateResult?.skipped) {
                errors.push({ jid, skipped: true, reason: privateResult.reason });
                continue;
            }
            return { ok: true, groupId, sentTo: jid, inviteCode };
        } catch (error) {
            errors.push({ jid, error });
            console.log(`[grupo-avaliacao-feiticos] convite oficial falhou para ${jid}:`, error?.message || error);
        }
    }

    return { ok: false, reason: 'official_invite_failed', groupId, inviteCode, errors };
}

function renderSpellReviewInviteMessage(link, options = {}) {
    const add = options.add || null;
    const officialInvite = options.officialInvite || null;
    const statusLines = [];

    if (add?.ok && add.alreadyInGroup) {
        statusLines.push('O bot identificou que você já estava no grupo de avaliação.');
    } else if (add?.ok) {
        statusLines.push('O bot tentou te adicionar direto no grupo de avaliação.');
    } else if (officialInvite?.ok) {
        statusLines.push('O WhatsApp não permitiu adicionar direto, então enviei um convite oficial.');
    } else {
        statusLines.push('Se o convite direto não aparecer, use o link abaixo.');
    }

    return [
        '♧┃AVALIAÇÃO DE FEITIÇO 𖥔 CLOVER MULTICOLOR',
        '     ── sua vez chegou na fila ──',
        '',
        '_`─( ✓ )───── Entrada`_',
        '',
        ...statusLines,
        'Entre no grupo e mande sua ficha de feitiço por lá.',
        '',
        link || 'Link indisponível no momento.',
        '',
        '_`─( ◆ )───── Lembrete`_',
        '',
        'O feitiço não evolui sozinho com o personagem.',
        'Quando quiser atualizar, ele precisa passar por avaliação de novo.',
    ].join('\n');
}

async function sendSpellReviewInviteToPlayer(sock, db, playerId, options = {}) {
    const link = options.rotate
        ? await rotateSpellReviewInviteLink(sock, db)
        : await getSpellReviewGroupInviteLink(sock, db);

    const add = options.addToGroup === false
        ? null
        : await addSpellReviewParticipant(sock, db, playerId);
    const officialInvite = add?.ok
        ? null
        : await sendOfficialSpellReviewInvite(sock, db, playerId, { link, add });
    const privatePolicy = buildSpellReviewPrivatePolicy(
        playerId,
        inviteCodeFromLink(link) || officialInvite?.inviteCode || 'current'
    );

    const text = renderSpellReviewInviteMessage(link, { add, officialInvite });
    const errors = [];

    for (const jid of privateInviteCandidates(playerId)) {
        try {
            const privateResult = await sendPrivateText({
                sock,
                playerId: jid,
                text,
                policy: privatePolicy,
            });
            if (privateResult?.skipped) {
                errors.push({ jid, skipped: true, reason: privateResult.reason });
                continue;
            }
            return {
                ok: true,
                link,
                sentTo: jid,
                add,
                officialInvite,
                linkMessage: { ok: true, sentTo: jid },
            };
        } catch (error) {
            errors.push({ jid, error });
        }
    }

    const ok = Boolean(add?.ok || officialInvite?.ok);
    const queueFallbackEnabled = options.queueFallback === true
        || (options.queueFallback !== false && process.env.CLOVER_SPELL_REVIEW_QUEUE_FALLBACK === '1');
    let queuedFallback = null;
    if (queueFallbackEnabled) {
        queuedFallback = await enqueueSpellReviewInvite(db, {
            playerId,
            rotate: false,
            addToGroup: options.addToGroup !== false,
            source: 'spell_review_invite_fallback',
            reason: ok ? 'private_link_failed' : (!link ? 'missing_link' : 'send_failed'),
        }).catch((error) => {
            console.log('[grupo-avaliacao-feiticos] nao consegui enfileirar convite auxiliar:', error?.message || error);
            return null;
        });
    }
    return {
        ok,
        reason: ok ? 'partial' : (!link ? 'missing_link' : 'send_failed'),
        link,
        add,
        officialInvite,
        linkMessage: { ok: false, errors },
        queuedFallback,
        errors,
    };
}

async function removeSpellReviewParticipant(sock, db, playerId) {
    const groupId = await getCloverGroup(db, 'spell_review');
    if (!groupId) return { ok: false, reason: 'missing_group' };

    const candidates = getParticipantCandidates(playerId);
    const errors = [];

    for (const candidate of candidates) {
        try {
            const response = await sock.groupParticipantsUpdate(groupId, [candidate], 'remove');
            return { ok: true, groupId, removedId: candidate, response };
        } catch (error) {
            errors.push({ candidate, error });
        }
    }

    return { ok: false, reason: 'remove_failed', groupId, errors };
}

async function advanceSpellReviewQueueAfterRemoval({ sock, db, participantId, closedBy = 'system' }) {
    const entry = await findCalledQueueEntryForCandidates(db, getParticipantCandidates(participantId));
    if (!entry) return { handled: false };

    const closed = await closeQueueEntry(
        db,
        entry.player_id,
        'removed',
        closedBy,
        'removido/saiu do grupo de avaliação'
    );

    let link = null;
    try {
        link = await rotateSpellReviewInviteLink(sock, db);
    } catch (error) {
        console.log('Nao consegui buscar link apos remocao do grupo de avaliacao:', error?.message || error);
    }

    const autoFlow = await getSpellReviewAutoFlowEnabled(db);
    const fill = autoFlow
        ? await fillSpellReviewSlots(db, closedBy, { excludePlayerIds: [entry.player_id] })
        : { ok: false, code: 'auto_disabled', called: [], skipped: [] };
    const invites = [];
    for (const calledEntry of fill.called || []) {
        const inviteResult = await sendSpellReviewInviteToPlayer(
            sock,
            db,
            calledEntry.player_id,
            { rotate: false, queueFallback: false }
        ).catch((error) => ({
            ok: false,
            reason: 'unexpected_error',
            error: error?.message || String(error),
        }));
        invites.push({ entry: calledEntry, invite: inviteResult });
    }
    const next = fill.called?.[0]
        ? { ok: true, entry: fill.called[0] }
        : { ok: false, code: fill.code || 'empty' };
    const invite = invites[0]?.invite || null;

    return {
        handled: true,
        closed,
        entry,
        link,
        autoFlow,
        fill,
        invites,
        next,
        invite,
    };
}

function renderOffGroupWelcomeMessage(playerId) {
    return [
        `♧ 𝐁𝐄𝐌-𝐕𝐈𝐍𝐃𝐎 𝐀𝐎 𝐂𝐋𝐎𝐕𝐄𝐑 𝐌𝐔𝐋𝐓𝐈𝐂𝐎𝐋𝐎𝐑, @${String(playerId || '').split('@')[0]}`,
        '     ──  clovᥱr rpg · grupo off  ──',
        '',
        'Agora você está no grupo certo para seguir com o RPG.',
        '',
        'Use no grupo OFF ou em outro grupo onde o Clover esteja ativo:',
        '',
        '*̣.#ajuda*',
        '> Ver seus comandos, perfil, árvores, PH e sistemas.',
        '',
        'Ou acesse o link para ver com mais calma:',
        '',
        '*https://clover-multicolor.vercel.app/*',
        '',
        'A história e personalidade vêm depois, como orientado pela administração. Por agora, você já está livre para jogar o RPG à vontade.',
    ].join('\n');
}

function getOffGroupWelcomeImagePath() {
    return fs.existsSync(OFF_WELCOME_IMAGE_PATH) ? OFF_WELCOME_IMAGE_PATH : null;
}

function renderCloverGroupStatus({ offGroupId, onGroupId, archiveGroupId, communityGroupId, offLink, onLink }) {
    return [
        '*Grupos Clover configurados*',
        '',
        `OFF: ${offGroupId || 'nao configurado'}`,
        `ON: ${onGroupId || 'nao configurado'}`,
        `Arquivos: ${archiveGroupId || 'nao configurado'}`,
        `Avisos/Comunidade: ${communityGroupId || 'nao configurado'}`,
        `Link OFF: ${offLink || 'nao disponivel'}`,
        `Link ON: ${onLink || 'nao disponivel'}`,
        '',
        `Para marcar: *${COMMAND_PREFIX}setgrupooff*, *${COMMAND_PREFIX}setgrupoon*, *${COMMAND_PREFIX}setgrupoarquivos* ou *${COMMAND_PREFIX}setgrupoavisos* dentro do grupo correto.`,
    ].join('\n');
}

module.exports = {
    advanceSpellReviewQueueAfterRemoval,
    addSpellReviewParticipant,
    approvePendingSpellReviewRequests,
    fetchAndStoreGroupInviteLink,
    fetchAndStoreOffGroupInviteLink,
    approvePendingOffGroupRequests,
    getCloverGroup,
    getCloverGroups,
    getGroupInviteLink,
    getOffGroupInviteLink,
    getOnGroupInviteLink,
    getOffGroupWelcomeImagePath,
    getParticipantCandidates,
    getSpellReviewAutoFlowEnabled,
    getSpellReviewGroupInviteLink,
    getStoredGroupInviteLink,
    getStoredOffGroupInviteLink,
    isConfiguredCloverGroup,
    parseConfiguredCloverGroups,
    renderCloverGroupStatus,
    renderOffGroupWelcomeMessage,
    renderSpellReviewInviteMessage,
    removeSpellReviewParticipant,
    revokeAndStoreGroupInviteLink,
    rotateSpellReviewInviteLink,
    sendSpellReviewInviteToPlayer,
    sendOfficialSpellReviewInvite,
    setCloverGroup,
    setGroupInviteLink,
    setSpellReviewAutoFlow,
    tryApproveOffGroupJoinRequests,
    tryApproveSpellReviewJoinRequests,
};
