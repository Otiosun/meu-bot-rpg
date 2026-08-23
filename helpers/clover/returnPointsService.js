'use strict';

const RETURN_POINTS_LEDGER = 'clover_return_points_ledger';
const ENTRY_KINDS = new Set(['credit', 'debit', 'refund', 'compensation']);

class ReturnPointsServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ReturnPointsServiceError';
        this.code = code;
        this.details = details;
    }
}

function requiredText(value, label, limit = 160) {
    const text = String(value || '').trim();
    if (!text || text.length > limit) {
        throw new ReturnPointsServiceError('invalid_argument', `${label} invalido.`);
    }
    return text;
}

function positiveInteger(value, label = 'amount') {
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new ReturnPointsServiceError('invalid_amount', `${label} precisa ser inteiro positivo.`);
    }
    return amount;
}

function serializeMetadata(value) {
    return JSON.stringify(value && typeof value === 'object' ? value : {});
}

async function assertPlayerExists(db, playerId) {
    const id = requiredText(playerId, 'playerId', 255);
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [id]);
    if (!player) throw new ReturnPointsServiceError('player_not_found', 'Player nao encontrado.');
    return id;
}

async function getReturnPointsBalance(db, playerId) {
    const id = requiredText(playerId, 'playerId', 255);
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS balance FROM ${RETURN_POINTS_LEDGER} WHERE player_id = ?`,
        [id]
    );
    return Number(row?.balance || 0);
}

async function getReturnPointsLedger(db, playerId, limit = 50) {
    const id = requiredText(playerId, 'playerId', 255);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return db.all(
        `SELECT * FROM ${RETURN_POINTS_LEDGER} WHERE player_id = ? ORDER BY id DESC LIMIT ?`,
        [id, safeLimit]
    );
}

function normalizeEntry(entry = {}) {
    const entryKind = requiredText(entry.entryKind, 'entryKind', 32);
    if (!ENTRY_KINDS.has(entryKind)) {
        throw new ReturnPointsServiceError('invalid_entry_kind', 'Tipo de lancamento invalido.');
    }
    const absoluteAmount = positiveInteger(entry.amount);
    const amount = entryKind === 'debit' ? -absoluteAmount : absoluteAmount;
    return {
        amount,
        entryKind,
        operationKey: requiredText(entry.operationKey, 'operationKey'),
        source: requiredText(entry.source, 'source', 80),
        reason: requiredText(entry.reason, 'reason', 500),
        policyVersion: entry.policyVersion ? requiredText(entry.policyVersion, 'policyVersion', 120) : null,
        resetCycleKey: entry.resetCycleKey ? requiredText(entry.resetCycleKey, 'resetCycleKey', 120) : null,
        relatedId: entry.relatedId ? requiredText(entry.relatedId, 'relatedId', 255) : null,
        correlationId: entry.correlationId ? requiredText(entry.correlationId, 'correlationId', 255) : null,
        createdBy: requiredText(entry.createdBy, 'createdBy', 255),
        metadataJson: serializeMetadata(entry.metadata),
    };
}

function sameEntry(existing, playerId, entry) {
    return existing.player_id === playerId
        && Number(existing.amount) === entry.amount
        && existing.entry_kind === entry.entryKind
        && existing.source === entry.source;
}

async function appendReturnPointsInTransaction(db, playerId, rawEntry) {
    const id = await assertPlayerExists(db, playerId);
    const entry = normalizeEntry(rawEntry);
    const existing = await db.get(
        `SELECT * FROM ${RETURN_POINTS_LEDGER} WHERE operation_key = ?`,
        [entry.operationKey]
    );
    if (existing) {
        if (!sameEntry(existing, id, entry)) {
            throw new ReturnPointsServiceError('idempotency_conflict', 'A chave de operacao ja pertence a outro lancamento.');
        }
        return {
            ok: true,
            duplicate: true,
            ledgerId: existing.id,
            balanceBefore: await getReturnPointsBalance(db, id),
            balanceAfter: await getReturnPointsBalance(db, id),
            entry: existing,
        };
    }
    const balanceBefore = await getReturnPointsBalance(db, id);
    if (entry.amount < 0 && balanceBefore < Math.abs(entry.amount)) {
        throw new ReturnPointsServiceError('insufficient_return_points', 'Saldo de Pontos de Retorno insuficiente.', {
            balance: balanceBefore,
            required: Math.abs(entry.amount),
        });
    }
    const result = await db.run(
        `INSERT INTO ${RETURN_POINTS_LEDGER}
         (player_id, amount, entry_kind, operation_key, source, reason,
          policy_version, reset_cycle_key, related_id, correlation_id, created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id, entry.amount, entry.entryKind, entry.operationKey, entry.source, entry.reason,
            entry.policyVersion, entry.resetCycleKey, entry.relatedId, entry.correlationId,
            entry.createdBy, entry.metadataJson,
        ]
    );
    const ledgerId = Number(result.lastID);
    const balanceAfter = balanceBefore + entry.amount;
    return {
        ok: true,
        duplicate: false,
        ledgerId,
        balanceBefore,
        balanceAfter,
        entry: await db.get(`SELECT * FROM ${RETURN_POINTS_LEDGER} WHERE id = ?`, [ledgerId]),
    };
}

async function runReturnPointsMutation(db, playerId, entry) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await appendReturnPointsInTransaction(db, playerId, entry);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function creditReturnPoints(db, playerId, amount, options = {}) {
    return runReturnPointsMutation(db, playerId, {
        ...options,
        amount,
        entryKind: options.entryKind || 'credit',
    });
}

async function debitReturnPoints(db, playerId, amount, options = {}) {
    return runReturnPointsMutation(db, playerId, {
        ...options,
        amount,
        entryKind: 'debit',
    });
}

module.exports = {
    ENTRY_KINDS,
    RETURN_POINTS_LEDGER,
    ReturnPointsServiceError,
    appendReturnPointsInTransaction,
    creditReturnPoints,
    debitReturnPoints,
    getReturnPointsBalance,
    getReturnPointsLedger,
    positiveInteger,
    requiredText,
};
