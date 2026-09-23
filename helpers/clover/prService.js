const { ensureCloverRecruitmentSchema } = require('../../database');
const { extractPhoneNumber, normalizeJid } = require('../groupAccess');
const { equivalentPlayerIds } = require('./playerIdentityEquivalenceService');

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

function filledScore(player) {
    let score = 0;
    if (!player) return score;
    if (Number(player.is_shadow || 0) === 1) score -= 100;
    for (const field of ['personagem_nome', 'nome', 'display_name', 'nome_real', 'raca', 'classe', 'grimorio', 'magia']) {
        const value = String(player[field] || '').trim();
        if (value && value !== '-' && value.toLowerCase() !== 'cacador') score += 5;
    }
    return score;
}

async function ledgerStats(db, tableName, playerId) {
    return db.get(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS balance FROM ${tableName} WHERE player_id = ?`,
        [playerId]
    ).catch(() => ({ entries: 0, balance: 0 }));
}

async function tableExists(db, tableName) {
    return Boolean(await db.get(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    ).catch(() => null));
}

async function collectEquivalentLedgerIds(db, playerId) {
    const ids = new Set();
    const add = (value) => {
        const text = String(value || '').trim();
        if (text) ids.add(text);
    };
    add(playerId);
    for (const id of await equivalentPlayerIds(db, playerId).catch(() => [])) {
        add(id);
    }
    return [...ids];
}

async function getReturnPrStats(db, playerId) {
    if (!await tableExists(db, 'clover_return_points_ledger')) {
        return { entries: 0, balance: 0, playerIds: [playerId].filter(Boolean) };
    }

    const playerIds = await collectEquivalentLedgerIds(db, playerId);
    if (!playerIds.length) return { entries: 0, balance: 0, playerIds };
    const placeholders = playerIds.map(() => '?').join(', ');
    const row = await db.get(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS balance
         FROM clover_return_points_ledger
         WHERE player_id IN (${placeholders})`,
        playerIds
    );
    return {
        entries: Number(row?.entries || 0),
        balance: Number(row?.balance || 0),
        playerIds,
    };
}

async function getReturnPrHistory(db, playerId, limit = 20) {
    const stats = await getReturnPrStats(db, playerId);
    if (!stats.entries || !stats.playerIds.length) return [];
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const placeholders = stats.playerIds.map(() => '?').join(', ');
    return db.all(
        `SELECT
             id,
             player_id,
             amount,
             COALESCE(entry_kind, CASE WHEN amount < 0 THEN 'debit' ELSE 'credit' END) AS kind,
             source,
             reason,
             related_id,
             operation_key AS idempotency_key,
             created_by,
             created_at,
             metadata_json
         FROM clover_return_points_ledger
         WHERE player_id IN (${placeholders})
         ORDER BY id DESC
         LIMIT ?`,
        [...stats.playerIds, safeLimit]
    );
}

async function choosePrPlayerId(db, playerIds) {
    let best = null;
    for (const id of [...new Set(playerIds)].filter(Boolean)) {
        const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [id]).catch(() => null);
        if (!player) continue;
        const prStats = await ledgerStats(db, 'clover_pr_ledger', id);
        const returnStats = await ledgerStats(db, 'clover_return_points_ledger', id);
        const score = (Number(prStats.entries || 0) > 0 ? 100000 + Number(prStats.entries || 0) : 0)
            + (Number(returnStats.entries || 0) > 0 ? 50000 + Number(returnStats.entries || 0) : 0)
            + filledScore(player);
        if (!best || score > best.score) best = { id, score };
    }
    return best?.id || null;
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

async function resolveCanonicalPlayerId(db, playerId) {
    if (!playerId) {
        throw new PrServiceError('missing_player', 'Player invalido.');
    }

    const rawJid = (value) => String(value || '').trim().toLowerCase().replace(/:\d+(?=@)/g, '');
    const starts = new Set();
    const addStart = (value) => {
        const text = String(value || '').trim();
        if (!text) return;
        starts.add(text);
        const raw = rawJid(text);
        if (raw) starts.add(raw);
        const normalized = normalizeJid(raw || text);
        if (normalized) starts.add(normalized);
        const phoneDigits = extractPhoneNumber(raw || text);
        if (phoneDigits && phoneDigits.length >= 8) {
            starts.add(phoneDigits);
            starts.add(`${phoneDigits}@s.whatsapp.net`);
        }
        const digits = (raw || text).replace(/\D/g, '');
        if (digits.length >= 8) {
            starts.add(digits);
            starts.add(`${digits}@s.whatsapp.net`);
            const normalizedPhone = normalizeJid(`${digits}@s.whatsapp.net`);
            if (normalizedPhone) starts.add(normalizedPhone);

            if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
                const brDigits = `55${digits}`;
                starts.add(brDigits);
                starts.add(`${brDigits}@s.whatsapp.net`);
                const normalizedBr = normalizeJid(`${brDigits}@s.whatsapp.net`);
                if (normalizedBr) starts.add(normalizedBr);
            }

            if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
                const localDigits = digits.slice(2);
                starts.add(localDigits);
                starts.add(`${localDigits}@s.whatsapp.net`);
            }
        }
    };

    addStart(playerId);
    for (const equivalent of await equivalentPlayerIds(db, playerId).catch(() => [])) {
        addStart(equivalent);
    }

    const resolved = [];
    for (const startId of starts) {
        const seen = new Set();
        let currentId = startId;
        for (let depth = 0; depth < 12; depth += 1) {
            if (seen.has(currentId)) break;
            seen.add(currentId);
            const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [currentId]);
            if (!player) break;

            const mergedInto = String(player.merged_into || '').trim();
            const canonicalId = String(player.canonical_player_id || '').trim();
            const shadowCanonical = Number(player.is_shadow || 0) === 1 && canonicalId && canonicalId !== player.id;
            const explicitCanonical = canonicalId && canonicalId !== player.id;
            const nextId = mergedInto || (shadowCanonical ? canonicalId : '') || (explicitCanonical ? canonicalId : '');
            if (!nextId || nextId === player.id) {
                resolved.push(player.id);
                break;
            }
            currentId = nextId;
        }
    }

    const selected = await choosePrPlayerId(db, resolved);
    if (selected) return selected;

    throw new PrServiceError('player_not_found', 'Player nao encontrado.');
}

async function getPrBalance(db, playerId) {
    await ensureCloverRecruitmentSchema(db);
    const canonicalPlayerId = await resolveCanonicalPlayerId(db, playerId);
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS balance
         FROM clover_pr_ledger
         WHERE player_id = ?`,
        [canonicalPlayerId]
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
    const canonicalPlayerId = await resolveCanonicalPlayerId(db, playerId);
    await ensurePlayerExists(db, canonicalPlayerId);

    if (!PR_SOURCES.has(entry.source)) {
        throw new PrServiceError('invalid_source', 'Origem de PR inválida.');
    }

    const duplicate = await findIdempotentEntry(db, entry.idempotencyKey);
    if (duplicate) {
        if (duplicate.player_id !== canonicalPlayerId) {
            throw new PrServiceError('idempotency_conflict', 'A chave de idempotência pertence a outro player.');
        }
        const duplicateAfter = await db.get(
            `SELECT COALESCE(SUM(amount), 0) AS balance
             FROM clover_pr_ledger
             WHERE player_id = ? AND id <= ?`,
            [canonicalPlayerId, duplicate.id]
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
    const balanceBefore = await getPrBalance(db, canonicalPlayerId);
    const balanceAfter = balanceBefore + amount;
    if (balanceAfter < 0) {
        throw new PrServiceError('insufficient_pr', 'Saldo de PR insuficiente.', {
            balance: balanceBefore,
            requested: Math.abs(amount),
        });
    }

    const weekKey = entry.weekKey || getMondayWeekKey(entry.occurredAt || new Date());
    if (entry.source === 'divulgacao_grupo' && amount > 0) {
        const earned = await getGroupWeekEarned(db, canonicalPlayerId, event.id, weekKey);
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
        playerId: canonicalPlayerId,
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
    const canonicalPlayerId = await resolveCanonicalPlayerId(db, playerId);
    await ensurePlayerExists(db, canonicalPlayerId);
    const event = await getEvent(db, options.eventKey || DEFAULT_EVENT_KEY);
    const weekKey = options.weekKey || getMondayWeekKey(options.at || new Date());
    const recruitmentBalance = await getPrBalance(db, canonicalPlayerId);
    const returnStats = await getReturnPrStats(db, canonicalPlayerId);
    const usesReturnPoints = returnStats.entries > 0;
    const balance = usesReturnPoints ? returnStats.balance : recruitmentBalance;
    const groupWeekEarned = await getGroupWeekEarned(db, canonicalPlayerId, event.id, weekKey);
    const groupWeekLimit = Number(event.group_weekly_pr_limit || 0);

    return {
        playerId: canonicalPlayerId,
        eventKey: event.event_key,
        eventStatus: event.status,
        balance,
        balanceSource: usesReturnPoints ? 'return_points' : 'recruitment',
        recruitmentBalance,
        returnBalance: returnStats.balance,
        returnEntries: returnStats.entries,
        weekKey,
        groupWeekEarned,
        groupWeekLimit,
        groupWeekRemaining: Math.max(0, groupWeekLimit - groupWeekEarned),
        shopEnabled: Boolean(event.shop_enabled),
    };
}

async function getPrHistory(db, playerId, limit = 20) {
    await ensureCloverRecruitmentSchema(db);
    const canonicalPlayerId = await resolveCanonicalPlayerId(db, playerId);
    await ensurePlayerExists(db, canonicalPlayerId);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const returnHistory = await getReturnPrHistory(db, canonicalPlayerId, safeLimit);
    if (returnHistory.length) return returnHistory;
    return db.all(
        `SELECT *
         FROM clover_pr_ledger
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [canonicalPlayerId, safeLimit]
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
    getReturnPrHistory,
    getReturnPrStats,
    mutatePrInTransaction,
    resolveCanonicalPlayerId,
    spendPr,
};
