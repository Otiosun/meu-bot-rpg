'use strict';

class PaServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message || code);
        this.name = 'PaServiceError';
        this.code = code;
        this.details = details;
    }
}

function asInteger(value, options = {}) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount === 0) {
        throw new PaServiceError('invalid_pa_amount', 'A quantidade de PA precisa ser um número inteiro diferente de zero.');
    }
    if (!options.allowNegative && amount < 0) {
        throw new PaServiceError('invalid_pa_amount', 'A quantidade de PA precisa ser positiva.');
    }
    return amount;
}

function optionalText(value) {
    const text = String(value || '').trim();
    return text || null;
}

async function ensurePaSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pa_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount != 0),
            balance_before INTEGER NOT NULL CHECK (balance_before >= 0),
            balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
            kind TEXT NOT NULL CHECK (kind IN ('ganho', 'gasto', 'perda', 'ajuste_admin', 'estorno')),
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            CHECK (balance_after = balance_before + amount)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pa_player_created
        ON clover_pa_ledger (player_id, created_at DESC, id DESC)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pa_source_related
        ON clover_pa_ledger (source, related_id)
    `);
}

async function ensurePlayerExists(db, playerId) {
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new PaServiceError('player_not_found', 'Player não encontrado.');
}

async function getPaBalance(db, playerId) {
    await ensurePaSchema(db);
    const row = await db.get(
        'SELECT COALESCE(SUM(amount), 0) AS balance FROM clover_pa_ledger WHERE player_id = ?',
        [playerId]
    );
    return Number(row?.balance || 0);
}

async function findIdempotentEntry(db, idempotencyKey) {
    const key = optionalText(idempotencyKey);
    if (!key) return null;
    return db.get('SELECT * FROM clover_pa_ledger WHERE idempotency_key = ?', [key]);
}

function mutationResult(row, duplicate = false) {
    return {
        ok: true,
        duplicate,
        ledgerId: Number(row.id),
        playerId: row.player_id,
        amount: Number(row.amount),
        balanceBefore: Number(row.balance_before),
        balanceAfter: Number(row.balance_after),
        kind: row.kind,
        source: row.source || null,
        relatedId: row.related_id || null,
    };
}

async function mutatePaInTransaction(db, playerId, input = {}) {
    await ensurePaSchema(db);
    await ensurePlayerExists(db, playerId);

    const amount = asInteger(input.amount, { allowNegative: true });
    const idempotencyKey = optionalText(input.idempotencyKey);
    const duplicate = await findIdempotentEntry(db, idempotencyKey);
    if (duplicate) {
        if (duplicate.player_id !== playerId || Number(duplicate.amount) !== amount) {
            throw new PaServiceError('pa_idempotency_conflict', 'A identificação desta alteração de PA pertence a outra entrega.');
        }
        return mutationResult(duplicate, true);
    }

    const balanceBefore = await getPaBalance(db, playerId);
    const balanceAfter = balanceBefore + amount;
    if (balanceAfter < 0) {
        throw new PaServiceError('insufficient_pa', 'O ajuste deixaria o saldo de PA negativo.', {
            balance: balanceBefore,
            amount,
        });
    }

    const kind = String(input.kind || (amount > 0 ? 'ganho' : 'perda')).trim();
    const allowedKinds = new Set(['ganho', 'gasto', 'perda', 'ajuste_admin', 'estorno']);
    if (!allowedKinds.has(kind)) throw new PaServiceError('invalid_pa_kind', 'Tipo de lançamento de PA inválido.');

    const inserted = await db.run(
        `INSERT INTO clover_pa_ledger
         (player_id, amount, balance_before, balance_after, kind, source, reason,
          related_id, idempotency_key, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            playerId,
            amount,
            balanceBefore,
            balanceAfter,
            kind,
            optionalText(input.source),
            optionalText(input.reason),
            optionalText(input.relatedId),
            idempotencyKey,
            optionalText(input.createdBy),
            input.metadata && typeof input.metadata === 'object'
                ? JSON.stringify(input.metadata)
                : null,
        ]
    );
    const row = await db.get('SELECT * FROM clover_pa_ledger WHERE id = ?', [inserted.lastID]);
    return mutationResult(row, false);
}

async function addPaInTransaction(db, playerId, amount, source, reason, createdBy, options = {}) {
    const value = asInteger(amount);
    return mutatePaInTransaction(db, playerId, {
        amount: value,
        kind: options.kind || 'ganho',
        source,
        reason,
        createdBy,
        relatedId: options.relatedId,
        idempotencyKey: options.idempotencyKey,
        metadata: options.metadata,
    });
}

async function mutatePa(db, playerId, input = {}) {
    await ensurePaSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await mutatePaInTransaction(db, playerId, input);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getPaSummary(db, playerId) {
    await ensurePlayerExists(db, playerId);
    return {
        playerId,
        balance: await getPaBalance(db, playerId),
    };
}

async function getPaHistory(db, playerId, limit = 20) {
    await ensurePlayerExists(db, playerId);
    await ensurePaSchema(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return db.all(
        `SELECT * FROM clover_pa_ledger
         WHERE player_id = ?
         ORDER BY id DESC LIMIT ?`,
        [playerId, safeLimit]
    );
}

module.exports = {
    PaServiceError,
    addPaInTransaction,
    ensurePaSchema,
    getPaBalance,
    getPaHistory,
    getPaSummary,
    mutatePa,
    mutatePaInTransaction,
};
