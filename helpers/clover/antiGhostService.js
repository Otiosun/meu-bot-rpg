const { assertLifecycleAllowed, lifecycleSkip, isPreResetLifecycle } = require('./lifecyclePolicy');
const { COMMAND_PREFIX } = require('../../config/bot');
const fs = require('fs');
const path = require('path');
const { extractPhoneNumber, isSameUser, normalizeJid } = require('../groupAccess');
const { sendPrivateText } = require('../chatReply');
const { normalizeText } = require('../textUtils');
const { getChecklistSummary } = require('./checklistService');
const { getCloverGroup } = require('./groupManager');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { archiveAndResetPlayer } = require('./playerReset');

const SETTINGS = {
    enabled: 'antighost_enabled',
    activatedAt: 'antighost_activated_at',
};

const AUTH_DIR_PREFIX = 'auth_info';

const NOTICE_LEVELS = [
    { key: 'light_3', minDays: 3, maxDays: 4 },
    { key: 'checklist_5', minDays: 5, maxDays: 6 },
    { key: 'official_7', minDays: 7, maxDays: 9 },
    { key: 'strong_10', minDays: 10, maxDays: 13 },
    { key: 'candidate_14', minDays: 14, maxDays: Infinity },
];

const RELEVANT_COMMANDS = new Set([
    'atividade',
    'atributos',
    'arvore',
    'arvores',
    'bonus',
    'bônus',
    'capacidade',
    'check',
    'checklist',
    'feitico',
    'feitiço',
    'fisico',
    'físico',
    'grimorio',
    'grimório',
    'hexagono',
    'hexágono',
    'inventario',
    'inventário',
    'perfil',
    'presente',
    'ph',
    'status',
]);

function pad2(value) {
    return String(value).padStart(2, '0');
}

function toSqliteDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return toSqliteDate(new Date());
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqliteDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
        return new Date(`${text.replace(' ', 'T')}Z`);
    }
    const parsed = new Date(text.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nowSqlite() {
    return toSqliteDate(new Date());
}

function addHoursSqlite(hours, base = new Date()) {
    const date = base instanceof Date ? new Date(base) : parseSqliteDate(base) || new Date();
    date.setHours(date.getHours() + Number(hours || 0));
    return toSqliteDate(date);
}

function addDaysSqlite(days, base = new Date()) {
    const date = base instanceof Date ? new Date(base) : parseSqliteDate(base) || new Date();
    date.setDate(date.getDate() + Number(days || 0));
    return toSqliteDate(date);
}

function daysBetween(from, to = new Date()) {
    const start = parseSqliteDate(from);
    if (!start) return null;
    const end = to instanceof Date ? to : parseSqliteDate(to) || new Date();
    return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000));
}

function getMonthKey(date = new Date()) {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serializeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return JSON.stringify(metadata);
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function authInfoDirectories() {
    const root = process.cwd();
    const directories = [];
    const current = path.join(root, 'auth_info');
    if (fs.existsSync(current)) directories.push(current);

    try {
        const backupDirectories = fs.readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${AUTH_DIR_PREFIX}_backup_`))
            .map((entry) => path.join(root, entry.name))
            .sort()
            .reverse();
        directories.push(...backupDirectories);
    } catch {
        // A sync can still work with direct WhatsApp ids even if backups are unavailable.
    }

    return directories;
}

function readMappedPhoneDigitsFromAuth(lidDigits) {
    const digits = extractDigits(lidDigits);
    if (!digits) return '';

    for (const dir of authInfoDirectories()) {
        const mappingPath = path.join(dir, `lid-mapping-${digits}_reverse.json`);
        try {
            if (!fs.existsSync(mappingPath)) continue;
            const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
            if (typeof parsed === 'string' || typeof parsed === 'number') {
                const mapped = extractDigits(parsed);
                if (mapped) return mapped;
            }
            if (parsed && typeof parsed === 'object') {
                const mapped = extractDigits(parsed.phoneNumber || parsed.pn || parsed.jid || parsed.id || parsed.user);
                if (mapped) return mapped;
            }
        } catch {
            continue;
        }
    }

    return '';
}

function comparablePhoneDigits(jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return '';
    if (!normalized.includes('@')) return extractDigits(normalized);

    const [userPart, domain] = normalized.split('@');
    if (domain === 'lid') {
        return extractPhoneNumber(normalized) || readMappedPhoneDigitsFromAuth(userPart);
    }
    return extractDigits(userPart);
}

function participantIdentifiers(participant) {
    if (!participant) return [];
    if (typeof participant === 'string') return [normalizeJid(participant)].filter(Boolean);

    return [
        participant.id,
        participant.jid,
        participant.lid,
        participant.pn,
        participant.phoneNumber,
    ].map(normalizeJid).filter(Boolean);
}

function buildParticipantIdentityIndex(participants = []) {
    const jids = new Set();
    const phones = new Set();

    for (const participant of participants) {
        for (const id of participantIdentifiers(participant)) {
            jids.add(id);
            const digits = comparablePhoneDigits(id);
            if (digits) phones.add(digits);
        }
    }

    return { jids, phones };
}

function isPlayerInParticipantIndex(playerId, index) {
    const normalized = normalizeJid(playerId);
    if (!normalized) return false;
    if (index.jids.has(normalized)) return true;

    for (const jid of index.jids) {
        if (isSameUser(normalized, jid)) return true;
    }

    const digits = comparablePhoneDigits(normalized);
    return Boolean(digits) && index.phones.has(digits);
}

async function ensureAntiGhostSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_antighost_settings (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_antighost_activity (
            player_id TEXT PRIMARY KEY,
            last_on_message_at TEXT DEFAULT NULL,
            last_off_message_at TEXT DEFAULT NULL,
            last_command_at TEXT DEFAULT NULL,
            last_evaluation_at TEXT DEFAULT NULL,
            last_activity_at TEXT DEFAULT NULL,
            last_activity_kind TEXT DEFAULT NULL,
            community_status TEXT DEFAULT 'unknown',
            last_community_seen_at TEXT DEFAULT NULL,
            last_notice_level TEXT DEFAULT NULL,
            last_notice_at TEXT DEFAULT NULL,
            candidate_at TEXT DEFAULT NULL,
            exempt_until TEXT DEFAULT NULL,
            exempt_reason TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_antighost_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT DEFAULT NULL,
            event_type TEXT NOT NULL,
            group_id TEXT DEFAULT NULL,
            message_key TEXT DEFAULT NULL,
            occurred_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_antighost_messages (
            message_key TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            participant_id TEXT DEFAULT NULL,
            message_id TEXT NOT NULL,
            kind TEXT DEFAULT NULL,
            occurred_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_return_bonuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'fulfilled', 'expired', 'cancelled')),
            source TEXT DEFAULT 'auto',
            bonus_label TEXT NOT NULL,
            bonus_ph INTEGER DEFAULT 0,
            outside_weekly_limit INTEGER DEFAULT 1,
            condition_text TEXT DEFAULT NULL,
            offered_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            fulfilled_at TEXT DEFAULT NULL,
            evaluation_id INTEGER DEFAULT NULL,
            scene_message_key TEXT DEFAULT NULL,
            scene_sent_at TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_antighost_events_player
        ON clover_antighost_events (player_id, occurred_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_antighost_activity_notice
        ON clover_antighost_activity (last_notice_level, candidate_at)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_return_bonuses_player_status
        ON clover_return_bonuses (player_id, status, expires_at)
    `);
}

async function setSetting(db, key, value) {
    await ensureAntiGhostSchema(db);
    await db.run(
        `INSERT INTO clover_antighost_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = CURRENT_TIMESTAMP`,
        [key, String(value)]
    );
}

async function getSetting(db, key) {
    await ensureAntiGhostSchema(db);
    const row = await db.get('SELECT value FROM clover_antighost_settings WHERE key = ?', [key]);
    return row?.value ?? null;
}

async function isAntiGhostEnabled(db) {
    return await getSetting(db, SETTINGS.enabled) === '1';
}

function cleanCommandName(value) {
    return normalizeText(String(value || '').replace(COMMAND_PREFIX, ''))
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function isRelevantCommand(commandName) {
    const clean = cleanCommandName(commandName);
    if (!clean) return false;
    return [...RELEVANT_COMMANDS].some((item) => cleanCommandName(item) === clean);
}

function getMessageTimestamp(m) {
    const raw = m?.messageTimestamp;
    if (typeof raw === 'number') {
        return toSqliteDate(new Date(raw * 1000));
    }
    if (typeof raw === 'bigint') {
        return toSqliteDate(new Date(Number(raw) * 1000));
    }
    if (raw && typeof raw === 'object') {
        if (typeof raw.toNumber === 'function') return toSqliteDate(new Date(raw.toNumber() * 1000));
        if (typeof raw.low === 'number') return toSqliteDate(new Date(raw.low * 1000));
    }
    return nowSqlite();
}

function buildMessageKey({ chatId, participantId, messageId }) {
    if (!chatId || !messageId) return null;
    return `${chatId}:${participantId || ''}:${messageId}`;
}

function maxSqliteDate(values = []) {
    let best = null;
    for (const value of values) {
        const date = parseSqliteDate(value);
        if (!date) continue;
        if (!best || date.getTime() > best.getTime()) best = date;
    }
    return best ? toSqliteDate(best) : null;
}

async function upsertActivityRow(db, playerId) {
    if (!playerId) return null;
    await ensureAntiGhostSchema(db);
    await db.run(
        `INSERT OR IGNORE INTO clover_antighost_activity (player_id, updated_at)
         VALUES (?, CURRENT_TIMESTAMP)`,
        [playerId]
    );
    return db.get('SELECT * FROM clover_antighost_activity WHERE player_id = ?', [playerId]);
}

async function writeEvent(db, { playerId, eventType, groupId = null, messageKey = null, occurredAt = null, metadata = {} }) {
    await ensureAntiGhostSchema(db);
    await db.run(
        `INSERT INTO clover_antighost_events
         (player_id, event_type, group_id, message_key, occurred_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            playerId || null,
            eventType,
            groupId || null,
            messageKey || null,
            occurredAt || nowSqlite(),
            serializeMetadata(metadata),
        ]
    );
}

async function updateStrongActivity(db, playerId, kind, occurredAt) {
    if (!playerId || !occurredAt) return;
    await upsertActivityRow(db, playerId);
    await db.run(
        `UPDATE clover_antighost_activity
         SET last_activity_at = CASE
                 WHEN last_activity_at IS NULL OR datetime(last_activity_at) < datetime(?) THEN ?
                 ELSE last_activity_at
             END,
             last_activity_kind = CASE
                 WHEN last_activity_at IS NULL OR datetime(last_activity_at) < datetime(?) THEN ?
                 ELSE last_activity_kind
             END,
             candidate_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [occurredAt, occurredAt, occurredAt, kind, playerId]
    );
}

async function recordMessageActivity({ db, idChat, playerId, m, groupType = null, text = '' }) {
    const denied = lifecycleSkip({surface:'internal',operation:'recordMessageActivity',mutationClass:'CURRENT_WORLD'});
    if (denied) return denied;

    await ensureAntiGhostSchema(db);
    const messageId = m?.key?.id || null;
    const participantId = normalizeJid(m?.key?.participant || playerId || '');
    const occurredAt = getMessageTimestamp(m);
    const messageKey = buildMessageKey({ chatId: idChat, participantId, messageId });

    if (messageKey && messageId) {
        await db.run(
            `INSERT OR IGNORE INTO clover_antighost_messages
             (message_key, chat_id, participant_id, message_id, kind, occurred_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                messageKey,
                idChat,
                participantId || null,
                messageId,
                groupType || null,
                occurredAt,
                serializeMetadata({ text_length: String(text || '').length }),
            ]
        );
    }

    if (!playerId) return { ok: false, reason: 'missing_player', messageKey, occurredAt };

    await upsertActivityRow(db, playerId);

    if (groupType === 'on') {
        await db.run(
            `UPDATE clover_antighost_activity
             SET last_on_message_at = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ?`,
            [occurredAt, playerId]
        );
        await updateStrongActivity(db, playerId, 'on_message', occurredAt);
    } else if (groupType === 'off') {
        await db.run(
            `UPDATE clover_antighost_activity
             SET last_off_message_at = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ?`,
            [occurredAt, playerId]
        );
    } else if (groupType === 'community') {
        await markCommunityStatus(db, playerId, true, occurredAt);
    }

    await writeEvent(db, {
        playerId,
        eventType: groupType ? `${groupType}_message` : 'message',
        groupId: idChat,
        messageKey,
        occurredAt,
        metadata: { group_type: groupType || null },
    });

    return { ok: true, messageKey, occurredAt };
}

async function recordCommandActivity({ db, playerId, commandName, idChat = null, messageKey = null }) {
    const denied = lifecycleSkip({surface:'internal',operation:'recordCommandActivity',mutationClass:'CURRENT_WORLD'});
    if (denied) return denied;

    if (!playerId) return { ok: false, relevant: false };
    await ensureAntiGhostSchema(db);
    const relevant = isRelevantCommand(commandName);
    const occurredAt = nowSqlite();
    await upsertActivityRow(db, playerId);
    await writeEvent(db, {
        playerId,
        eventType: relevant ? 'command_relevant' : 'command',
        groupId: idChat,
        messageKey,
        occurredAt,
        metadata: { command: commandName, relevant },
    });
    if (!relevant) return { ok: true, relevant: false };

    await db.run(
        `UPDATE clover_antighost_activity
         SET last_command_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [occurredAt, playerId]
    );
    await updateStrongActivity(db, playerId, 'command', occurredAt);
    return { ok: true, relevant: true };
}

async function recordEvaluationActivity({ db, playerId, evaluationId, modalityKey, sceneSentAt = null, metadata = {} }) {
    if (!playerId) return;
    await ensureAntiGhostSchema(db);
    const occurredAt = sceneSentAt || nowSqlite();
    await upsertActivityRow(db, playerId);
    await db.run(
        `UPDATE clover_antighost_activity
         SET last_evaluation_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [occurredAt, playerId]
    );
    await updateStrongActivity(db, playerId, 'evaluation', occurredAt);
    await writeEvent(db, {
        playerId,
        eventType: 'evaluation',
        occurredAt,
        metadata: { evaluation_id: evaluationId, modality: modalityKey, ...metadata },
    });
}

async function markCommunityStatus(db, playerId, isMember, occurredAt = null) {
    if (!playerId) return;
    await ensureAntiGhostSchema(db);
    const activity = await upsertActivityRow(db, playerId);
    const when = occurredAt || nowSqlite();
    const status = isMember ? 'member' : 'out';
    const changed = activity?.community_status !== status;
    await db.run(
        `UPDATE clover_antighost_activity
         SET community_status = ?,
             last_community_seen_at = CASE WHEN ? = 1 THEN ? ELSE last_community_seen_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [status, isMember ? 1 : 0, when, playerId]
    );
    if (changed) {
        await writeEvent(db, {
            playerId,
            eventType: isMember ? 'community_join' : 'community_leave',
            occurredAt: when,
        });
    }
    return { ok: true, status, changed, at: when };
}

async function syncCommunityMembership({ sock, db } = {}) {
    await ensureAntiGhostSchema(db);
    const groupId = await getCloverGroup(db, 'community');
    if (!groupId) {
        return { ok: false, reason: 'missing_community_group' };
    }
    if (!sock?.groupMetadata) {
        return { ok: false, reason: 'missing_socket' };
    }

    const metadata = await sock.groupMetadata(groupId);
    const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
    const index = buildParticipantIdentityIndex(participants);
    const players = await getActivePlayers(db);
    const now = nowSqlite();
    const result = {
        ok: true,
        groupId,
        groupName: metadata?.subject || null,
        participants: participants.length,
        players: players.length,
        member: 0,
        out: 0,
        changed: 0,
        unchanged: 0,
        samples: {
            out: [],
        },
    };

    const planned = [];
    for (const player of players) {
        const activity = await upsertActivityRow(db, player.id);
        const isMember = isPlayerInParticipantIndex(player.id, index);
        const nextStatus = isMember ? 'member' : 'out';
        const previousStatus = activity?.community_status || 'unknown';
        const changed = previousStatus !== nextStatus;

        planned.push({ player, isMember, nextStatus, previousStatus, changed });
        if (isMember) result.member += 1;
        else result.out += 1;
    }

    if (players.length && participants.length && result.member === 0) {
        return {
            ok: false,
            reason: 'no_identity_matches',
            groupId,
            groupName: metadata?.subject || null,
            participants: participants.length,
            players: players.length,
        };
    }

    for (const item of planned) {
        await db.run(
            `UPDATE clover_antighost_activity
             SET community_status = ?,
                 last_community_seen_at = CASE WHEN ? = 1 THEN ? ELSE last_community_seen_at END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ?`,
            [item.nextStatus, item.isMember ? 1 : 0, now, item.player.id]
        );

        if (item.changed) {
            result.changed += 1;
            await writeEvent(db, {
                playerId: item.player.id,
                eventType: item.isMember ? 'community_sync_member' : 'community_sync_out',
                groupId,
                occurredAt: now,
                metadata: {
                    previous_status: item.previousStatus,
                    source: 'manual_sync',
                },
            });
        } else {
            result.unchanged += 1;
        }

        if (!item.isMember && result.samples.out.length < 10) {
            result.samples.out.push(playerName(item.player));
        }
    }

    return result;
}

async function getTrackedMessage(db, messageKey) {
    if (!messageKey) return null;
    await ensureAntiGhostSchema(db);
    return db.get('SELECT * FROM clover_antighost_messages WHERE message_key = ?', [messageKey]);
}

function parseManualSceneDate(value) {
    const text = String(value || '').trim();
    if (!text || ['-', 'nenhum', 'nenhuma'].includes(normalizeText(text))) return null;

    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (iso) {
        const year = Number(iso[1]);
        const month = Number(iso[2]);
        const day = Number(iso[3]);
        const hour = Number(iso[4] || 12);
        const minute = Number(iso[5] || 0);
        const second = Number(iso[6] || 0);
        const date = new Date(year, month - 1, day, hour, minute, second);
        return Number.isNaN(date.getTime()) ? null : toSqliteDate(date);
    }

    const br = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (br) {
        const day = Number(br[1]);
        const month = Number(br[2]);
        const year = Number(br[3].length === 2 ? `20${br[3]}` : br[3]);
        const hour = Number(br[4] || 12);
        const minute = Number(br[5] || 0);
        const date = new Date(year, month - 1, day, hour, minute, 0);
        return Number.isNaN(date.getTime()) ? null : toSqliteDate(date);
    }

    const parsed = parseSqliteDate(text);
    return parsed ? toSqliteDate(parsed) : null;
}

async function resolveSceneSentAt({ db, quotedMessageKey, manualSceneDateText }) {
    const manual = parseManualSceneDate(manualSceneDateText);
    if (manual) return { sceneSentAt: manual, source: 'manual' };

    const tracked = await getTrackedMessage(db, quotedMessageKey);
    if (tracked?.occurred_at) return { sceneSentAt: tracked.occurred_at, source: 'quoted_message' };

    return { sceneSentAt: null, source: quotedMessageKey ? 'quoted_message_missing' : 'missing' };
}

async function getActiveReturnBonus(db, playerId) {
    await ensureAntiGhostSchema(db);
    return db.get(
        `SELECT *
         FROM clover_return_bonuses
         WHERE player_id = ?
           AND status = 'active'
           AND datetime(expires_at) > datetime('now')
         ORDER BY id ASC
         LIMIT 1`,
        [playerId]
    );
}

async function expireReturnBonuses(db, playerId = null) {
    await ensureAntiGhostSchema(db);
    const params = [];
    let where = `status = 'active' AND datetime(expires_at) <= datetime('now')`;
    if (playerId) {
        where += ' AND player_id = ?';
        params.push(playerId);
    }
    return db.run(
        `UPDATE clover_return_bonuses
         SET status = 'expired'
         WHERE ${where}`,
        params
    );
}

async function hasMonthlyReturnBonus(db, playerId, now = new Date()) {
    await ensureAntiGhostSchema(db);
    const month = getMonthKey(now);
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_return_bonuses
         WHERE player_id = ?
           AND strftime('%Y-%m', offered_at) = ?
           AND status IN ('active', 'fulfilled', 'expired')`,
        [playerId, month]
    );
    return Number(row?.total || 0) > 0;
}

async function createReturnBonus({
    db,
    playerId,
    bonusPh = 5,
    bonusLabel = null,
    hours = 72,
    createdBy = 'system',
    source = 'auto',
    conditionText = 'Cena de UP aprovada.',
    metadata = {},
}) {
    assertLifecycleAllowed({surface:'internal',operation:'createReturnBonus',mutationClass:'CURRENT_WORLD'});

    await ensureAntiGhostSchema(db);
    await expireReturnBonuses(db, playerId);
    const active = await getActiveReturnBonus(db, playerId);
    if (active) return { ok: false, code: 'already_active', bonus: active };

    const amount = Math.max(1, Math.min(30, Math.floor(Number(bonusPh) || 5)));
    const offeredAt = nowSqlite();
    const expiresAt = addHoursSqlite(hours, offeredAt);
    const label = bonusLabel || `+${amount} PH fora do teto semanal`;

    const result = await db.run(
        `INSERT INTO clover_return_bonuses
         (player_id, status, source, bonus_label, bonus_ph, outside_weekly_limit,
          condition_text, offered_at, expires_at, created_by, metadata_json)
         VALUES (?, 'active', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [
            playerId,
            source,
            label,
            amount,
            conditionText,
            offeredAt,
            expiresAt,
            createdBy,
            serializeMetadata(metadata),
        ]
    );

    const bonus = await db.get('SELECT * FROM clover_return_bonuses WHERE id = ?', [result.lastID]);
    return { ok: true, bonus };
}

async function applyReturnBonusForEvaluation({
    db,
    playerId,
    evaluationId,
    evaluatorId,
    modalityKey,
    quotedMessageKey,
    manualSceneDateText,
}) {
    assertLifecycleAllowed({surface:'internal',operation:'applyReturnBonusForEvaluation',mutationClass:'CURRENT_WORLD'});

    await ensureAntiGhostSchema(db);
    await expireReturnBonuses(db, playerId);
    const bonus = await getActiveReturnBonus(db, playerId);
    if (!bonus) return { ok: true, applied: false, code: 'no_active_bonus' };

    const scene = await resolveSceneSentAt({ db, quotedMessageKey, manualSceneDateText });
    if (!scene.sceneSentAt) {
        return {
            ok: true,
            applied: false,
            code: 'missing_scene_date',
            bonus,
            scene,
        };
    }

    if (parseSqliteDate(scene.sceneSentAt) < parseSqliteDate(bonus.offered_at)) {
        return { ok: true, applied: false, code: 'scene_before_offer', bonus, scene };
    }

    if (parseSqliteDate(scene.sceneSentAt) > parseSqliteDate(bonus.expires_at)) {
        return { ok: true, applied: false, code: 'scene_after_deadline', bonus, scene };
    }

    await ensurePhState(db, playerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const fresh = await db.get(
            `SELECT *
             FROM clover_return_bonuses
             WHERE id = ?
               AND status = 'active'`,
            [bonus.id]
        );
        if (!fresh) {
            await db.exec('ROLLBACK');
            return { ok: true, applied: false, code: 'already_used' };
        }

        const metadata = {
            return_bonus_id: fresh.id,
            evaluation_id: evaluationId,
            modality: modalityKey,
            scene_message_key: quotedMessageKey || null,
            scene_sent_at: scene.sceneSentAt,
            scene_source: scene.source,
            outside_weekly_limit: true,
        };
        const phResult = await addPhInTransaction(
            db,
            playerId,
            Number(fresh.bonus_ph || 0),
            'return_bonus',
            'Bônus de retorno anti-ghost',
            evaluatorId || fresh.created_by || 'system',
            metadata,
            `return_bonus:${fresh.id}:eval:${evaluationId}`
        );

        await db.run(
            `UPDATE clover_return_bonuses
             SET status = 'fulfilled',
                 fulfilled_at = CURRENT_TIMESTAMP,
                 evaluation_id = ?,
                 scene_message_key = ?,
                 scene_sent_at = ?,
                 metadata_json = ?
             WHERE id = ?`,
            [
                evaluationId,
                quotedMessageKey || null,
                scene.sceneSentAt,
                serializeMetadata({
                    ...safeJsonParse(fresh.metadata_json, {}),
                    fulfilled: metadata,
                }),
                fresh.id,
            ]
        );

        await writeEvent(db, {
            playerId,
            eventType: 'return_bonus_fulfilled',
            occurredAt: nowSqlite(),
            metadata,
        });

        await db.exec('COMMIT');
        return { ok: true, applied: true, bonus: fresh, scene, phResult };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

function renderReturnBonusResult(result) {
    if (!result || result.code === 'no_active_bonus') return null;
    if (result.applied) {
        return [
            '',
            '_`─( ✦ )───── Bônus de retorno`_',
            '',
            `*Bônus aplicado:* ${result.bonus.bonus_label}`,
            `*Cena reconhecida:* ${result.scene.sceneSentAt}`,
        ].join('\n');
    }
    if (result.code === 'missing_scene_date') {
        return [
            '',
            '_`─( ! )───── Bônus de retorno`_',
            '',
            '*Bônus não aplicado:* não consegui reconhecer a data da cena.',
            '> Responda diretamente a cena ou preencha "Data da cena" na avaliação.',
        ].join('\n');
    }
    if (result.code === 'scene_before_offer') {
        return [
            '',
            '_`─( ! )───── Bônus de retorno`_',
            '',
            '*Bônus não aplicado:* a cena foi enviada antes da oferta de retorno.',
        ].join('\n');
    }
    if (result.code === 'scene_after_deadline') {
        return [
            '',
            '_`─( ! )───── Bônus de retorno`_',
            '',
            '*Bônus não aplicado:* a cena foi enviada depois do prazo.',
        ].join('\n');
    }
    return null;
}

async function getActivePlayers(db) {
    await ensureAntiGhostSchema(db);
    return db.all(
        `SELECT *
         FROM jogadores
         WHERE jogo_status = 'liberado'
         ORDER BY personagem_nome COLLATE NOCASE, nome COLLATE NOCASE, id`
    );
}

async function activateAntiGhost({ sock, db, sendInitialNotices = false } = {}) {
    assertLifecycleAllowed({surface:'internal',operation:'activateAntiGhost',mutationClass:'CURRENT_WORLD'});

    await ensureAntiGhostSchema(db);
    const now = nowSqlite();
    await setSetting(db, SETTINGS.enabled, '1');
    await setSetting(db, SETTINGS.activatedAt, now);
    const players = await getActivePlayers(db);
    let sent = 0;
    let failed = 0;

    for (const player of players) {
        await upsertActivityRow(db, player.id);
        await db.run(
            `UPDATE clover_antighost_activity
             SET last_activity_at = COALESCE(last_activity_at, ?),
                 last_activity_kind = COALESCE(last_activity_kind, 'activation'),
                 updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ?`,
            [now, player.id]
        );

        if (sendInitialNotices && sock) {
            try {
                const privateResult = await sendPrivateText({
                    sock,
                    playerId: player.id,
                    text: renderActivationPlayerMessage(),
                });
                if (privateResult?.skipped) {
                    failed += 1;
                    await writeEvent(db, {
                        playerId: player.id,
                        eventType: 'activation_notice_failed',
                        metadata: { source: 'activate', reason: privateResult.reason },
                    });
                    continue;
                }
                sent += 1;
                await writeEvent(db, {
                    playerId: player.id,
                    eventType: 'activation_notice_sent',
                    metadata: { source: 'activate' },
                });
            } catch (error) {
                failed += 1;
                await writeEvent(db, {
                    playerId: player.id,
                    eventType: 'activation_notice_failed',
                    metadata: {
                        source: 'activate',
                        error: error?.message || String(error),
                    },
                }).catch(() => null);
            }
        }
    }

    return {
        ok: true,
        players: players.length,
        sent,
        failed,
        initialNotices: sendInitialNotices ? 'sent' : 'skipped',
    };
}

async function deactivateAntiGhost(db) {
    await setSetting(db, SETTINGS.enabled, '0');
    return { ok: true };
}

function playerName(player = {}) {
    return String(player.personagem_nome || player.display_name || player.nome || player.id || '-').trim();
}

function computeLevel(activity, now = new Date()) {
    const exemptUntil = parseSqliteDate(activity?.exempt_until);
    if (exemptUntil && exemptUntil.getTime() > now.getTime()) {
        return { key: 'exempt', days: 0, level: null };
    }

    const lastStrong = maxSqliteDate([
        activity?.last_activity_at,
        activity?.last_on_message_at,
        activity?.last_command_at,
        activity?.last_evaluation_at,
    ]);
    const days = lastStrong ? daysBetween(lastStrong, now) : 999;
    const level = NOTICE_LEVELS.find((item) => days >= item.minDays && days <= item.maxDays) || null;
    return { key: level?.key || 'ok', days, level, lastStrong };
}

function renderActivationPlayerMessage() {
    return [
        '*♧┃MIMOSA 𖥔 CLOVER MULTICOLOR*',
        '     ── controle de atividade ──',
        '',
        '*Oi. Estou passando para avisar que o RPG começou a acompanhar atividade dos personagens.*',
        '',
        'Não muda nada para quem já joga normalmente.',
        'É só uma forma de separar quem ainda está presente de quem está inativo.',
        '',
        '*Conta como atividade:*',
        '> cena de UP no ON;',
        '> comando relevante do bot;',
        '> missão, treino, spin-off, autonarrada ou desenvolvimento avaliados.',
        '',
        '*Se precisar pausar, fale com a staff.*',
        '*Avisar é sempre melhor do que deixar solto no ar.*',
    ].join('\n');
}

async function renderNoticeMessage(db, player, activity, levelInfo) {
    if (levelInfo.key === 'light_3') {
        return [
            '*♧┃MIMOSA NOTOU SUA AUSÊNCIA 𖥔 CLOVER MULTICOLOR*',
            '     ── lembrete de atividade ──',
            '',
            '*Oi. Faz alguns dias que não vejo sinal seu no RPG.*',
            '',
            'Se você só está ocupado, tudo bem.',
            'Só tenta não sumir sem avisar, tá?',
            '',
            '*Para mostrar que ainda está jogando:*',
            '> faça uma cena de UP no ON;',
            '> use um comando relevante;',
            '> ou fale com a staff se precisar de uma pausa.',
        ].join('\n');
    }

    if (levelInfo.key === 'checklist_5') {
        const summary = await getChecklistSummary(db, player.id);
        return [
            '*♧┃MIMOSA TROUXE SEU CHECKLIST 𖥔 CLOVER MULTICOLOR*',
            '     ── ainda dá tempo ──',
            '',
            'Passei para te deixar o caminho mais fácil.',
            '',
            '*𝑷𝑯 𝒔𝒆𝒎𝒂𝒏𝒂𝒍:*',
            `> ${summary.weekly.commonPhShown}/${summary.weekly.commonPhTarget}`,
            '',
            '*𝑨𝒖𝒕𝒐𝒏𝒂𝒓𝒓𝒂𝒅𝒂:*',
            `> ${summary.weekly.autoNarratedShown}/${summary.weekly.autoNarratedTarget}`,
            '',
            '*𝑺𝒑𝒊𝒏-𝒐𝒇𝒇:*',
            `> ${summary.monthly.spinOffShown}/${summary.monthly.spinOffTarget}`,
            '',
            '*𝑫𝒆𝒔𝒆𝒏𝒗𝒐𝒍𝒗𝒊𝒎𝒆𝒏𝒕𝒐:*',
            `> ${summary.monthly.developmentShown}/${summary.monthly.developmentTarget}`,
            '',
            '*Uma cena de UP aprovada já ajuda bem mais do que ficar só abrindo comando.*',
            '*Se estiver sem tempo, faz algo curto e rápido, e envia para avaliação.*',
        ].join('\n');
    }

    if (levelInfo.key === 'official_7') {
        return [
            '*♧┃AVISO ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
            '     ── ausência registrada ──',
            '',
            'Faz 7 dias que não aparece atividade sua no RPG.',
            '',
            'Se você ainda quer jogar, precisa deixar algum sinal real nos próximos dias.',
            '',
            'Pode ser:',
            '> cena de UP no ON;',
            '> comando relevante do bot;',
            '> avaliação registrada;',
            '> aviso direto para a staff.',
            '',
            '_`─( ! )───── Atenção`_',
            '',
            'Com 14 dias sem atividade, seu personagem entra para análise de remoção.',
            '',
            '*Se você quer encerrar agora:*',
            '> responda *ENCERRAR PERSONAGEM* neste PV.',
        ].join('\n');
    }

    if (levelInfo.key === 'strong_10') {
        return [
            '*♧┃MIMOSA CHAMOU MAIS UMA VEZ 𖥔 CLOVER MULTICOLOR*',
            '     ── aviso de retorno ──',
            '',
            'Você ainda não voltou desde o último aviso.',
            '',
            'Estou te mandando isso no PV porque pode ter sido falta de tempo, não abandono.',
            'Mas preciso de algum sinal seu.',
            '',
            'Volta pelo caminho mais simples:',
            '> uma cena de UP;',
            '> um comando relevante;',
            '> ou uma mensagem para a staff explicando a pausa.',
            '',
            'Se continuar sem resposta, seu personagem vai aparecer na lista de análise da staff.',
            '',
            '*Se você quer encerrar agora:*',
            '> responda *ENCERRAR PERSONAGEM* neste PV.',
        ].join('\n');
    }

    return [
        '*♧┃REGISTRO EM ANÁLISE 𖥔 CLOVER MULTICOLOR*',
        '     ── inatividade atingida ──',
        '',
        'Seu personagem ficou 14 dias sem atividade registrada.',
        '',
        'Ele foi colocado na lista de análise da staff.',
        '',
        'Se isso foi engano, ou se você ainda quer jogar, fale com a staff o quanto antes.',
        'Se você estava em pausa e não avisou, agora é a hora de avisar.',
        '',
        '*Se você quer encerrar agora:*',
        '> responda *ENCERRAR PERSONAGEM* neste PV.',
    ].join('\n');
}

function noRecentWeakPresence(activity, now = new Date(), days = 7) {
    const lastAny = maxSqliteDate([
        activity?.last_on_message_at,
        activity?.last_off_message_at,
        activity?.last_command_at,
        activity?.last_evaluation_at,
    ]);
    if (!lastAny) return true;
    return (daysBetween(lastAny, now) || 0) >= days;
}

async function maybeCreateAutoReturnBonus({ db, sock, player, activity, levelInfo }) {
    if (!['official_7', 'strong_10', 'candidate_14'].includes(levelInfo.key)) {
        return { created: false, code: 'level_not_eligible' };
    }
    if (!noRecentWeakPresence(activity, new Date(), 7)) {
        return { created: false, code: 'has_weak_presence' };
    }
    if (activity?.community_status === 'out') {
        return { created: false, code: 'out_of_community' };
    }
    if (await hasMonthlyReturnBonus(db, player.id)) {
        return { created: false, code: 'monthly_limit' };
    }

    const amount = levelInfo.key === 'official_7' ? 5 : 10;
    const hours = levelInfo.key === 'candidate_14' ? 48 : 72;
    const result = await createReturnBonus({
        db,
        playerId: player.id,
        bonusPh: amount,
        hours,
        createdBy: 'system',
        source: 'auto',
        conditionText: 'Cena de UP aprovada dentro do prazo.',
        metadata: { antighost_level: levelInfo.key },
    });

    if (!result.ok) return { created: false, code: result.code, bonus: result.bonus };

    try {
        const privateResult = await sendPrivateText({
            sock,
            playerId: player.id,
            text: renderReturnBonusOffer(result.bonus),
        });
        if (privateResult?.skipped) {
            await writeEvent(db, {
                playerId: player.id,
                eventType: 'return_bonus_offer_failed',
                metadata: {
                    return_bonus_id: result.bonus.id,
                    notice_level: levelInfo.key,
                    reason: privateResult.reason,
                },
            });
            return { created: true, bonus: result.bonus, sent: false };
        }
        await writeEvent(db, {
            playerId: player.id,
            eventType: 'return_bonus_offer_sent',
            metadata: {
                return_bonus_id: result.bonus.id,
                notice_level: levelInfo.key,
            },
        });
    } catch (error) {
        await writeEvent(db, {
            playerId: player.id,
            eventType: 'return_bonus_offer_failed',
            metadata: {
                return_bonus_id: result.bonus.id,
                notice_level: levelInfo.key,
                error: error?.message || String(error),
            },
        }).catch(() => null);
        return { created: true, bonus: result.bonus, sent: false };
    }
    return { created: true, bonus: result.bonus, sent: true };
}

function renderReturnBonusOffer(bonus) {
    return [
        '*♧┃MIMOSA GUARDOU UMA CHANCE PARA VOCÊ 𖥔 CLOVER MULTICOLOR*',
        '     ── bônus de retorno ──',
        '',
        '_`─( ✦ )───── Oferta ativa`_',
        '',
        '*𝑩𝒐̂𝒏𝒖𝒔:*',
        `> ${bonus.bonus_label}`,
        '',
        '*𝑷𝒓𝒂𝒛𝒐:*',
        `> ${bonus.expires_at}`,
        '',
        '*𝑪𝒐𝒏𝒅𝒊𝒄̧𝒂̃𝒐:*',
        `> ${bonus.condition_text || 'Cena de UP aprovada.'}`,
        '',
        '*Esse bônus é só para retorno.*',
        '*Se não cumprir a condição dentro do prazo, ele expira.*',
    ].join('\n');
}

function classifyAntiGhostPrivateReply(text) {
    const normalized = normalizeText(text).replace(/[^a-z0-9]+/g, ' ').trim();
    const compact = normalized.replace(/\s+/g, '');
    const phrases = new Set([
        'apagar personagem',
        'apagar meu personagem',
        'encerrar personagem',
        'encerrar meu personagem',
        'encerrar registro',
        'encerrar meu registro',
        'remover personagem',
        'remover meu personagem',
        'liberar vaga',
        'liberar minha vaga',
        'sair do rpg',
        'quero sair do rpg',
        'nao vou jogar',
        'nao quero jogar',
    ]);
    const compactPhrases = new Set([...phrases].map((item) => item.replace(/\s+/g, '')));

    if (phrases.has(normalized) || compactPhrases.has(compact)) return 'confirm_exit';
    if (/^(quero|pode|pode\s+sim)\s+(apagar|encerrar|remover)\s+(meu\s+)?personagem$/.test(normalized)) return 'confirm_exit';
    return null;
}

function renderAntiGhostExitConfirmedMessage() {
    return [
        '*♧┃REGISTRO ENCERRADO 𖥔 CLOVER MULTICOLOR*',
        '     ── pedido confirmado ──',
        '',
        'Entendido.',
        '',
        'Seu personagem foi encerrado e sua vaga foi liberada.',
        '',
        'Se isso foi um engano, fale com a administração.',
    ].join('\n');
}

async function findActivePlayerByPrivateId(db, playerId) {
    const normalized = normalizeJid(playerId);
    const phone = comparablePhoneDigits(normalized);
    const rows = await db.all(
        `SELECT *
         FROM jogadores
         WHERE jogo_status = 'liberado'
            OR ficha_status = 'aprovada'
            OR personagem_aparencia_status IN ('approved', 'aprovada')`
    );

    return rows.find((player) => {
        if (isSameUser(player.id, normalized)) return true;
        if (normalizeJid(player.id) === normalized) return true;
        const playerPhone = comparablePhoneDigits(player.id);
        return Boolean(phone && playerPhone && phone === playerPhone);
    }) || null;
}

async function sendAntiGhostPrivateReply({ sock, playerId, text, sendPrivateTextFn }) {
    if (typeof sendPrivateTextFn === 'function') {
        return sendPrivateTextFn({ sock, playerId, text });
    }
    return sendPrivateText({ sock, playerId, text });
}

async function handleAntiGhostPrivateReply({ sock, db, playerId, text, sendPrivateTextFn = null }) {
    const denied = lifecycleSkip({surface:'private_reply',operation:'handleAntiGhostPrivateReply',mutationClass:'CURRENT_WORLD'});
    if (denied) return {...denied,handled:false};

    await ensureAntiGhostSchema(db);
    const action = classifyAntiGhostPrivateReply(text);
    if (!action) return { handled: false };

    const player = await findActivePlayerByPrivateId(db, playerId);
    if (!player) return { handled: false, reason: 'player_not_found' };

    const activity = await getPlayerActivity(db, player.id);
    const levelInfo = computeLevel(activity, new Date());
    const hasAntiGhostContext = Boolean(
        activity?.last_notice_at
        || activity?.candidate_at
        || ['light_3', 'checklist_5', 'official_7', 'strong_10', 'candidate_14'].includes(levelInfo.key)
    );
    if (!hasAntiGhostContext) return { handled: false, reason: 'no_antighost_context' };

    const result = await removePlayerForAntiGhost({
        sock,
        db,
        player,
        moderatorId: player.id,
        reason: 'pedido do player por resposta anti-ghost',
    });

    await sendAntiGhostPrivateReply({
        sock,
        playerId,
        text: renderAntiGhostExitConfirmedMessage(),
        sendPrivateTextFn,
    }).catch((error) => {
        console.log('[anti-ghost] nao consegui responder encerramento no PV:', error?.message || error);
    });

    return { handled: true, action: 'confirmed_exit', result };
}

async function runAntiGhostSweep({ sock, db, force = false } = {}) {
    assertLifecycleAllowed({surface:'internal',operation:'runAntiGhostSweep',mutationClass:'CURRENT_WORLD'});

    await ensureAntiGhostSchema(db);
    if (!force && !await isAntiGhostEnabled(db)) {
        return { ok: false, disabled: true };
    }
    await expireReturnBonuses(db);

    const players = await getActivePlayers(db);
    const now = new Date();
    const result = {
        ok: true,
        checked: players.length,
        sent: 0,
        failed: 0,
        candidates: [],
        bonuses: 0,
        skipped: {
            safe: 0,
            exempt: 0,
            repeat: 0,
        },
    };

    for (const player of players) {
        let activity = await upsertActivityRow(db, player.id);
        if (!activity.last_activity_at) {
            const startAt = player.jogo_liberado_at || nowSqlite();
            await db.run(
                `UPDATE clover_antighost_activity
                 SET last_activity_at = ?,
                     last_activity_kind = 'start',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE player_id = ?`,
                [startAt, player.id]
            );
            activity = await getPlayerActivity(db, player.id);
        }
        const levelInfo = computeLevel(activity, now);
        if (levelInfo.key === 'exempt') {
            result.skipped.exempt += 1;
            continue;
        }
        if (!levelInfo.level) {
            result.skipped.safe += 1;
            continue;
        }

        if (levelInfo.key === 'candidate_14' && !activity.candidate_at) {
            await db.run(
                `UPDATE clover_antighost_activity
                 SET candidate_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE player_id = ?`,
                [player.id]
            );
        }
        if (levelInfo.key === 'candidate_14') {
            result.candidates.push({ player, activity, levelInfo });
        }

        if (!force && activity.last_notice_level === levelInfo.key) {
            result.skipped.repeat += 1;
            await maybeCreateAutoReturnBonus({ db, sock, player, activity, levelInfo })
                .then((bonus) => {
                    if (bonus.created) result.bonuses += 1;
                })
                .catch(() => null);
            continue;
        }

        const text = await renderNoticeMessage(db, player, activity, levelInfo);
        try {
            const privateResult = await sendPrivateText({ sock, playerId: player.id, text });
            if (privateResult?.skipped) {
                result.failed += 1;
                await writeEvent(db, {
                    playerId: player.id,
                    eventType: 'notice_failed',
                    metadata: {
                        notice_level: levelInfo.key,
                        reason: privateResult.reason,
                    },
                }).catch(() => null);
                continue;
            }
            result.sent += 1;
            await writeEvent(db, {
                playerId: player.id,
                eventType: 'notice_sent',
                metadata: { notice_level: levelInfo.key },
            });
            await db.run(
                `UPDATE clover_antighost_activity
                 SET last_notice_level = ?,
                     last_notice_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE player_id = ?`,
                [levelInfo.key, player.id]
            );
        } catch (error) {
            result.failed += 1;
            await writeEvent(db, {
                playerId: player.id,
                eventType: 'notice_failed',
                metadata: {
                    notice_level: levelInfo.key,
                    error: error?.message || String(error),
                },
            }).catch(() => null);
        }

        const bonus = await maybeCreateAutoReturnBonus({ db, sock, player, activity, levelInfo }).catch(() => null);
        if (bonus?.created) result.bonuses += 1;
    }

    return result;
}

async function getAntiGhostStatus(db) {
    await ensureAntiGhostSchema(db);
    const enabled = await isAntiGhostEnabled(db);
    const rows = await db.all(
        `SELECT a.*, j.nome, j.display_name, j.personagem_nome, j.jogo_status
         FROM clover_antighost_activity a
         LEFT JOIN jogadores j ON j.id = a.player_id
         WHERE j.jogo_status = 'liberado'
         ORDER BY a.candidate_at DESC, a.last_notice_at DESC`
    );

    const counts = { ok: 0, light: 0, warned: 0, strong: 0, candidate: 0, exempt: 0 };
    const community = { member: 0, out: 0, unknown: 0 };
    const now = new Date();
    for (const row of rows) {
        const level = computeLevel(row, now);
        if (level.key === 'exempt') counts.exempt += 1;
        else if (level.key === 'candidate_14') counts.candidate += 1;
        else if (level.key === 'strong_10') counts.strong += 1;
        else if (level.key === 'official_7') counts.warned += 1;
        else if (['light_3', 'checklist_5'].includes(level.key)) counts.light += 1;
        else counts.ok += 1;

        if (row.community_status === 'member') community.member += 1;
        else if (row.community_status === 'out') community.out += 1;
        else community.unknown += 1;
    }

    return { enabled, total: rows.length, counts, community };
}

const DELIVERY_EVENT_TYPES = new Set([
    'notice_sent',
    'notice_failed',
    'activation_notice_sent',
    'activation_notice_failed',
    'return_bonus_offer_sent',
    'return_bonus_offer_failed',
    'return_bonus_fulfilled',
    'removed',
    'manual_reset',
    'manual_exempt',
    'community_sync_member',
    'community_sync_out',
]);

function deliveryEventLabel(type) {
    const labels = {
        notice_sent: 'aviso enviado',
        notice_failed: 'aviso falhou',
        activation_notice_sent: 'ativação enviada',
        activation_notice_failed: 'ativação falhou',
        return_bonus_offer_sent: 'bônus enviado',
        return_bonus_offer_failed: 'bônus falhou',
        return_bonus_fulfilled: 'bônus concluído',
        removed: 'remoção registrada',
        manual_reset: 'risco resetado',
        manual_exempt: 'pausa registrada',
        community_sync_member: 'marcado dentro',
        community_sync_out: 'marcado fora',
    };
    return labels[type] || type || '-';
}

function noticeLevelLabel(level) {
    const labels = {
        light_3: 'lembrete 3d',
        checklist_5: 'checklist 5d',
        official_7: 'aviso 7d',
        strong_10: 'aviso 10d',
        candidate_14: 'análise 14d',
        exempt: 'pausa',
    };
    return labels[level] || level || '-';
}

async function getAntiGhostDeliveryAudit(db, { limit = 20 } = {}) {
    await ensureAntiGhostSchema(db);
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const eventTypes = [...DELIVERY_EVENT_TYPES];
    const placeholders = eventTypes.map(() => '?').join(', ');

    const events = await db.all(
        `SELECT e.id AS event_id,
                e.player_id,
                e.event_type,
                e.group_id,
                e.message_key,
                e.occurred_at,
                e.metadata_json,
                j.nome,
                j.display_name,
                j.personagem_nome
         FROM clover_antighost_events e
         LEFT JOIN jogadores j ON j.id = e.player_id
         WHERE e.event_type IN (${placeholders})
         ORDER BY datetime(e.occurred_at) DESC, e.id DESC
         LIMIT ?`,
        [...eventTypes, safeLimit]
    );

    const notices = await db.all(
        `SELECT a.player_id,
                a.last_notice_level,
                a.last_notice_at,
                a.community_status,
                j.nome,
                j.display_name,
                j.personagem_nome
         FROM clover_antighost_activity a
         LEFT JOIN jogadores j ON j.id = a.player_id
         WHERE a.last_notice_at IS NOT NULL
         ORDER BY datetime(a.last_notice_at) DESC
         LIMIT ?`,
        [Math.min(10, safeLimit)]
    );

    return { events, notices };
}

function renderDeliveryAudit(audit) {
    const events = audit?.events || [];
    const notices = audit?.notices || [];
    const lines = [
        '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
        '     ── auditoria de envios ──',
        '',
        '_`─( ✦ )───── Eventos recentes`_',
    ];

    if (!events.length) {
        lines.push('> Nenhum evento de envio registrado ainda.');
    } else {
        for (const event of events.slice(0, 20)) {
            const metadata = safeJsonParse(event.metadata_json, {});
            const name = playerName(event);
            const level = metadata.notice_level ? ` · ${noticeLevelLabel(metadata.notice_level)}` : '';
            const extra = metadata.error ? ` · falha: ${String(metadata.error).slice(0, 80)}` : '';
            lines.push(`> ${event.occurred_at || '-'} · ${deliveryEventLabel(event.event_type)} · ${name}${level}${extra}`);
        }
    }

    lines.push('', '_`─( ◆ )───── Últimos avisos gravados`_');

    if (!notices.length) {
        lines.push('> Nenhum aviso gravado em atividade ainda.');
    } else {
        for (const notice of notices.slice(0, 10)) {
            lines.push(`> ${notice.last_notice_at || '-'} · ${playerName(notice)} · ${noticeLevelLabel(notice.last_notice_level)} · comunidade: ${notice.community_status || 'unknown'}`);
        }
    }

    lines.push('', `Use *${COMMAND_PREFIX}antighost avisar* para reenviar avisos dos candidatos atuais.`);
    return lines.join('\n');
}

async function listCandidates(db) {
    await ensureAntiGhostSchema(db);
    const rows = await db.all(
        `SELECT a.*, j.*
         FROM clover_antighost_activity a
         JOIN jogadores j ON j.id = a.player_id
         WHERE j.jogo_status = 'liberado'
         ORDER BY a.candidate_at DESC, a.last_activity_at ASC`
    );
    return rows
        .map((row) => ({ player: row, activity: row, levelInfo: computeLevel(row, new Date()) }))
        .filter((item) => item.levelInfo.key === 'candidate_14');
}

async function setExemption(db, playerId, days, reason) {
    await ensureAntiGhostSchema(db);
    await upsertActivityRow(db, playerId);
    const until = addDaysSqlite(Math.max(1, Math.min(365, Number(days) || 30)));
    await db.run(
        `UPDATE clover_antighost_activity
         SET exempt_until = ?,
             exempt_reason = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [until, String(reason || 'ausência avisada').trim(), playerId]
    );
    await writeEvent(db, {
        playerId,
        eventType: 'manual_exempt',
        metadata: { until, reason: String(reason || 'ausência avisada').trim() },
    });
    return { until };
}

async function resetPlayerActivity(db, playerId, reason = 'reset manual') {
    await ensureAntiGhostSchema(db);
    await upsertActivityRow(db, playerId);
    const now = nowSqlite();
    await db.run(
        `UPDATE clover_antighost_activity
         SET last_activity_at = ?,
             last_activity_kind = 'manual_reset',
             last_notice_level = NULL,
             last_notice_at = NULL,
             candidate_at = NULL,
             exempt_until = NULL,
             exempt_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [now, playerId]
    );
    await writeEvent(db, {
        playerId,
        eventType: 'manual_reset',
        occurredAt: now,
        metadata: { reason },
    });
    return { ok: true, at: now };
}

async function removePlayerForAntiGhost({ sock, db, player, moderatorId, reason = 'anti-ghost' }) {
    assertLifecycleAllowed({surface:'internal',operation:'removePlayerForAntiGhost',mutationClass:'CURRENT_WORLD'});
    return archiveAndResetPlayer({
        sock,
        db,
        playerId: player.id,
        reason: `anti-ghost: ${reason}`,
        actorId: moderatorId,
    });
}

async function getPlayerActivity(db, playerId) {
    await ensureAntiGhostSchema(db);
    return upsertActivityRow(db, playerId);
}

async function getReturnBonuses(db, playerId = null, limit = 20) {
    await ensureAntiGhostSchema(db);
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    if (playerId) {
        return db.all(
            `SELECT * FROM clover_return_bonuses
             WHERE player_id = ?
             ORDER BY id DESC
             LIMIT ?`,
            [playerId, safeLimit]
        );
    }
    return db.all(
        `SELECT * FROM clover_return_bonuses
         ORDER BY id DESC
         LIMIT ?`,
        [safeLimit]
    );
}

function renderStatusMessage(status) {
    return [
        '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
        '     ── status do sistema ──',
        '',
        `*Ativo:* ${status.enabled ? 'sim' : 'não'}`,
        `*Players acompanhados:* ${status.total}`,
        '',
        `*Seguro:* ${status.counts.ok}`,
        `*Lembrete:* ${status.counts.light}`,
        `*Avisado:* ${status.counts.warned}`,
        `*Forte:* ${status.counts.strong}`,
        `*Candidatos:* ${status.counts.candidate}`,
        `*Isentos:* ${status.counts.exempt}`,
        '',
        `*Na comunidade:* ${status.community?.member || 0}`,
        `*Fora da comunidade:* ${status.community?.out || 0}`,
        `*Comunidade desconhecida:* ${status.community?.unknown || 0}`,
        '',
        `Use *${COMMAND_PREFIX}antighost sincronizarcomunidade* para atualizar presença pelo grupo de avisos.`,
    ].join('\n');
}

function renderCandidatesList(items) {
    if (!items.length) {
        return [
            '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
            '     ── candidatos à remoção ──',
            '',
            'Nenhum player atingiu a lista de remoção agora.',
        ].join('\n');
    }
    return [
        '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
        '     ── candidatos à remoção ──',
        '',
        ...items.slice(0, 30).map((item, index) => {
            const phone = String(item.player.id || '').split('@')[0];
            return `${index + 1}. ${playerName(item.player)} - @${phone} - ${item.levelInfo.days} dias`;
        }),
        '',
        `Use *${COMMAND_PREFIX}antighost remover @player/últimos 4 dígitos* para remover manualmente.`,
    ].join('\n');
}

async function renderPlayerActivityStatus(db, player) {
    const activity = await getPlayerActivity(db, player.id);
    const levelInfo = computeLevel(activity, new Date());
    const activeBonus = await getActiveReturnBonus(db, player.id);
    const status = levelInfo.key === 'exempt'
        ? 'Pausa registrada.'
        : levelInfo.key === 'candidate_14'
            ? 'Em análise por inatividade.'
            : ['official_7', 'strong_10'].includes(levelInfo.key)
                ? 'Avisado por inatividade.'
                : 'Seguro.';

    const lines = [
        '*♧┃ATIVIDADE 𖥔 CLOVER MULTICOLOR*',
        '     ── sua situação atual ──',
        '',
        '*𝑺𝒕𝒂𝒕𝒖𝒔:*',
        `> ${status}`,
        '',
        '*𝑫𝒊𝒂𝒔 𝒔𝒆𝒎 𝒂𝒕𝒊𝒗𝒊𝒅𝒂𝒅𝒆 𝒇𝒐𝒓𝒕𝒆:*',
        `> ${levelInfo.days ?? 0}`,
        '',
        '*𝑼́𝒍𝒕𝒊𝒎𝒂 𝒂𝒕𝒊𝒗𝒊𝒅𝒂𝒅𝒆:*',
        `> ${activity.last_activity_at || 'sem registro'}`,
    ];

    if (activity.community_status === 'out') {
        lines.push('', '*𝑪𝒐𝒎𝒖𝒏𝒊𝒅𝒂𝒅𝒆:*', '> fora/pendente.');
    }

    if (activeBonus) {
        lines.push(
            '',
            '_`─( ✦ )───── Bônus de retorno`_',
            '',
            '*𝑩𝒐̂𝒏𝒖𝒔:*',
            `> ${activeBonus.bonus_label}`,
            '',
            '*𝑷𝒓𝒂𝒛𝒐:*',
            `> ${activeBonus.expires_at}`,
            '',
            '*𝑪𝒐𝒏𝒅𝒊𝒄̧𝒂̃𝒐:*',
            `> ${activeBonus.condition_text || 'Cena de UP aprovada.'}`
        );
    }

    return lines.join('\n');
}

module.exports = {
    buildMessageKey,
    activateAntiGhost,
    applyReturnBonusForEvaluation,
    createReturnBonus,
    deactivateAntiGhost,
    ensureAntiGhostSchema,
    expireReturnBonuses,
    getActiveReturnBonus,
    getAntiGhostDeliveryAudit,
    getAntiGhostStatus,
    getMessageTimestamp,
    getPlayerActivity,
    getReturnBonuses,
    handleAntiGhostPrivateReply,
    isAntiGhostEnabled,
    isRelevantCommand,
    listCandidates,
    markCommunityStatus,
    parseManualSceneDate,
    parseSqliteDate,
    recordCommandActivity,
    recordEvaluationActivity,
    recordMessageActivity,
    removePlayerForAntiGhost,
    renderCandidatesList,
    renderDeliveryAudit,
    renderPlayerActivityStatus,
    renderReturnBonusOffer,
    renderReturnBonusResult,
    renderStatusMessage,
    resetPlayerActivity,
    resolveSceneSentAt,
    runAntiGhostSweep,
    setExemption,
    syncCommunityMembership,
};
