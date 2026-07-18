const { ensureCloverRecruitmentSchema } = require('../../database');

const DEFAULT_EVENT_KEY = 'divulgacao_v1';
const PR_SOURCES = new Set([
    'recrutamento',
    'divulgacao_grupo',
    'loja',
    'ajuste_admin',
    'estorno',
]);

class PrServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PrServiceError';
        this.code = code;
        this.details = details;
    }
}

function asInteger(value, options = {}) {
    const amount = Number(value);
    if (!Number.isInteger(amount) || Number.isNaN(amount) || amount === 0) {
        throw new PrServiceError('invalid_amount', 'Quantidade de PR inválida.');
    }
    if (!options.allowNegative && amount < 0) {
        throw new PrServiceError('invalid_amount', 'Quantidade de PR precisa ser positiva.');
    }
    return amount;
}

function normalizeOptional(value) {
    const text = String(value || '').trim();
    return text || null;
}

function serializeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return JSON.stringify(metadata);
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function getMondayWeekKey(date = new Date()) {
    const start = new Date(date);
    if (Number.isNaN(start.getTime())) {
        throw new PrServiceError('invalid_date', 'Data inválida para o cálculo semanal.');
    }
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
}

async function getEvent(db, eventKey = DEFAULT_EVENT_KEY) {
    await ensureCloverRecruitmentSchema(db);
    const event = await db.get(
        'SELECT * FROM clover_recruitment_events WHERE event_key = ?',
        [eventKey]
    );
    if (!event) {
        throw new PrServiceError('event_not_found', 'Evento de divulgação não encontrado.');
    }
    return event;
}

async function ensurePlayerExists(db, playerId) {
    if (!playerId) {
        throw new PrServiceError('missing_player', 'Player inválido.');
    }
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        throw new PrServiceError('player_not_found', 'Player não encontrado.');
    }
}

async function getPrBalance(db, playerId) {
    await ensureCloverRecruitmentSchema(db);
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS balance
         FROM clover_pr_ledger
         WHERE player_id = ?`,
        [playerId]
    );
    return Number(row?.balance || 0);
}

async function getGroupWeekEarned(db, playerId, eventId, weekKey) {
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS earned
         FROM clover_pr_ledger
         WHERE player_id = ?
           AND event_id = ?
           AND source = 'divulgacao_grupo'
           AND week_key = ?`,
        [playerId, eventId, weekKey]
    );
    return Math.max(0, Number(row?.earned || 0));
}

async function findIdempotentEntry(db, idempotencyKey) {
    const key = normalizeOptional(idempotencyKey);
    if (!key) return null;
    return db.get('SELECT * FROM clover_pr_ledger WHERE idempotency_key = ?', [key]);
}

async function insertPrEntry(db, entry) {
    const result = await db.run(
        `INSERT INTO clover_pr_ledger (
            player_id,
            event_id,
            amount,
            kind,
            source,
            week_key,
            reason,
            related_id,
            idempotency_key,
            created_by,
            created_at,
            metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            entry.playerId,
            entry.eventId,
            entry.amount,
            entry.kind,
            entry.source,
            entry.weekKey,
            normalizeOptional(entry.reason),
            normalizeOptional(entry.relatedId),
            normalizeOptional(entry.idempotencyKey),
            normalizeOptional(entry.createdBy),
            serializeMetadata(entry.metadata),
        ]
    );
    return db.get('SELECT * FROM clover_pr_ledger WHERE id = ?', [result.lastID]);
}

function mutationResult(entry, balanceBefore, balanceAfter, duplicate = false) {
    return {
        ok: true,
        duplicate,
        ledgerId: entry.id,
        playerId: entry.player_id,
        eventId: entry.event_id,
        amount: Number(entry.amount),
        kind: entry.kind,
        source: entry.source,
        weekKey: entry.week_key,
        balanceBefore,
        balanceAfter,
    };
}

async function mutatePrInTransaction(db, playerId, entry) {
    await ensureCloverRecruitmentSchema(db);
    await ensurePlayerExists(db, playerId);

    if (!PR_SOURCES.has(entry.source)) {
        throw new PrServiceError('invalid_source', 'Origem de PR inválida.');
    }

    const duplicate = await findIdempotentEntry(db, entry.idempotencyKey);
    if (duplicate) {
        if (duplicate.player_id !== playerId) {
            throw new PrServiceError('idempotency_conflict', 'A chave de idempotência pertence a outro player.');
        }
        const duplicateAfter = await db.get(
            `SELECT COALESCE(SUM(amount), 0) AS balance
             FROM clover_pr_ledger
             WHERE player_id = ? AND id <= ?`,
            [playerId, duplicate.id]
        );
        const balanceAfter = Number(duplicateAfter?.balance || 0);
        return mutationResult(duplicate, balanceAfter - Number(duplicate.amount), balanceAfter, true);
    }

    const event = await getEvent(db, entry.eventKey || DEFAULT_EVENT_KEY);
    const amount = asInteger(entry.amount, { allowNegative: true });
    const occurredAt = new Date(entry.occurredAt || Date.now());
    const startsAt = event.starts_at ? new Date(`${event.starts_at}Z`) : null;
    const endsAt = event.ends_at ? new Date(`${event.ends_at}Z`) : null;
    const outsideWindow = (startsAt && occurredAt < startsAt) || (endsAt && occurredAt > endsAt);
    if (entry.source === 'divulgacao_grupo' && amount > 0 && (event.status !== 'active' || outsideWindow)) {
        throw new PrServiceError('event_not_active', 'O evento de divulgação não está ativo no momento.', {
            eventStatus: event.status,
        });
    }
    const balanceBefore = await getPrBalance(db, playerId);
    const balanceAfter = balanceBefore + amount;
    if (balanceAfter < 0) {
        throw new PrServiceError('insufficient_pr', 'Saldo de PR insuficiente.', {
            balance: balanceBefore,
            requested: Math.abs(amount),
        });
    }

    const weekKey = entry.weekKey || getMondayWeekKey(entry.occurredAt || new Date());
    if (entry.source === 'divulgacao_grupo' && amount > 0) {
        const earned = await getGroupWeekEarned(db, playerId, event.id, weekKey);
        const limit = Number(event.group_weekly_pr_limit || 0);
        if (earned + amount > limit) {
            throw new PrServiceError(
                'weekly_group_limit_exceeded',
                `O limite semanal de divulgação em grupos é ${limit} PR.`,
                {
                    limit,
                    earned,
                    remaining: Math.max(0, limit - earned),
                    requested: amount,
                    weekKey,
                }
            );
        }
    }

    const ledgerEntry = await insertPrEntry(db, {
        ...entry,
        playerId,
        eventId: event.id,
        amount,
        weekKey,
    });
    return mutationResult(ledgerEntry, balanceBefore, balanceAfter);
}

async function mutatePr(db, playerId, entry) {
    await ensureCloverRecruitmentSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await mutatePrInTransaction(db, playerId, entry);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

function buildEntry(amount, kind, source, reason, createdBy, options = {}) {
    return {
        amount,
        kind,
        source,
        reason,
        createdBy,
        eventKey: options.eventKey || DEFAULT_EVENT_KEY,
        weekKey: options.weekKey || null,
        occurredAt: options.occurredAt || null,
        relatedId: options.relatedId || null,
        idempotencyKey: options.idempotencyKey || null,
        metadata: options.metadata || {},
    };
}

async function addRecruitmentPr(db, playerId, amount, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutatePr(
        db,
        playerId,
        buildEntry(value, 'ganho', 'recrutamento', reason, createdBy, options)
    );
}

async function addRecruitmentPrInTransaction(db, playerId, amount, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutatePrInTransaction(
        db,
        playerId,
        buildEntry(value, 'ganho', 'recrutamento', reason, createdBy, options)
    );
}

async function addGroupPromotionPr(db, playerId, amount, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutatePr(
        db,
        playerId,
        buildEntry(value, 'ganho', 'divulgacao_grupo', reason, createdBy, options)
    );
}

async function spendPr(db, playerId, amount, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutatePr(db, playerId, buildEntry(-value, 'gasto', 'loja', reason, createdBy, options));
}

async function adminAdjustPr(db, playerId, amount, reason, createdBy, options = {}) {
    const value = asInteger(amount, { allowNegative: true });
    const source = options.source || 'ajuste_admin';
    return mutatePr(
        db,
        playerId,
        buildEntry(value, 'ajuste_admin', source, reason, createdBy, options)
    );
}

async function getPrSummary(db, playerId, options = {}) {
    await ensurePlayerExists(db, playerId);
    const event = await getEvent(db, options.eventKey || DEFAULT_EVENT_KEY);
    const weekKey = options.weekKey || getMondayWeekKey(options.at || new Date());
    const balance = await getPrBalance(db, playerId);
    const groupWeekEarned = await getGroupWeekEarned(db, playerId, event.id, weekKey);
    const groupWeekLimit = Number(event.group_weekly_pr_limit || 0);

    return {
        playerId,
        eventKey: event.event_key,
        eventStatus: event.status,
        balance,
        weekKey,
        groupWeekEarned,
        groupWeekLimit,
        groupWeekRemaining: Math.max(0, groupWeekLimit - groupWeekEarned),
        shopEnabled: Boolean(event.shop_enabled),
    };
}

async function getPrHistory(db, playerId, limit = 20) {
    await ensurePlayerExists(db, playerId);
    await ensureCloverRecruitmentSchema(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return db.all(
        `SELECT *
         FROM clover_pr_ledger
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [playerId, safeLimit]
    );
}

module.exports = {
    DEFAULT_EVENT_KEY,
    PrServiceError,
    addGroupPromotionPr,
    addRecruitmentPr,
    addRecruitmentPrInTransaction,
    adminAdjustPr,
    getEvent,
    getMondayWeekKey,
    getPrBalance,
    getPrHistory,
    getPrSummary,
    mutatePrInTransaction,
    spendPr,
};
