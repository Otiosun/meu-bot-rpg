const { ensureCloverYullsLedgerSchema } = require('../../database');

class YullsServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'YullsServiceError';
        this.code = code;
        this.details = details;
    }
}

function asInteger(value, options = {}) {
    const amount = Number(value);
    if (!Number.isInteger(amount) || Number.isNaN(amount) || (!options.allowZero && amount === 0)) {
        throw new YullsServiceError('invalid_amount', 'Quantidade de Yulls inválida.');
    }
    if (!options.allowNegative && amount < 0) {
        throw new YullsServiceError('invalid_amount', 'Quantidade de Yulls precisa ser positiva.');
    }
    return amount;
}

function serializeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return JSON.stringify(metadata);
}

function normalizeOptional(value) {
    const text = String(value || '').trim();
    return text || null;
}

async function getPlayerBalance(db, playerId) {
    if (!playerId) {
        throw new YullsServiceError('missing_player', 'Player inválido.');
    }

    const player = await db.get(
        'SELECT id, COALESCE(dinheiro, 0) AS dinheiro FROM jogadores WHERE id = ?',
        [playerId]
    );
    if (!player) {
        throw new YullsServiceError('player_not_found', 'Player não encontrado.');
    }

    const balance = Number(player.dinheiro || 0);
    if (!Number.isInteger(balance) || balance < 0) {
        throw new YullsServiceError('invalid_current_balance', 'O saldo atual de Yulls é inválido.');
    }

    return balance;
}

async function getLatestLedgerEntry(db, playerId) {
    return db.get(
        `SELECT *
         FROM clover_yulls_ledger
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [playerId]
    );
}

async function insertLedgerEntry(db, entry) {
    const result = await db.run(
        `INSERT INTO clover_yulls_ledger (
            player_id,
            amount,
            balance_before,
            balance_after,
            kind,
            source,
            reason,
            related_id,
            idempotency_key,
            created_by,
            created_at,
            metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            entry.playerId,
            entry.amount,
            entry.balanceBefore,
            entry.balanceAfter,
            entry.kind,
            normalizeOptional(entry.source),
            normalizeOptional(entry.reason),
            normalizeOptional(entry.relatedId),
            normalizeOptional(entry.idempotencyKey),
            normalizeOptional(entry.createdBy),
            serializeMetadata(entry.metadata),
        ]
    );

    return db.get('SELECT * FROM clover_yulls_ledger WHERE id = ?', [result.lastID]);
}

async function ensureYullsStateInTransaction(db, playerId) {
    const currentBalance = await getPlayerBalance(db, playerId);
    const latest = await getLatestLedgerEntry(db, playerId);

    if (!latest) {
        return insertLedgerEntry(db, {
            playerId,
            amount: currentBalance,
            balanceBefore: 0,
            balanceAfter: currentBalance,
            kind: 'saldo_inicial',
            source: 'opening_balance',
            reason: 'Saldo oficial anterior ao ledger de Yulls',
            relatedId: 'opening_balance_v1',
            idempotencyKey: `yulls:opening:${playerId}`,
            createdBy: 'system',
            metadata: { preserved_existing_balance: true, version: 1 },
        });
    }

    const ledgerBalance = Number(latest.balance_after || 0);
    if (ledgerBalance === currentBalance) return latest;

    return insertLedgerEntry(db, {
        playerId,
        amount: currentBalance - ledgerBalance,
        balanceBefore: ledgerBalance,
        balanceAfter: currentBalance,
        kind: 'sincronizacao_legada',
        source: 'legacy_direct_sync',
        reason: 'Alteração legada detectada fora do serviço de Yulls',
        relatedId: null,
        idempotencyKey: null,
        createdBy: 'system',
        metadata: { detected_balance: currentBalance, previous_ledger_balance: ledgerBalance },
    });
}

async function ensureYullsState(db, playerId) {
    await ensureCloverYullsLedgerSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const entry = await ensureYullsStateInTransaction(db, playerId);
        await db.exec('COMMIT');
        return entry;
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function findIdempotentEntry(db, idempotencyKey) {
    const key = normalizeOptional(idempotencyKey);
    if (!key) return null;
    return db.get('SELECT * FROM clover_yulls_ledger WHERE idempotency_key = ?', [key]);
}

function mutationResult(entry, duplicate = false) {
    return {
        ok: true,
        duplicate,
        ledgerId: entry.id,
        playerId: entry.player_id,
        amount: Number(entry.amount),
        kind: entry.kind,
        source: entry.source,
        balanceBefore: Number(entry.balance_before),
        balanceAfter: Number(entry.balance_after),
    };
}

async function mutateYullsInTransaction(db, playerId, entry) {
    await ensureCloverYullsLedgerSchema(db);
    const duplicate = await findIdempotentEntry(db, entry.idempotencyKey);
    if (duplicate) {
        if (duplicate.player_id !== playerId) {
            throw new YullsServiceError('idempotency_conflict', 'A chave de idempotência pertence a outro player.');
        }
        return mutationResult(duplicate, true);
    }

    await ensureYullsStateInTransaction(db, playerId);
    const balanceBefore = await getPlayerBalance(db, playerId);
    const amount = asInteger(entry.amount, { allowNegative: true });
    const balanceAfter = balanceBefore + amount;
    if (balanceAfter < 0) {
        throw new YullsServiceError('insufficient_yulls', 'Saldo de Yulls insuficiente.', {
            balance: balanceBefore,
            requested: Math.abs(amount),
        });
    }

    await db.run('UPDATE jogadores SET dinheiro = ? WHERE id = ?', [balanceAfter, playerId]);
    const ledgerEntry = await insertLedgerEntry(db, {
        ...entry,
        playerId,
        amount,
        balanceBefore,
        balanceAfter,
    });
    return mutationResult(ledgerEntry);
}

async function mutateYulls(db, playerId, entry) {
    await ensureCloverYullsLedgerSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await mutateYullsInTransaction(db, playerId, entry);
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
        relatedId: options.relatedId || null,
        idempotencyKey: options.idempotencyKey || null,
        metadata: options.metadata || {},
    };
}

async function addYulls(db, playerId, amount, source, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutateYulls(db, playerId, buildEntry(value, 'ganho', source, reason, createdBy, options));
}

async function addYullsInTransaction(db, playerId, amount, source, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutateYullsInTransaction(
        db,
        playerId,
        buildEntry(value, 'ganho', source, reason, createdBy, options)
    );
}

async function spendYulls(db, playerId, amount, source, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutateYulls(db, playerId, buildEntry(-value, 'gasto', source, reason, createdBy, options));
}

async function spendYullsInTransaction(db, playerId, amount, source, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutateYullsInTransaction(
        db,
        playerId,
        buildEntry(-value, 'gasto', source, reason, createdBy, options)
    );
}

async function adminAdjustYulls(db, playerId, amount, reason, createdBy, options = {}) {
    const value = asInteger(amount, { allowNegative: true });
    return mutateYulls(
        db,
        playerId,
        buildEntry(value, 'ajuste_admin', options.source || 'comando_admin', reason, createdBy, options)
    );
}

async function getYullsSummary(db, playerId) {
    await ensureYullsState(db, playerId);
    const balance = await getPlayerBalance(db, playerId);
    const totals = await db.get(
        `SELECT
            COUNT(*) AS entries,
            COALESCE(SUM(CASE WHEN amount > 0 AND kind != 'saldo_inicial' THEN amount ELSE 0 END), 0) AS total_in,
            COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS total_out
         FROM clover_yulls_ledger
         WHERE player_id = ?`,
        [playerId]
    );

    return {
        playerId,
        balance,
        entries: Number(totals.entries || 0),
        totalIn: Number(totals.total_in || 0),
        totalOut: Number(totals.total_out || 0),
    };
}

async function getYullsHistory(db, playerId, limit = 20) {
    await ensureYullsState(db, playerId);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return db.all(
        `SELECT *
         FROM clover_yulls_ledger
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [playerId, safeLimit]
    );
}

module.exports = {
    YullsServiceError,
    addYulls,
    addYullsInTransaction,
    adminAdjustYulls,
    ensureYullsState,
    ensureYullsStateInTransaction,
    getYullsHistory,
    getYullsSummary,
    mutateYullsInTransaction,
    spendYulls,
    spendYullsInTransaction,
};
