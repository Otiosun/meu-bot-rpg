const DELIVERY_STATUSES = new Set(['pending', 'processing', 'sent', 'failed', 'cancelled']);
const PRIVATE_DELIVERY_KINDS = new Set(['private_text', 'private_message', 'spell_review_invite']);
const LOW_PRIORITY_SOURCES = new Set(['weekly_checklist_reset', 'checklist', 'incentivo']);
const MANUAL_SOURCES = new Set(['testepv', 'manual']);
const CRITICAL_SOURCES = new Set([
    'spell_review',
    'group_request',
    'historia_jogo',
    'appearance_approved',
    'aparencia_aprovada',
    'game_liberated',
    'jogo_liberado',
    'post_ficha',
]);
const GHOST_SOURCES = new Set(['anti_ghost', 'antighost', 'community_exit', 'saida_comunidade', 'return_bonus']);

function nowSqlite() {
    return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value ?? null);
    } catch {
        return JSON.stringify(null);
    }
}

function normalizeKeyPart(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9@._:-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 160);
}

function classifyDelivery({ kind, source = '', reason = '', payload = {} } = {}) {
    if (!PRIVATE_DELIVERY_KINDS.has(String(kind || ''))) return 'system';

    const sourceKey = normalizeKeyPart(source || payload.source || payload.message?.source);
    const reasonKey = normalizeKeyPart(reason || payload.reason || payload.message?.reason);
    const joined = `${sourceKey} ${reasonKey}`;

    if (MANUAL_SOURCES.has(sourceKey) || joined.includes('teste_manual')) return 'manual';
    if (LOW_PRIORITY_SOURCES.has(sourceKey) || joined.includes('weekly_reset') || joined.includes('checklist')) return 'low';
    if (GHOST_SOURCES.has(sourceKey) || joined.includes('ghost') || joined.includes('saida') || joined.includes('exit')) return 'ghost';
    if (CRITICAL_SOURCES.has(sourceKey) || String(kind) === 'spell_review_invite') return 'critical';

    return 'normal';
}

function buildDeliveryDedupeKey({ kind, targetJid, source, reason, metadata, category } = {}) {
    if (!PRIVATE_DELIVERY_KINDS.has(String(kind || ''))) return null;
    if (category === 'manual') return null;

    const weekKey = metadata?.week_key ? `week:${metadata.week_key}` : '';
    const reasonKey = normalizeKeyPart(reason || metadata?.reason || '');
    const sourceKey = normalizeKeyPart(source || '');
    return [
        normalizeKeyPart(kind),
        normalizeKeyPart(targetJid),
        sourceKey,
        weekKey || reasonKey,
    ].filter(Boolean).join('|');
}

function sanitizeMessageForQueue(message = {}) {
    if (!message || typeof message !== 'object') return null;

    if (message.text || message.groupInvite) {
        return {
            text: message.text || undefined,
            mentions: Array.isArray(message.mentions) ? message.mentions : undefined,
            groupInvite: message.groupInvite || undefined,
        };
    }

    if (message.caption) {
        return {
            text: message.caption,
            mentions: Array.isArray(message.mentions) ? message.mentions : undefined,
            metadata: { media_dropped: true },
        };
    }

    return null;
}

async function addColumnIfMissing(db, tableName, columnName, definition) {
    const columns = await db.all(`PRAGMA table_info(${tableName})`).catch(() => []);
    const names = new Set((columns || []).map((column) => column.name));
    if (!names.has(columnName)) {
        await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}

async function ensureDeliverySchema(db) {
    if (!db?.exec) return;

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_delivery_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            target_jid TEXT DEFAULT NULL,
            group_id TEXT DEFAULT NULL,
            payload_json TEXT DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
            priority INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            run_after TEXT DEFAULT CURRENT_TIMESTAMP,
            locked_at TEXT DEFAULT NULL,
            locked_by TEXT DEFAULT NULL,
            sent_at TEXT DEFAULT NULL,
            last_error TEXT DEFAULT NULL,
            result_json TEXT DEFAULT NULL,
            created_by TEXT DEFAULT 'system',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await addColumnIfMissing(db, 'clover_delivery_jobs', 'category', "TEXT DEFAULT 'normal'");
    await addColumnIfMissing(db, 'clover_delivery_jobs', 'dedupe_key', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_delivery_jobs_pick
        ON clover_delivery_jobs (status, run_after, priority DESC, id ASC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_delivery_jobs_target
        ON clover_delivery_jobs (target_jid, status, created_at DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_delivery_jobs_dedupe
        ON clover_delivery_jobs (dedupe_key, status)
    `);
}

async function enqueueDeliveryJob(db, {
    kind,
    targetJid = null,
    groupId = null,
    payload = {},
    priority = 0,
    runAfter = null,
    maxAttempts = 3,
    createdBy = 'system',
    category = null,
    dedupeKey = null,
} = {}) {
    if (!db?.run || !kind) return { ok: false, reason: 'missing_db_or_kind' };
    await ensureDeliverySchema(db);

    if (dedupeKey) {
        const existing = await db.get(
            `SELECT id
             FROM clover_delivery_jobs
             WHERE dedupe_key = ?
               AND status IN ('pending', 'processing')
             ORDER BY id DESC
             LIMIT 1`,
            [dedupeKey]
        ).catch(() => null);
        if (existing?.id) return { ok: true, jobId: existing.id, duplicate: true };
    }

    const result = await db.run(
        `INSERT INTO clover_delivery_jobs
         (kind, target_jid, group_id, payload_json, priority, run_after, max_attempts, created_by, category, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
            String(kind),
            targetJid || null,
            groupId || null,
            safeJsonStringify(payload),
            Number(priority || 0),
            runAfter || null,
            Number(maxAttempts || 3),
            String(createdBy || 'system'),
            category || 'normal',
            dedupeKey || null,
        ]
    );

    return { ok: true, jobId: result?.lastID || null };
}

async function enqueuePrivateMessage(db, {
    targetJid,
    message,
    source = 'private_message',
    reason = null,
    metadata = {},
    priority = 0,
} = {}) {
    const sanitized = sanitizeMessageForQueue(message);
    if (!targetJid || !sanitized) {
        return { ok: false, reason: 'unsupported_private_message' };
    }
    const category = classifyDelivery({ kind: 'private_message', source, reason, payload: { message: sanitized } });
    const dedupeKey = buildDeliveryDedupeKey({ kind: 'private_message', targetJid, source, reason, metadata, category });

    return enqueueDeliveryJob(db, {
        kind: 'private_message',
        targetJid,
        payload: {
            message: sanitized,
            source,
            reason,
            metadata,
        },
        priority,
        category,
        dedupeKey,
        createdBy: source,
    });
}

async function enqueuePrivateText(db, {
    targetJid,
    text,
    mentions = [],
    source = 'private_text',
    reason = null,
    metadata = {},
    priority = 0,
    runAfter = null,
    maxAttempts = 3,
} = {}) {
    if (!targetJid || !text) return { ok: false, reason: 'missing_target_or_text' };
    const category = classifyDelivery({ kind: 'private_text', source, reason, payload: { text } });
    const dedupeKey = buildDeliveryDedupeKey({ kind: 'private_text', targetJid, source, reason, metadata, category });

    return enqueueDeliveryJob(db, {
        kind: 'private_text',
        targetJid,
        payload: {
            text,
            mentions,
            source,
            reason,
            metadata,
        },
        priority,
        runAfter,
        maxAttempts,
        category,
        dedupeKey,
        createdBy: source,
    });
}

async function enqueueSpellReviewInvite(db, {
    playerId,
    rotate = false,
    addToGroup = true,
    source = 'spell_review',
    reason = null,
    priority = 20,
} = {}) {
    if (!playerId) return { ok: false, reason: 'missing_player' };
    await ensureDeliverySchema(db);
    const existing = await db.get(
        `SELECT id
         FROM clover_delivery_jobs
         WHERE kind = 'spell_review_invite'
           AND target_jid = ?
           AND status IN ('pending', 'processing')
         ORDER BY id DESC
         LIMIT 1`,
        [playerId]
    ).catch(() => null);
    if (existing?.id) return { ok: true, jobId: existing.id, duplicate: true };

    return enqueueDeliveryJob(db, {
        kind: 'spell_review_invite',
        targetJid: playerId,
        payload: { playerId, rotate, addToGroup, source, reason },
        priority,
        category: 'critical',
        dedupeKey: buildDeliveryDedupeKey({
            kind: 'spell_review_invite',
            targetJid: playerId,
            source,
            reason,
            category: 'critical',
        }),
        createdBy: source,
    });
}

async function enqueueSpellReviewRemove(db, {
    playerId,
    source = 'spell_review',
    reason = null,
    priority = 15,
} = {}) {
    if (!playerId) return { ok: false, reason: 'missing_player' };
    return enqueueDeliveryJob(db, {
        kind: 'spell_review_remove',
        targetJid: playerId,
        payload: { playerId, source, reason },
        priority,
        category: 'critical',
        createdBy: source,
    });
}

async function enqueueApprovalSweep(db, { groupType, source = 'group_request', priority = 10 } = {}) {
    if (!['spell_review', 'off'].includes(groupType)) return { ok: false, reason: 'invalid_group_type' };
    return enqueueDeliveryJob(db, {
        kind: groupType === 'spell_review' ? 'approve_pending_spell_review' : 'approve_pending_off',
        payload: { groupType, source },
        priority,
        category: 'system',
        createdBy: source,
    });
}

async function getDeliveryStats(db) {
    await ensureDeliverySchema(db);
    const rows = await db.all(
        `SELECT status, COUNT(*) AS total
         FROM clover_delivery_jobs
         GROUP BY status`
    );
    const stats = { pending: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };
    for (const row of rows || []) {
        if (DELIVERY_STATUSES.has(row.status)) stats[row.status] = Number(row.total || 0);
    }
    return stats;
}

async function listRecentDeliveryJobs(db, limit = 15) {
    await ensureDeliverySchema(db);
    return db.all(
        `SELECT id, kind, target_jid, group_id, status, attempts, max_attempts,
                last_error, created_by, category, dedupe_key, created_at, updated_at, sent_at
         FROM clover_delivery_jobs
         ORDER BY id DESC
         LIMIT ?`,
        [Math.max(1, Math.min(50, Number(limit || 15)))]
    );
}

async function retryDeliveryJob(db, id) {
    await ensureDeliverySchema(db);
    const result = await db.run(
        `UPDATE clover_delivery_jobs
         SET status = 'pending',
             locked_at = NULL,
             locked_by = NULL,
             run_after = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND status IN ('failed', 'processing')`,
        [id]
    );
    return { ok: Number(result?.changes || 0) > 0 };
}

async function cancelDeliveryJob(db, id) {
    await ensureDeliverySchema(db);
    const result = await db.run(
        `UPDATE clover_delivery_jobs
         SET status = 'cancelled',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND status IN ('pending', 'processing', 'failed')`,
        [id]
    );
    return { ok: Number(result?.changes || 0) > 0 };
}

module.exports = {
    cancelDeliveryJob,
    classifyDelivery,
    enqueueApprovalSweep,
    enqueueDeliveryJob,
    enqueuePrivateMessage,
    enqueuePrivateText,
    enqueueSpellReviewInvite,
    enqueueSpellReviewRemove,
    ensureDeliverySchema,
    getDeliveryStats,
    listRecentDeliveryJobs,
    nowSqlite,
    retryDeliveryJob,
    sanitizeMessageForQueue,
};
